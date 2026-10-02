/**
 * Codex InstallPlan — Multi-Host Core Design §10 우선순위 3
 *
 * `~/.codex/hooks.json` 에 forgen hook 등록(절대경로, idempotent), `~/.codex/config.toml`
 * 에 forgen-compound MCP 등록(managed marker block). $CODEX_HOME 환경변수 존중.
 *
 * 동작 원칙:
 * - hook 등록은 generateHooksJson({runtime:'codex', pluginRoot, releaseMode}) 결과를 그대로 사용
 *   — 이미 codex-adapter wrapper + 절대경로 적용됨 (spec §18.5 결정 옵션 1).
 * - 사용자가 직접 작성한 비-forgen hook 은 보존 (`isForgenHookEntry` pattern).
 * - MCP 등록은 TOML 라이브러리 없이 marker block 으로 idempotent 관리.
 * - dryRun 시 파일을 쓰지 않고 결과만 반환 (테스트 + preview 용).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateHooksJson } from '../hooks/hooks-generator.js';

export interface CodexInstallOptions {
  /** forgen package root (build 산출물 dist/ 의 부모). 기본: 호출 시 process.cwd(). */
  pkgRoot: string;
  /** codex home (default: $CODEX_HOME ?? ~/.codex). */
  codexHome?: string;
  /** dry-run: 파일 미작성, 결과만 반환. */
  dryRun?: boolean;
  /** MCP 서버 등록 여부 (default true). */
  registerMcp?: boolean;
  /** hooks-generator releaseMode (default true: 환경 독립). */
  releaseMode?: boolean;
  /** AGENTS.md 위치 override (default: pkgRoot 기준 자동 resolve). 격리 테스트용. */
  agentsMdPath?: string;
  /** ADR-016 D1: config.toml 에 forgen notify 폴백 등록 여부 (default true). */
  registerNotify?: boolean;
}

/** ADR-016 D1 — config.toml `notify` 등록 결과. */
export type CodexNotifyStatus =
  /** forgen 블록을 새로 썼거나 갱신함 */
  | 'installed'
  /** 이미 동일한 forgen 블록이 있음 */
  | 'already-present'
  /** 사용자가 직접 정의한 `notify` 가 있어 건드리지 않음 (단일 argv 라 병합 불가) */
  | 'user-defined'
  /** --no-notify */
  | 'skipped';

export interface CodexInstallResult {
  codexHome: string;
  hooksPath: string;
  hooksWritten: boolean;
  hooksCount: number;
  preservedUserHookCount: number;
  configTomlPath: string;
  mcpRegistered: boolean;
  mcpAlreadyPresent: boolean;
  /** P3-3 (US-013): Codex skills/ 에 install 된 forgen 명령 수 */
  skillsInstalled: number;
  skillsPath: string;
  /** P3-3: AGENTS.md (cwd) 에 forgen rule block 인젝션 여부 */
  agentsMdPath: string;
  agentsMdInjected: boolean;
  /** v0.4.9: dev-guide skills (~/.codex/skills) 설치 결과 */
  devGuideSkillsPath: string;
  devGuideSkillsInstalled: number;
  devGuideSkillsRemoved: number;
  /** ADR-014 D2: ~/.codex/agents/ch-*.toml 커스텀 에이전트 설치 결과 */
  agentsPath: string;
  agentsInstalled: number;
  agentsRemoved: number;
  /** ADR-014 D4: hooks.json forgen 엔트리 중 config.toml hooks.state 에 신뢰 기록이 있는 수 */
  hookTrust: CodexHookTrustAudit;
  /** ADR-014 D2: config.toml `[features] multi_agent = true` 여부 (false 면 ch-* 에이전트 spawn 불가 → 안내) */
  multiAgentEnabled: boolean;
  /** ADR-016 D1: config.toml `notify` 폴백 등록 결과 */
  notify: CodexNotifyStatus;
}

export interface CodexHookTrustAudit {
  /** hooks.json 의 forgen hook 명령 수 (Codex 가 지원하는 이벤트만) */
  total: number;
  /** Codex 가 모르는 이벤트라 조용히 무시되는 forgen 엔트리 (`<event>:<i>:<j>`) — trust 대상이 아님 */
  ignoredByCodex: string[];
  /** trusted_hash 기록이 있고 현재 핸들러의 해시와 일치하는 수 (Codex 가 실제로 실행하는 훅) */
  trusted: number;
  /** 신뢰 기록이 없는 hook 키 (`<event>:<i>:<j>`) */
  untrusted: string[];
  /**
   * ADR-016 D2: 신뢰 기록은 있으나 핸들러가 바뀌어 해시가 어긋난 hook 키. Codex 는 `/hooks` 재승인
   * 전까지 이 훅도 skip 한다 (이전엔 키 존재만 봐서 "trusted" 로 오표시).
   */
  modified: string[];
  /** config.toml 자체가 없거나 hooks.state 가 전혀 없으면 true (Codex 가 아직 한 번도 훅을 review 안 함) */
  noStateRecorded: boolean;
}

const MCP_MARKER_BEGIN = '# >>> forgen-managed-mcp';
const MCP_MARKER_END = '# <<< forgen-managed-mcp';
const NOTIFY_MARKER_BEGIN = '# >>> forgen-managed-notify';
const NOTIFY_MARKER_END = '# <<< forgen-managed-notify';
const FORGEN_SKILL_MARKER = '<!-- forgen-managed -->';
const AGENTS_MD_BEGIN = '<!-- >>> forgen-managed-rules -->';
const AGENTS_MD_END = '<!-- <<< forgen-managed-rules -->';

function resolveCodexHome(opts: CodexInstallOptions): string {
  return opts.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

// 0.4.6 fix — pkgRoot match 외에 script-marker fallback 추가.
// Stale install path (예: 다른 머신에서 install 한 hooks.json 마운트, 또는
// node_modules path 변경) 의 forgen entry 를 "user entry" 로 오분류 → 중복 누적
// 하던 버그. forgen hook 의 시그니처는 dist/host/codex-adapter.js 또는
// dist/hooks/<name>.js — 사용자 custom hook 과 충돌 가능성 거의 없음.
const FORGEN_HOOK_SCRIPT_MARKER = /\bdist\/(host\/codex-adapter|hooks\/[a-z][a-z0-9-]+)\.js\b/;

function isForgenManagedHook(entry: unknown, pkgRoot: string): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as { hooks?: Array<{ command?: string }> };
  if (!Array.isArray(e.hooks)) return false;
  return e.hooks.some(
    (h) => typeof h.command === 'string' && (
      h.command.includes(pkgRoot) || FORGEN_HOOK_SCRIPT_MARKER.test(h.command)
    ),
  );
}

function readJsonFile<T>(p: string): T | null {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function buildMcpBlock(pkgRoot: string): string {
  // forgen-mcp 는 dist/mcp/server.js. node 경로는 PATH 기반.
  // `--host=codex` 인자는 server.ts 가 process.env.FORGEN_HOST 로 set 하여
  // correction-record evidence 박제 시 host:"codex" 로 정확히 태깅되게 한다 (spec §10-5).
  const serverPath = path.join(pkgRoot, 'dist', 'mcp', 'server.js');
  return [
    MCP_MARKER_BEGIN,
    '[mcp_servers.forgen-compound]',
    'command = "node"',
    `args = [${JSON.stringify(serverPath)}, "--host=codex"]`,
    MCP_MARKER_END,
  ].join('\n');
}

function upsertMcpBlock(currentToml: string, pkgRoot: string): { content: string; alreadyPresent: boolean } {
  const block = buildMcpBlock(pkgRoot);
  // marker block 이 있으면 그 사이를 새 block 으로 교체
  const reMarker = new RegExp(
    `${MCP_MARKER_BEGIN}[\\s\\S]*?${MCP_MARKER_END}`,
    'g',
  );
  if (reMarker.test(currentToml)) {
    const replaced = currentToml.replace(reMarker, block);
    return { content: replaced, alreadyPresent: replaced === currentToml };
  }
  // 없으면 끝에 append
  const trimmed = currentToml.replace(/\s+$/, '');
  const sep = trimmed.length > 0 ? '\n\n' : '';
  return { content: `${trimmed}${sep}${block}\n`, alreadyPresent: false };
}

// ── ADR-016 D1: notify 폴백 (config.toml top-level `notify`) ───────────

/** forgen notify 바이너리 argv 접두 (`--` 뒤는 사용자가 수동으로 붙인 체인 프로그램). */
function forgenNotifyArgv(pkgRoot: string): string[] {
  return ['node', path.join(pkgRoot, 'dist', 'host', 'codex-notify.js')];
}

/**
 * config.toml 에 forgen notify 블록을 upsert.
 *
 * - Codex 의 `notify` 는 top-level 단일 argv 다. 사용자가 이미 정의했으면 **건드리지 않는다** — 그리고
 *   forgen 블록이 남아 있으면 제거한다 (중복 키 = config.toml 파싱 실패 → Codex 기동 불가).
 * - top-level 키는 첫 테이블 헤더 앞에 와야 하므로 블록은 항상 파일 최상단에 둔다.
 * - 사용자가 forgen 블록의 argv 뒤에 `"--", "<prog>", …` 로 자기 notifier 를 체인해 뒀으면 그 꼬리를 보존.
 */
export function upsertNotifyBlock(currentToml: string, pkgRoot: string): { content: string; status: CodexNotifyStatus } {
  const blockRe = new RegExp(`${NOTIFY_MARKER_BEGIN}[\\s\\S]*?${NOTIFY_MARKER_END}\\n?`);
  const existingBlock = currentToml.match(blockRe)?.[0] ?? null;
  const withoutBlock = existingBlock ? currentToml.replace(blockRe, '') : currentToml;

  // 보수적 판정: 블록 밖 어디든 `notify =` 줄이 있으면 사용자 정의로 본다 (프로필 테이블 안이어도 skip —
  // 폴백을 못 넣는 쪽이 config 를 깨뜨리는 쪽보다 낫다).
  if (/^[ \t]*notify[ \t]*=/m.test(withoutBlock)) {
    return { content: withoutBlock, status: 'user-defined' };
  }

  let chainTail: string[] = [];
  if (existingBlock) {
    const line = existingBlock.match(/^notify[ \t]*=[ \t]*(\[.*\])[ \t]*$/m)?.[1];
    try {
      const argv = line ? (JSON.parse(line) as unknown) : null;
      if (Array.isArray(argv) && argv.every((a) => typeof a === 'string')) {
        const sep = argv.indexOf('--');
        if (sep !== -1) chainTail = argv.slice(sep) as string[];
      }
    } catch { /* 사용자가 JSON 비호환으로 고친 줄 — 체인 보존 불가, 기본 argv 로 재작성 */ }
  }

  const argv = [...forgenNotifyArgv(pkgRoot), ...chainTail];
  const block = [
    NOTIFY_MARKER_BEGIN,
    '# forgen turn-complete fallback (ADR-016): works even while forgen hooks are untrusted.',
    '# To chain your own notifier, append:  "--", "<program>", "<args…>"  (kept across re-install).',
    `notify = ${JSON.stringify(argv)}`,
    NOTIFY_MARKER_END,
    '',
  ].join('\n');

  const rest = withoutBlock.replace(/^\n+/, '');
  const content = rest.length > 0 ? `${block}\n${rest}` : block;
  return { content, status: content === currentToml ? 'already-present' : 'installed' };
}

interface HooksFile {
  description?: string;
  hooks: Record<string, Array<unknown>>;
}

export function planCodexInstall(opts: CodexInstallOptions): CodexInstallResult {
  const codexHome = resolveCodexHome(opts);
  const hooksPath = path.join(codexHome, 'hooks.json');
  const configTomlPath = path.join(codexHome, 'config.toml');
  const releaseMode = opts.releaseMode ?? true;

  // 1) forgen 측 hook (codex-adapter wrap + 절대경로) 생성
  const generated = generateHooksJson({
    pluginRoot: path.join(opts.pkgRoot, 'dist'),
    runtime: 'codex',
    releaseMode,
  });
  const generatedHooks = generated.hooks as Record<string, unknown[]>;

  // 2) 기존 hooks.json 읽기 — forgen 그룹은 *제자리에서* 교체, 사용자 그룹은 위치 그대로 보존.
  //    (0.5.3 critic/실머신: 이전엔 사용자 그룹을 앞으로 모으고 forgen 을 뒤에 붙여 그룹 인덱스가
  //    바뀌었고, Codex 의 trust 키 `<event>:<groupIdx>:<hookIdx>` 가 어긋나 20/21 → 12/21 로
  //    훅 신뢰가 깨졌다. 바이트 동일성이 곧 신뢰 보존이다.)
  const existing = readJsonFile<HooksFile>(hooksPath);
  const existingHooksByEvent = (existing?.hooks ?? {}) as Record<string, unknown[]>;
  const eventOrder = [...new Set([...Object.keys(existingHooksByEvent), ...Object.keys(generatedHooks)])];
  const merged: Record<string, unknown[]> = {};
  let preservedCount = 0;
  let forgenCount = 0;
  for (const event of eventOrder) {
    const existingGroups = Array.isArray(existingHooksByEvent[event]) ? existingHooksByEvent[event] : [];
    const generatedGroups = generatedHooks[event] ?? [];
    const out: unknown[] = [];
    let inserted = false;
    for (const group of existingGroups) {
      if (isForgenManagedHook(group, opts.pkgRoot)) {
        if (!inserted) { out.push(...generatedGroups); inserted = true; }
        // 이후 중복 forgen 그룹은 드롭 (stale 누적 방지)
      } else {
        out.push(group);
        preservedCount += 1;
      }
    }
    if (!inserted && generatedGroups.length > 0) out.push(...generatedGroups);
    if (out.length > 0) merged[event] = out;
    for (const group of generatedGroups) {
      const g = group as { hooks?: unknown[] };
      if (Array.isArray(g.hooks)) forgenCount += g.hooks.length;
    }
  }

  const finalHooksFile: HooksFile = {
    description: 'forgen Codex hooks (managed; user-authored entries preserved)',
    hooks: merged,
  };

  // 4) MCP 등록
  const registerMcp = opts.registerMcp ?? true;
  let mcpAlreadyPresent = false;
  let mcpRegistered = false;
  const currentToml = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf-8') : '';
  let configToml = currentToml;

  if (registerMcp) {
    const { content, alreadyPresent } = upsertMcpBlock(configToml, opts.pkgRoot);
    mcpAlreadyPresent = alreadyPresent;
    mcpRegistered = !alreadyPresent;
    configToml = content;
  }

  // 4b) ADR-016 D1: notify 폴백 (사용자 notify 가 있으면 보존)
  let notify: CodexNotifyStatus = 'skipped';
  if (opts.registerNotify ?? true) {
    const r = upsertNotifyBlock(configToml, opts.pkgRoot);
    notify = r.status;
    configToml = r.content;
  }
  const configTomlToWrite: string | null = configToml !== currentToml ? configToml : null;

  // 5) 실제 쓰기 (dryRun 이면 skip) — hooks.json + config.toml
  if (!opts.dryRun) {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(hooksPath, `${JSON.stringify(finalHooksFile, null, 2)}\n`, 'utf-8');
    if (configTomlToWrite !== null) {
      fs.writeFileSync(configTomlPath, configTomlToWrite, 'utf-8');
    }
  }

  // 6) P3-3 (US-013): Codex skills/ 에 forgen 10 commands install
  //    Codex 의 skills 메커니즘 (codex-rs/core-skills) 구조: <skill-name>/SKILL.md
  //    + frontmatter (name + description). forgen-managed marker 로 idempotent.
  const skillsPath = path.join(codexHome, 'skills');
  const sourceCommandsDir = path.join(opts.pkgRoot, 'assets', 'claude', 'commands');
  const skillsResult = installCodexSkills({ sourceDir: sourceCommandsDir, targetDir: skillsPath, dryRun: opts.dryRun ?? false });

  // 7) P3-3 (US-013): cwd/AGENTS.md 에 forgen rules block 인젝션 (managed marker)
  //    Codex 가 AGENTS.md 를 자동 read (codex-rs/core/src/agents_md.rs 검증).
  //    pkgRoot 의 git repo root 의 AGENTS.md, 또는 explicit override.
  const agentsMdPath = opts.agentsMdPath ?? resolveAgentsMdPath(opts.pkgRoot);
  const agentsResult = upsertForgenRulesInAgentsMd({ agentsMdPath, pkgRoot: opts.pkgRoot, dryRun: opts.dryRun ?? false });

  // 8) v0.4.9: dev-guide skills → ~/.codex/skills/forgen-<stack>-<skill>/SKILL.md
  const devGuideResult = installDevGuideSkillsToCodex({
    pkgRoot: opts.pkgRoot,
    codexHome,
    dryRun: opts.dryRun ?? false,
  });

  // 9) ADR-014 D2: assets/claude/agents/*.md → ~/.codex/agents/ch-<name>.toml
  const codexAgents = installCodexAgents({
    sourceDir: path.join(opts.pkgRoot, 'assets', 'claude', 'agents'),
    targetDir: path.join(codexHome, 'agents'),
    dryRun: opts.dryRun ?? false,
  });

  // 10) ADR-014 D4: 훅 신뢰 감사 (dryRun 이면 현재 디스크 상태 기준)
  const hookTrust = auditCodexHookTrust({
    hooksPath,
    configTomlPath,
    pkgRoot: opts.pkgRoot,
    hooksFile: opts.dryRun ? (existing ?? finalHooksFile) : finalHooksFile,
    configToml: opts.dryRun ? currentToml : configToml,
  });

  const multiAgentEnabled = isCodexMultiAgentEnabled(configToml);

  return {
    codexHome,
    hooksPath,
    hooksWritten: !opts.dryRun,
    hooksCount: forgenCount,
    preservedUserHookCount: preservedCount,
    configTomlPath,
    mcpRegistered,
    mcpAlreadyPresent,
    skillsInstalled: skillsResult.installed,
    skillsPath,
    agentsMdPath,
    agentsMdInjected: agentsResult.injected,
    devGuideSkillsPath: devGuideResult.devGuideSkillsPath,
    devGuideSkillsInstalled: devGuideResult.devGuideSkillsInstalled,
    devGuideSkillsRemoved: devGuideResult.devGuideSkillsRemoved,
    agentsPath: codexAgents.agentsPath,
    agentsInstalled: codexAgents.installed,
    agentsRemoved: codexAgents.removed,
    hookTrust,
    multiAgentEnabled,
    notify,
  };
}

/** `[features]` 섹션 안에 `multi_agent = true` 가 있는지 (TOML 라이브러리 없이 섹션 범위만 본다). */
export function isCodexMultiAgentEnabled(configToml: string): boolean {
  const m = configToml.match(/^\[features\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m);
  if (!m) return false;
  return /^\s*multi_agent\s*=\s*true\s*$/m.test(m[1]);
}

// ── ADR-014 D4: Codex hook trust audit ────────────────────────────────

/**
 * Codex 0.153 hooks 공식 이벤트 12종 (learn.chatgpt.com/docs/hooks + binary 문자열). 이 밖의 이벤트
 * (예: Claude 전용 PostToolUseFailure) 는 Codex 가 조용히 무시하므로 trust 대상이 아니다.
 */
export const CODEX_SUPPORTED_HOOK_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'UserPromptSubmit',
  'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt', 'SessionStart', 'SessionEnd',
]);

/** Codex 는 hooks.state 키에 이벤트명을 snake_case 로 쓴다 (PreToolUse → pre_tool_use). */
export function codexHookEventKey(event: string): string {
  return event.replace(/(?<!^)([A-Z])/g, '_$1').toLowerCase();
}

/** `additionalContextLimit` 을 인정하는 이벤트 (codex-rs/hooks/src/engine/discovery.rs). */
const CODEX_CONTEXT_LIMIT_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse', 'PostToolUse', 'SessionStart', 'UserPromptSubmit', 'SubagentStart',
]);
/** matcher 를 해시에서 제외하는 이벤트 (Codex 가 matcher 를 무시). */
const CODEX_NO_MATCHER_EVENTS: ReadonlySet<string> = new Set(['UserPromptSubmit', 'Stop', 'Interrupt']);
const CODEX_DEFAULT_CONTEXT_LIMIT = 2500;

/** 키 정렬 + compact JSON (codex-rs/config/src/fingerprint.rs `canonical_json`). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * ADR-016 D2 — Codex 0.153.4 의 hook trust 해시 재현 (`hook_hash`, discovery.rs).
 *
 * 해시는 *핸들러 단위*: `{event_name, matcher?, hooks:[정규화된 핸들러 1개]}` 의 canonical JSON sha256.
 * 정규화: timeout 은 기본값/clamp 적용 후 항상 포함, async 항상 포함, statusMessage 는 있을 때만,
 * additionalContextLimit 은 허용 이벤트에서 기본값(2500)이 아닐 때만. 파일 경로·인덱스·미지 필드는 불포함.
 * `type:"command"` 가 아니면 null (forgen 은 command 훅만 쓴다).
 */
export function codexHookTrustHash(
  event: string,
  matcher: unknown,
  handler: { type?: unknown; command?: unknown; timeout?: unknown; async?: unknown; statusMessage?: unknown; additionalContextLimit?: unknown },
): string | null {
  if (handler.type !== 'command' || typeof handler.command !== 'string') return null;
  const rawTimeout = typeof handler.timeout === 'number' ? handler.timeout : undefined;
  const timeout = event === 'SessionEnd' || event === 'Interrupt'
    ? Math.min(3, Math.max(1, rawTimeout ?? 1))
    : Math.max(1, rawTimeout ?? 600);
  const normalized: Record<string, unknown> = {
    type: 'command',
    command: handler.command,
    timeout,
    async: handler.async === true && event !== 'SessionEnd',
  };
  if (typeof handler.statusMessage === 'string') normalized.statusMessage = handler.statusMessage;
  if (
    typeof handler.additionalContextLimit === 'number' &&
    CODEX_CONTEXT_LIMIT_EVENTS.has(event) &&
    handler.additionalContextLimit !== CODEX_DEFAULT_CONTEXT_LIMIT
  ) {
    normalized.additionalContextLimit = handler.additionalContextLimit;
  }
  const identity: Record<string, unknown> = { event_name: codexHookEventKey(event), hooks: [normalized] };
  if (!CODEX_NO_MATCHER_EVENTS.has(event) && typeof matcher === 'string') identity.matcher = matcher;
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(identity)).digest('hex')}`;
}

/** config.toml 의 `[hooks.state."<key>"]` 섹션 → trusted_hash (없으면 null). */
function parseCodexHookState(toml: string): Map<string, string | null> {
  const state = new Map<string, string | null>();
  const lines = toml.split('\n');
  let current: string | null = null;
  for (const line of lines) {
    const header = line.match(/^\[hooks\.state\."([^"]+)"\]\s*$/);
    if (header) { current = header[1]; state.set(current, null); continue; }
    if (/^\s*\[/.test(line)) { current = null; continue; }
    if (current === null) continue;
    const hash = line.match(/^\s*trusted_hash\s*=\s*"([^"]*)"/);
    if (hash) state.set(current, hash[1]);
  }
  return state;
}

/**
 * hooks.json 의 forgen 엔트리 각각을 config.toml 의
 * `[hooks.state."<hooksPath>:<event>:<groupIdx>:<hookIdx>"] trusted_hash` 와 대조한다 (ADR-014 D4).
 *
 * ADR-016 D2: 이전엔 *기록 유무* 만 봤다 — 그래서 핸들러가 바뀌어 Codex 가 `modified` 로 skip 하는 훅을
 * "trusted" 로 오표시했다. 이제 Codex 와 같은 해시를 계산해 trusted / modified / untrusted 를 구분한다.
 * 읽기 전용 대조이며 trusted_hash 를 쓰지 않는다 — Codex 의 review 정책을 우회하지 않는다.
 */
export function auditCodexHookTrust(opts: {
  hooksPath: string;
  configTomlPath: string;
  pkgRoot: string;
  hooksFile?: HooksFile | null;
  configToml?: string;
}): CodexHookTrustAudit {
  const hooksFile = opts.hooksFile ?? readJsonFile<HooksFile>(opts.hooksPath);
  const toml = opts.configToml ?? (fs.existsSync(opts.configTomlPath) ? fs.readFileSync(opts.configTomlPath, 'utf-8') : '');
  const state = parseCodexHookState(toml);

  let total = 0;
  let trusted = 0;
  const untrusted: string[] = [];
  const modified: string[] = [];
  const ignoredByCodex: string[] = [];
  const events = (hooksFile?.hooks ?? {}) as Record<string, unknown[]>;
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, gi) => {
      const g = group as { matcher?: unknown; hooks?: Array<Record<string, unknown>> };
      if (!Array.isArray(g.hooks)) return;
      g.hooks.forEach((h, hi) => {
        const isForgen = typeof h.command === 'string' &&
          (h.command.includes(opts.pkgRoot) || FORGEN_HOOK_SCRIPT_MARKER.test(h.command));
        if (!isForgen) return;
        const key = `${codexHookEventKey(event)}:${gi}:${hi}`;
        if (!CODEX_SUPPORTED_HOOK_EVENTS.has(event)) { ignoredByCodex.push(key); return; }
        total += 1;
        const recorded = state.get(`${opts.hooksPath}:${key}`);
        if (recorded === undefined || recorded === null) { untrusted.push(key); return; }
        if (recorded === codexHookTrustHash(event, g.matcher, h)) trusted += 1;
        else modified.push(key);
      });
    });
  }
  return { total, trusted, untrusted, modified, ignoredByCodex, noStateRecorded: state.size === 0 };
}

// ── ADR-014 D2: Codex custom agents (~/.codex/agents/ch-*.toml) ──────

const AGENT_TOML_MARKER = '# forgen-managed';
const AGENT_NAME_PREFIX = 'ch-';

interface AgentsInstallOutcome {
  agentsPath: string;
  installed: number;
  removed: number;
}

function parseAgentMarkdown(raw: string): { meta: Record<string, string>; tools: string[]; disallowedTools: string[]; body: string } | null {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fm) return null;
  const meta: Record<string, string> = {};
  const tools: string[] = [];
  const disallowedTools: string[] = [];
  let currentList: string[] | null = null;
  for (const line of fm[1].split('\n')) {
    const listItem = line.match(/^\s+-\s+(.+)$/);
    if (currentList && listItem) { currentList.push(listItem[1].trim()); continue; }
    currentList = null;
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    if (k === 'tools' || k === 'disallowedTools') {
      const target = k === 'tools' ? tools : disallowedTools;
      // 인라인 배열 `tools: [Read, Bash]` 도 허용
      const inline = v.trim().match(/^\[(.*)\]$/);
      if (inline) target.push(...inline[1].split(',').map((t) => t.trim()).filter(Boolean));
      else currentList = target;
      continue;
    }
    meta[k] = v.trim();
  }
  return { meta, tools, disallowedTools, body: fm[2].trim() };
}

/** TOML 문자열에 들어갈 수 없는 제어문자 제거 (탭/개행/CR 은 유지). */
function stripTomlControlChars(v: string): string {
  let out = '';
  for (const ch of v) {
    const code = ch.charCodeAt(0);
    const isAllowed = (code >= 0x20 && code !== 0x7f) || code === 0x09 || code === 0x0a || code === 0x0d;
    if (isAllowed) out += ch;
  }
  return out;
}

/** TOML basic string (한 줄). JSON 문자열 문법은 TOML basic string 의 부분집합. */
function tomlString(v: string): string {
  return JSON.stringify(stripTomlControlChars(v));
}

/** TOML multi-line basic string. 백슬래시와 삼중따옴표만 이스케이프하면 된다. */
function tomlMultiline(v: string): string {
  const cleaned = stripTomlControlChars(v)
    .split('\\').join('\\\\')
    .split('"""').join('\\"\\"\\"');
  return `"""\n${cleaned}\n"""`;
}

const REASONING_BY_CLAUDE_MODEL: Record<string, string> = { opus: 'high', sonnet: 'medium', haiku: 'low' };

/**
 * Claude agent .md → Codex agent role TOML.
 * 공식 스키마(필수 name/description/developer_instructions, 선택 model_reasoning_effort/sandbox_mode)
 * 외 필드는 쓰지 않는다 — Codex 가 unknown field 를 거부 (ADR-014 D2).
 */
export function renderCodexAgentToml(file: string, raw: string): { name: string; toml: string } | null {
  const parsed = parseAgentMarkdown(raw);
  if (!parsed) return null;
  const base = file.replace(/\.md$/, '');
  const name = base.startsWith(AGENT_NAME_PREFIX) ? base : `${AGENT_NAME_PREFIX}${base}`;
  if (!/^[A-Za-z0-9 _-]+$/.test(name)) return null;
  const description = parsed.meta.description || name;
  // critic 2026-10-01: 7/14 에이전트는 `tools:` 대신 `disallowedTools: [Write, Edit]` 로 읽기전용을 선언.
  const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
  const canWrite = parsed.tools.length > 0
    ? parsed.tools.some((t) => WRITE_TOOLS.has(t))
    : !parsed.disallowedTools.some((t) => WRITE_TOOLS.has(t));
  const sandbox = canWrite ? 'workspace-write' : 'read-only';
  const effort = REASONING_BY_CLAUDE_MODEL[parsed.meta.model ?? ''] ?? 'medium';
  const body = parsed.body.length > 0 ? parsed.body : description;
  const toml = [
    AGENT_TOML_MARKER,
    `# generated by \`forgen install codex\` from assets/claude/agents/${file} — do not edit; re-generated on install`,
    `name = ${tomlString(name)}`,
    `description = ${tomlString(description)}`,
    `model_reasoning_effort = ${tomlString(effort)}`,
    `sandbox_mode = ${tomlString(sandbox)}`,
    `developer_instructions = ${tomlMultiline(body)}`,
    '',
  ].join('\n');
  return { name, toml };
}

function installCodexAgents(opts: { sourceDir: string; targetDir: string; dryRun: boolean }): AgentsInstallOutcome {
  const { sourceDir, targetDir, dryRun } = opts;
  if (!fs.existsSync(sourceDir)) return { agentsPath: targetDir, installed: 0, removed: 0 };
  const files = fs.readdirSync(sourceDir).filter((f) => f.endsWith('.md'));
  const isUserOwned = (p: string): boolean => {
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) return true; // 사용자 심링크 (dangling 포함) — 건드리지 않음
      return !fs.readFileSync(p, 'utf-8').slice(0, 64).startsWith(AGENT_TOML_MARKER);
    } catch {
      return false; // 없음
    }
  };
  if (dryRun) {
    const wouldInstall = files.filter((f) => {
      const r = renderCodexAgentToml(f, fs.readFileSync(path.join(sourceDir, f), 'utf-8'));
      return r !== null && !isUserOwned(path.join(targetDir, `${r.name}.toml`));
    }).length;
    return { agentsPath: targetDir, installed: wouldInstall, removed: 0 };
  }

  fs.mkdirSync(targetDir, { recursive: true });

  // stale 정리: forgen-managed 마커가 있는 ch-*.toml 만. 사용자 파일은 보존.
  let removed = 0;
  for (const entry of fs.readdirSync(targetDir)) {
    if (!entry.startsWith(AGENT_NAME_PREFIX) || !entry.endsWith('.toml')) continue;
    const p = path.join(targetDir, entry);
    try {
      if (fs.lstatSync(p).isSymbolicLink()) continue;
      const head = fs.readFileSync(p, 'utf-8').slice(0, 64);
      if (!head.startsWith(AGENT_TOML_MARKER)) continue;
      fs.unlinkSync(p);
      removed += 1;
    } catch { /* best-effort */ }
  }

  let installed = 0;
  for (const file of files) {
    const rendered = renderCodexAgentToml(file, fs.readFileSync(path.join(sourceDir, file), 'utf-8'));
    if (!rendered) continue;
    const dst = path.join(targetDir, `${rendered.name}.toml`);
    if (isUserOwned(dst)) {
      // 방금 stale 정리에서 살아남은 = 사용자 작성 (마커 없음) 또는 심링크 → 보존
      continue;
    }
    fs.writeFileSync(dst, rendered.toml, 'utf-8');
    installed += 1;
  }
  return { agentsPath: targetDir, installed, removed };
}

// ── v0.4.9: dev-guide skills → ~/.codex/skills ────────────────────────

// dev-guide prefix pattern: forgen-<stack>-<skill> (e.g. forgen-react-fe-build)
// 반드시 stack 이 react|vue|node|go 인 것만 매칭 — forgen 자체 commands 보존
const DEV_GUIDE_SKILL_PATTERN = /^forgen-(react|vue|node|go)-/;

interface DevGuideSkillsOutcome {
  devGuideSkillsPath: string;
  devGuideSkillsInstalled: number;
  devGuideSkillsRemoved: number;
}

function installDevGuideSkillsToCodex(opts: { pkgRoot: string; codexHome: string; dryRun: boolean }): DevGuideSkillsOutcome {
  const devGuideRoot = path.join(opts.pkgRoot, 'assets', 'dev-guide');
  const codexSkillsDir = path.join(opts.codexHome, 'skills');

  if (!fs.existsSync(devGuideRoot)) {
    return { devGuideSkillsPath: codexSkillsDir, devGuideSkillsInstalled: 0, devGuideSkillsRemoved: 0 };
  }

  // Collect entries: assets/dev-guide/{tier}/skills/{stack}/{skill}/SKILL.md
  const entries: Array<{ name: string; src: string }> = [];
  for (const tier of fs.readdirSync(devGuideRoot)) {
    const skillsBase = path.join(devGuideRoot, tier, 'skills');
    if (!fs.existsSync(skillsBase)) continue;
    for (const stack of fs.readdirSync(skillsBase)) {
      const stackDir = path.join(skillsBase, stack);
      if (!fs.statSync(stackDir).isDirectory()) continue;
      for (const skill of fs.readdirSync(stackDir)) {
        const skillMd = path.join(stackDir, skill, 'SKILL.md');
        if (fs.existsSync(skillMd)) {
          entries.push({ name: `forgen-${stack}-${skill}`, src: skillMd });
        }
      }
    }
  }

  if (opts.dryRun) {
    return { devGuideSkillsPath: codexSkillsDir, devGuideSkillsInstalled: entries.length, devGuideSkillsRemoved: 0 };
  }

  fs.mkdirSync(codexSkillsDir, { recursive: true });

  // Stale cleanup: dev-guide pattern 만 정리 (forgen 자체 commands 보존)
  let removed = 0;
  for (const entry of fs.readdirSync(codexSkillsDir)) {
    if (DEV_GUIDE_SKILL_PATTERN.test(entry)) {
      try { fs.rmSync(path.join(codexSkillsDir, entry), { recursive: true, force: true }); removed++; } catch { /* best-effort */ }
    }
  }

  // Install via symlink → copyFileSync fallback
  let installed = 0;
  for (const { name, src } of entries) {
    const dstDir = path.join(codexSkillsDir, name);
    fs.mkdirSync(dstDir, { recursive: true });
    const dst = path.join(dstDir, 'SKILL.md');
    let linked = false;
    try {
      fs.symlinkSync(src, dst, 'file');
      linked = true;
    } catch { /* fallback */ }
    if (!linked) {
      fs.copyFileSync(src, dst);
    }
    installed++;
  }

  return { devGuideSkillsPath: codexSkillsDir, devGuideSkillsInstalled: installed, devGuideSkillsRemoved: removed };
}

// ── P3-3: Codex skills install ────────────────────────────────────────

/** ADR-014 D3 — Codex 스킬에는 `$ARGUMENTS` 치환 변수가 없다. */
export function adaptSkillBodyForCodex(body: string): string {
  return body
    .replace(/\{\$ARGUMENTS\}/g, '{the user\'s request text}')
    .replace(/`\$ARGUMENTS`/g, 'the user\'s request text (what follows the skill name)')
    .replace(/\$ARGUMENTS/g, 'the user\'s request text (what follows the skill name)');
}

/** ADR-014 D2/D3 — 스킬 본문의 ch-* 에이전트 참조가 Codex 에서 어떻게 해석되는지 명시. */
const CODEX_SKILL_HOST_NOTE = `
---

## Codex host note (forgen-managed)

- Sub-agents named \`ch-*\` (ch-planner, ch-executor, ch-verifier, ch-critic, ...) are installed as Codex
  custom agents under \`$CODEX_HOME/agents/ch-*.toml\`. Spawn them with Codex's multi-agent tools when
  available (\`[features] multi_agent = true\` in config.toml).
- If spawning is unavailable, call the \`invoke-agent\` tool on the \`forgen-compound\` MCP server
  (agent_name + task) or perform that stage inline yourself. Do not skip the stage.
- The forgen personalized rules for this session arrive as a \`<forgen-rules host="codex">\` block at
  session start. Treat them exactly like Claude Code's .claude/rules/.
`;

function installCodexSkills(opts: { sourceDir: string; targetDir: string; dryRun: boolean }): { installed: number } {
  const { sourceDir, targetDir, dryRun } = opts;
  if (!fs.existsSync(sourceDir)) return { installed: 0 };
  const files = fs.readdirSync(sourceDir).filter((f) => f.endsWith('.md'));
  if (dryRun) return { installed: files.length };

  fs.mkdirSync(targetDir, { recursive: true });
  let count = 0;
  for (const file of files) {
    const skillName = file.replace(/\.md$/, '');
    const skillDir = path.join(targetDir, skillName);
    const skillFile = path.join(skillDir, 'SKILL.md');
    if (fs.existsSync(skillFile)) {
      const existing = fs.readFileSync(skillFile, 'utf-8');
      // Phase 3 critic fix: marker 가 *frontmatter 직후* 위치에 있는지 검증.
      // 사용자가 forgen 문서를 인용해 본문 안에 marker 가 우연히 포함될 수 있어
      // includes() 만으론 안전 X. 정규식으로 frontmatter 종결(`---\n`) 다음 빈 줄 다음
      // 첫 non-blank 줄에 marker 가 있는지 확인.
      const fmMarkerRe = /^---\n[\s\S]*?\n---\n\s*<!-- forgen-managed -->/;
      if (!fmMarkerRe.test(existing)) continue; // 사용자 작성 또는 손상 — skip
    }
    const raw = fs.readFileSync(path.join(sourceDir, file), 'utf-8');
    const descMatch = raw.match(/description:\s*(.+)/);
    const desc = descMatch?.[1]?.trim() ?? skillName;
    const bodyMatch = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    const body = adaptSkillBodyForCodex(bodyMatch?.[1]?.trim() ?? raw);
    const out = `---\nname: ${skillName}\ndescription: ${desc}\n---\n\n${FORGEN_SKILL_MARKER}\n\n${body}\n${CODEX_SKILL_HOST_NOTE}`;
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillFile, out);
    count += 1;
  }
  return { installed: count };
}

// ── P3-3: AGENTS.md inject ────────────────────────────────────────────

export function resolveAgentsMdPath(_pkgRoot: string): string {
  // Phase 3 critic fix: pkgRoot 기반 walk-up 은 `npm install -g` 시 시스템 디렉토리
  // (예: /usr/local/lib/node_modules/forgen) 에 fallback AGENTS.md 작성 위험.
  // *cwd 기반* 으로 변경 — 사용자 작업 디렉토리의 git root, 없으면 cwd 자체.
  // (사용자가 forgen install codex 를 실행하는 위치가 install target 이라는 자연 가정.)
  // pkgRoot 는 fallback 으로 유지 (cwd 가 git root 를 못 찾고 / 등 시스템 dir 일 때).
  const cwd = process.cwd();
  let dir = cwd;
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(dir, '.git'))) return path.join(dir, 'AGENTS.md');
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // cwd 에서 .git 못 찾음 — cwd 직접 사용 (시스템 dir 가 아닌 한 안전).
  // 시스템 dir (예: /, /usr) 인 경우 ~/AGENTS.md fallback (사용자 home 안전).
  if (cwd === '/' || cwd.startsWith('/usr/') || cwd.startsWith('/opt/')) {
    return path.join(os.homedir(), 'AGENTS.md');
  }
  return path.join(cwd, 'AGENTS.md');
}

function buildForgenRulesBlock(pkgRoot: string): string {
  // forgen 의 핵심 규칙 + 사용자 profile 안내 (가벼운 헤더만 — 실 rule 본문은 ADR-014 D1 의 SessionStart hook 주입)
  const lines = [
    AGENTS_MD_BEGIN,
    '## forgen managed rules',
    '',
    '본 블록은 `forgen install codex` 가 자동 관리. 직접 편집 금지 — 다음 install 시 덮어쓰임.',
    '',
    '- forgen-compound MCP 가 ~/.codex/config.toml 에 등록됨. 학습된 솔루션을 `compound-search` 로 조회 가능.',
    '- 사용자 교정은 `correction-record` MCP 도구로 즉시 박제 (kind: fix-now / prefer-from-now / avoid-this).',
    '- forgen 의 4축 profile (quality_safety / autonomy / judgment_philosophy / communication_style) 이 응답 톤 + 검증 깊이를 가이드.',
    '- 개인화 룰 본문은 세션 시작 시 SessionStart hook 이 `<forgen-rules host="codex">` 블록으로 주입 (ADR-014). 서브에이전트는 ~/.codex/agents/ch-*.toml.',
    `- pkgRoot: ${pkgRoot}`,
    AGENTS_MD_END,
  ];
  return lines.join('\n');
}

export function upsertForgenRulesInAgentsMd(opts: { agentsMdPath: string; pkgRoot: string; dryRun: boolean }): { injected: boolean } {
  const { agentsMdPath, pkgRoot, dryRun } = opts;
  const block = buildForgenRulesBlock(pkgRoot);
  let current = '';
  if (fs.existsSync(agentsMdPath)) {
    current = fs.readFileSync(agentsMdPath, 'utf-8');
  }

  // Phase 3 critic fix #1: RegExp lastIndex 위험 회피 — g flag 제거 + 매번 새 RegExp.
  const reMarker = new RegExp(`${escapeRegex(AGENTS_MD_BEGIN)}[\\s\\S]*?${escapeRegex(AGENTS_MD_END)}`);
  const hasBlock = reMarker.test(current);

  // Phase 3 critic fix #2: AGENTS.md self-heal — begin marker 만 있고 end 손상 시
  // 누적 방지. begin 부터 파일 끝까지 + AGENTS_MD_END 미존재 = 손상으로 판단,
  // begin 부터 파일 끝까지를 *전부* 새 block 으로 교체.
  let newContent: string;
  if (hasBlock) {
    newContent = current.replace(reMarker, block);
  } else {
    const beginIdx = current.indexOf(AGENTS_MD_BEGIN);
    const endIdx = current.indexOf(AGENTS_MD_END);
    if (beginIdx !== -1 && endIdx === -1) {
      // 손상: begin 만 있음 → begin 부터 끝까지 교체 (self-heal)
      newContent = `${current.slice(0, beginIdx).replace(/\s+$/, '')}\n\n${block}\n`;
    } else {
      // 깨끗한 신규 또는 둘 다 없음 → 끝에 append
      newContent = `${current.replace(/\s+$/, '')}${current.length > 0 ? '\n\n' : ''}${block}\n`;
    }
  }

  if (dryRun) return { injected: newContent !== current };
  fs.mkdirSync(path.dirname(agentsMdPath), { recursive: true });
  fs.writeFileSync(agentsMdPath, newContent, 'utf-8');
  return { injected: newContent !== current };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
