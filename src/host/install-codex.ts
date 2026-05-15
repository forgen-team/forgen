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
}

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
}

const MCP_MARKER_BEGIN = '# >>> forgen-managed-mcp';
const MCP_MARKER_END = '# <<< forgen-managed-mcp';
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

  // 2) 기존 hooks.json 읽기 + forgen entry 제거 후 보존
  const existing = readJsonFile<HooksFile>(hooksPath);
  const existingHooksByEvent = (existing?.hooks ?? {}) as Record<string, unknown[]>;
  const preserved: Record<string, unknown[]> = {};
  let preservedCount = 0;
  for (const [event, entries] of Object.entries(existingHooksByEvent)) {
    if (!Array.isArray(entries)) continue;
    const userEntries = entries.filter((e) => !isForgenManagedHook(e, opts.pkgRoot));
    if (userEntries.length > 0) {
      preserved[event] = userEntries;
      preservedCount += userEntries.length;
    }
  }

  // 3) merge: user 보존 + forgen fresh.
  //    `forgenCount` 는 실제 hook 명령 개수 (matcher group 내부 hooks[] 길이의 합) 로 집계한다.
  const merged: Record<string, unknown[]> = { ...preserved };
  let forgenCount = 0;
  for (const [event, entries] of Object.entries(generatedHooks)) {
    const list = merged[event] ?? [];
    list.push(...entries);
    merged[event] = list;
    for (const group of entries) {
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
  let mcpContentToWrite: string | null = null;

  if (registerMcp) {
    const currentToml = fs.existsSync(configTomlPath)
      ? fs.readFileSync(configTomlPath, 'utf-8')
      : '';
    const { content, alreadyPresent } = upsertMcpBlock(currentToml, opts.pkgRoot);
    mcpAlreadyPresent = alreadyPresent;
    mcpRegistered = !alreadyPresent;
    mcpContentToWrite = content;
  }

  // 5) 실제 쓰기 (dryRun 이면 skip) — hooks.json + config.toml
  if (!opts.dryRun) {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(hooksPath, `${JSON.stringify(finalHooksFile, null, 2)}\n`, 'utf-8');
    if (mcpContentToWrite !== null) {
      fs.writeFileSync(configTomlPath, mcpContentToWrite, 'utf-8');
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
  };
}

// ── P3-3: Codex skills install ────────────────────────────────────────

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
    const body = bodyMatch?.[1]?.trim() ?? raw;
    const out = `---\nname: ${skillName}\ndescription: ${desc}\n---\n\n${FORGEN_SKILL_MARKER}\n\n${body}\n`;
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillFile, out);
    count += 1;
  }
  return { installed: count };
}

// ── P3-3: AGENTS.md inject ────────────────────────────────────────────

function resolveAgentsMdPath(_pkgRoot: string): string {
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
  // forgen 의 핵심 규칙 + 사용자 profile 안내 (가벼운 헤더만 — 실 rule 은 hook chain 이 inject)
  const lines = [
    AGENTS_MD_BEGIN,
    '## forgen managed rules',
    '',
    '본 블록은 `forgen install codex` 가 자동 관리. 직접 편집 금지 — 다음 install 시 덮어쓰임.',
    '',
    '- forgen-compound MCP 가 ~/.codex/config.toml 에 등록됨. 학습된 솔루션을 `compound-search` 로 조회 가능.',
    '- 사용자 교정은 `correction-record` MCP 도구로 즉시 박제 (kind: fix-now / prefer-from-now / avoid-this).',
    '- forgen 의 4축 profile (quality_safety / autonomy / judgment_philosophy / communication_style) 이 응답 톤 + 검증 깊이를 가이드.',
    '- 본 rule 은 cwd 의 AGENTS.md 가 자동 read 되는 Codex 의 user_instructions 경로로 흘러들어감.',
    `- pkgRoot: ${pkgRoot}`,
    AGENTS_MD_END,
  ];
  return lines.join('\n');
}

function upsertForgenRulesInAgentsMd(opts: { agentsMdPath: string; pkgRoot: string; dryRun: boolean }): { injected: boolean } {
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
