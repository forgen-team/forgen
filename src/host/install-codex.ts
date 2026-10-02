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
import { HOOK_REGISTRY } from '../hooks/hook-registry.js';
import { hasManagedSkillMarker, isManagedAgentToml } from './managed-marker.js';

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
  /** forgen 블록의 notify 줄이 손으로 고쳐져(여러 줄 배열 등) 안전하게 다시 쓸 수 없어 그대로 둠 */
  | 'custom-block'
  /** --no-notify: 블록이 없었음 */
  | 'skipped'
  /** --no-notify: 기존 forgen 블록을 제거함 */
  | 'removed';

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
  /** trusted_hash 가 현재 핸들러의 해시와 일치하고 꺼져 있지 않은 수 (Codex 가 실제로 실행하는 훅) */
  trusted: number;
  /** 신뢰 기록이 없는 hook 키 (`<event>:<i>:<j>`) */
  untrusted: string[];
  /**
   * ADR-016 D2: 신뢰 기록은 있으나 핸들러가 바뀌어 해시가 어긋난 hook 키. Codex 는 `/hooks` 재승인
   * 전까지 이 훅도 skip 한다 (이전엔 키 존재만 봐서 "trusted" 로 오표시).
   */
  modified: string[];
  /** 승인돼 있고 해시도 맞지만 사용자가 `/hooks` 에서 끈 훅 (`enabled = false`) — Codex 가 실행하지 않는다 */
  disabled: string[];
  /** config.toml 자체가 없거나 hooks.state 가 전혀 없으면 true (Codex 가 아직 한 번도 훅을 review 안 함) */
  noStateRecorded: boolean;
}

const MCP_MARKER_BEGIN = '# >>> forgen-managed-mcp';
const MCP_MARKER_END = '# <<< forgen-managed-mcp';
const NOTIFY_MARKER_BEGIN = '# >>> forgen-managed-notify';
const NOTIFY_MARKER_END = '# <<< forgen-managed-notify';
export const FORGEN_SKILL_MARKER = '<!-- forgen-managed -->';
const AGENTS_MD_BEGIN = '<!-- >>> forgen-managed-rules -->';
const AGENTS_MD_END = '<!-- <<< forgen-managed-rules -->';

function resolveCodexHome(opts: CodexInstallOptions): string {
  return opts.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

// 0.4.6 fix — pkgRoot match 외에 script-marker fallback 추가.
// Stale install path (예: 다른 머신에서 install 한 hooks.json 마운트, 또는
// node_modules path 변경) 의 forgen entry 를 "user entry" 로 오분류 → 중복 누적
// 하던 버그.
//
// 0.5.7 (critic): fallback 이 `dist/hooks/<아무이름>.js` 전부와 pkgRoot *부분문자열* 을 forgen 으로 봐서
// 다른 프로젝트의 `…/dist/hooks/pre-commit.js` 나 `<pkgRoot>-fork/hook.sh` 까지 forgen 소유로 분류했다
// (uninstall 이 그것을 지운다). 이제: (1) pkgRoot 의 dist/ 아래, (2) codex-adapter 경유, (3) registry 에
// 있는 forgen 훅 스크립트 이름 — 셋 중 하나일 때만.
const FORGEN_ADAPTER_RE = /[\\/]dist[\\/]host[\\/]codex-adapter\.js(?![\w-])/;
const FORGEN_HOOK_SCRIPT_RE = /[\\/]dist[\\/]hooks[\\/]([a-z][a-z0-9-]*)\.js(?![\w-])/;
const FORGEN_HOOK_SCRIPT_NAMES: ReadonlySet<string> = new Set(
  HOOK_REGISTRY.map((h) => h.script.split(' ')[0].replace(/^hooks\//, '').replace(/\.js$/, '')),
);

/** 훅 command 문자열이 forgen 소유인가. */
export function isForgenHookCommand(command: unknown, pkgRoot: string): boolean {
  if (typeof command !== 'string') return false;
  if (command.includes(`${pkgRoot}/dist/`) || command.includes(`${pkgRoot}\\dist\\`)) return true;
  if (FORGEN_ADAPTER_RE.test(command)) return true;
  const script = command.match(FORGEN_HOOK_SCRIPT_RE)?.[1];
  return script !== undefined && FORGEN_HOOK_SCRIPT_NAMES.has(script);
}

function isForgenManagedHook(entry: unknown, pkgRoot: string): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as { hooks?: Array<{ command?: string }> };
  if (!Array.isArray(e.hooks)) return false;
  return e.hooks.some((h) => isForgenHookCommand(h.command, pkgRoot));
}

export function readJsonFile<T>(p: string): T | null {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch {
    return null;
  }
}

// ── config.toml managed blocks ─────────────────────────────────────────
//
// Codex 는 config.toml 을 스스로 다시 쓴다 (toml_edit): `/hooks` 승인은 `[hooks.state."…"]` 테이블을,
// 모델 변경 등은 root 키를 추가한다. 주석은 "다음 항목의 장식" 으로 취급되므로 forgen 의 마커 주석은
// **제자리에 있지 않는다**:
//   - END 마커가 파일 끝/첫 테이블 앞에 있으면 Codex 가 쓴 내용이 BEGIN…END 사이에 끼어든다
//     (0.5.6 critic — 블록을 통째로 교체하면 훅 신뢰 22건과 사용자 설정이 사라졌다).
//   - Codex 0.160 은 테이블을 재배치한다: BEGIN 은 forgen 테이블과 함께 파일 끝으로 가고 END 는 앞쪽에
//     고아로 남는다 (2026-10-02 실머신).
//   - `codex mcp add <다른 서버>` 는 mcp_servers 를 통째로 다시 써서 BEGIN 마커를 **없앤다** (0.5.8 critic).
// 그래서 마커를 범위로도, 유일한 소유 근거로도 쓰지 않는다. 범위는 TOML 구조(테이블 헤더 ~ 다음 헤더, notify 한 줄),
// 소유는 "마커가 있거나, forgen 만 쓰는 내용 시그니처가 있다" 로 판정한다. forgen 이 쓴 줄만 고치고 나머지는 그대로 둔다.

const FORGEN_SERVER_KEY = `(?:forgen-compound|"forgen-compound"|'forgen-compound')`;
/** `[mcp_servers.forgen-compound]` — 따옴표/공백 표기도 같은 테이블이다 */
const MCP_HEADER_RE = new RegExp(`^\\[\\s*mcp_servers\\s*\\.\\s*${FORGEN_SERVER_KEY}\\s*\\]\\s*(#.*)?$`);
/** forgen 서버의 하위 테이블 (`[mcp_servers.forgen-compound.env]`, `[[…things]]`) */
const MCP_SUBTABLE_RE = new RegExp(`^\\[{1,2}\\s*mcp_servers\\s*\\.\\s*${FORGEN_SERVER_KEY}\\s*\\.`);
/** 같은 서버를 헤더가 아닌 형태로 정의한 줄 (inline table / dotted key) — 손으로 쓴 설정 */
const MCP_ALT_FORM_RE = new RegExp(`^\\s*(?:mcp_servers\\s*\\.\\s*)?${FORGEN_SERVER_KEY}\\s*(?:=|\\.)`);
/** forgen 이 쓰는 args 의 시그니처: `…/dist/mcp/server.js` + `--host=codex` (이 플래그는 forgen 전용) */
const MCP_SIGNATURE_RE = /[\\/]dist[\\/]mcp[\\/]server\.js["'][\s\S]*--host=codex/;
const MCP_TABLE_HEADER = '[mcp_servers.forgen-compound]';
const MCP_OWN_KEY_RE = /^\s*(command|args)\s*=/;

const TOML_KEY = `(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')`;
/** 테이블 헤더 한 줄: `[a.b]`, `[[a.b]]`, `[a."b c"] # 주석`. 배열 값의 한 줄(`["x", "y"],`)과 구분한다. */
const TABLE_HEADER_RE = new RegExp(`^\\s*\\[\\[?\\s*${TOML_KEY}(?:\\s*\\.\\s*${TOML_KEY})*\\s*\\]\\]?\\s*(#.*)?$`);

type LineKind = 'header' | 'cont' | 'other';

/**
 * 줄을 구조적으로 분류한다. 여러 줄 문자열(`"""`/`'''`)이나 여러 줄 배열의 이어지는 줄(`cont`)은 값의 일부이므로
 * 그 안의 `[` 로 시작하는 줄을 헤더로, 마커처럼 보이는 줄을 마커로 오인하면 안 된다 (0.5.8 critic m6).
 * 완전한 TOML 파서는 아니다 — 문자열 밖의 대괄호 균형과 삼중따옴표 열림/닫힘만 추적한다.
 */
function classifyLines(lines: string[]): LineKind[] {
  const kinds: LineKind[] = [];
  let inString: string | null = null;
  let depth = 0;
  const stripInline = (l: string): string => l.replace(/"(?:[^"\\\\]|\\\\.)*"|'[^']*'/g, '""').replace(/#.*$/, '');
  const balance = (l: string): number => (l.match(/\[/g)?.length ?? 0) - (l.match(/\]/g)?.length ?? 0);
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (inString !== null) {
      kinds.push('cont');
      if (line.includes(inString)) inString = null;
      continue;
    }
    if (depth > 0) {
      kinds.push('cont');
      depth = Math.max(0, depth + balance(stripInline(line)));
      continue;
    }
    if (TABLE_HEADER_RE.test(line)) { kinds.push('header'); continue; }
    kinds.push('other');
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const triple = line.match(/"""|'''/g) ?? [];
    if (triple.length % 2 === 1) { inString = triple[triple.length - 1]; continue; }
    depth = Math.max(0, balance(stripInline(line)));
  }
  return kinds;
}

/** BOM 은 파일 맨 앞에 있어야 한다 — 떼어 두었다가 결과 맨 앞에 다시 붙인다. 줄 끝(CRLF)도 보존. */
function tomlShape(toml: string): { bom: string; body: string; cr: string } {
  const bom = toml.startsWith('﻿') ? '﻿' : '';
  return { bom, body: toml.slice(bom.length), cr: /\r\n/.test(toml) ? '\r' : '' };
}

/** 줄 배열 → 파일 내용. CRLF 파일의 마지막 줄이 `\r` 로만 끝나면(개행 없음) Codex 가 거부하므로 `\n` 을 붙인다. */
function joinToml(bom: string, lines: string[]): string {
  const text = lines.join('\n');
  return bom + (text.endsWith('\r') ? `${text}\n` : text);
}

/**
 * 지정한 줄들을 지운다. 지운 자리 양옆이 모두 빈 줄(또는 파일 시작)이면 빈 줄 하나도 함께 지워
 * 제거/재설치를 반복해도 빈 줄이 쌓이지 않게 한다. 지우지 않은 구간의 서식은 건드리지 않는다.
 */
function deleteLines(lines: string[], drop: ReadonlySet<number>): string[] {
  const out: string[] = [];
  let justDropped = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (drop.has(i)) { justDropped = true; continue; }
    const blank = lines[i].trim() === '';
    if (justDropped && blank && (out.length === 0 || out[out.length - 1].trim() === '')) {
      // 마지막 요소('' = 파일 끝 개행)는 남기고 앞의 빈 줄을 대신 버린다. CRLF 파일에서 앞의 빈 줄은 '\r' 이라
      // 그것을 마지막에 남기면 bare CR 로 끝나 Codex 가 로드하지 못한다 (0.5.8 critic C1).
      if (i === lines.length - 1) {
        if (out.length > 0) out[out.length - 1] = lines[i]; else out.push(lines[i]);
      }
      continue;
    }
    justDropped = false;
    out.push(lines[i]);
  }
  return out;
}

/**
 * 제거 뒤 파일 끝을 정리한다: 끝의 빈 줄은 걷어내고, 내용이 있으면 개행 하나로 끝나게 한다.
 * 설치↔제거를 반복해도 결과가 같아지게 하기 위함 (설치는 블록을 개행으로 끝내므로).
 */
function trimEofBlankLines(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 1 && out[out.length - 1] === '' && out[out.length - 2].trim() === '') out.splice(out.length - 2, 1);
  if (out.length > 0 && out[out.length - 1] !== '' && out.some((l) => l.trim() !== '')) {
    // CRLF 파일이면 마지막 줄도 CRLF 로 끝낸다
    if (out.some((l) => l.endsWith('\r')) && !out[out.length - 1].endsWith('\r')) out[out.length - 1] += '\r';
    out.push('');
  }
  return out;
}

/** 테이블 본문의 끝: 다음 헤더/마커 직전. 끝의 빈 줄과 주석은 *다음 항목의 장식* 이므로 본문이 아니다. */
function tableBodyEnd(lines: string[], kinds: LineKind[], header: number, isMarker: (t: string) => boolean): number {
  let end = header + 1;
  while (end < lines.length) {
    if (kinds[end] === 'header' || (kinds[end] === 'other' && isMarker(lines[end].trim()))) break;
    end += 1;
  }
  while (end > header + 1) {
    const t = lines[end - 1].trim();
    if (kinds[end - 1] === 'other' && (t === '' || t.startsWith('#'))) end -= 1; else break;
  }
  return end;
}

interface McpLayout {
  kinds: LineKind[];
  beginIdx: number[];
  endIdx: number[];
  /** forgen 테이블 헤더 줄 (-1 = 없음) */
  header: number;
  /** 테이블 본문 [header+1, bodyEnd) */
  bodyEnd: number;
  /**
   * forgen 이 쓴 테이블인가: 헤더 바로 위에 BEGIN 마커가 붙어 있거나(주석은 테이블과 함께 움직인다),
   * args 가 forgen 시그니처다(마커가 사라진 뒤에도 알아본다). 파일 어딘가의 BEGIN 마커만으로는 인정하지 않는다 —
   * 다른 테이블에 붙은 고아 마커 때문에 사용자가 직접 쓴 같은 이름의 테이블을 forgen 것으로 오인하지 않게.
   */
  owned: boolean;
}

const isMcpMarker = (t: string): boolean => t === MCP_MARKER_BEGIN || t === MCP_MARKER_END;

function locateMcp(lines: string[]): McpLayout {
  const kinds = classifyLines(lines);
  const beginIdx: number[] = [];
  const endIdx: number[] = [];
  let header = -1;
  lines.forEach((l, i) => {
    if (kinds[i] === 'cont') return; // 여러 줄 값 안의 텍스트
    const t = l.trim();
    if (t === MCP_MARKER_BEGIN) beginIdx.push(i);
    else if (t === MCP_MARKER_END) endIdx.push(i);
    else if (header === -1 && kinds[i] === 'header' && MCP_HEADER_RE.test(t)) header = i;
  });
  const bodyEnd = header === -1 ? 0 : tableBodyEnd(lines, kinds, header, isMcpMarker);
  // 헤더 바로 위(빈 줄과 forgen 의 다른 마커/주석은 건너뛴다)에 BEGIN 이 있는가
  let above = header - 1;
  while (above >= 0) {
    const t = lines[above].trim();
    if (t === '' || t === MCP_MARKER_END || isNotifyMarker(t) || isNotifyOwnComment(t)) above -= 1; else break;
  }
  const beginAdjacent = above >= 0 && beginIdx.includes(above);
  const owned = header !== -1
    && (beginAdjacent || MCP_SIGNATURE_RE.test(lines.slice(header + 1, bodyEnd).join('\n')));
  return { kinds, beginIdx, endIdx, header, bodyEnd, owned };
}

function upsertMcpBlock(currentToml: string, pkgRoot: string): { content: string; alreadyPresent: boolean } {
  const { bom, body, cr } = tomlShape(currentToml);
  const serverPath = path.join(pkgRoot, 'dist', 'mcp', 'server.js');
  // forgen-mcp 는 dist/mcp/server.js. node 경로는 PATH 기반.
  // `--host=codex` 인자는 server.ts 가 process.env.FORGEN_HOST 로 set 하여
  // correction-record evidence 박제 시 host:"codex" 로 정확히 태깅되게 한다 (spec §10-5).
  const ownKeys = ['command = "node"', `args = [${JSON.stringify(serverPath)}, "--host=codex"]`];
  const lines = body.split('\n');
  const at = locateMcp(lines);

  if (at.header === -1) {
    // 헤더가 아닌 형태(inline table / dotted key)로 같은 서버가 정의돼 있으면 append 하지 않는다 —
    // 중복 정의는 Codex 가 config 를 로드하지 못하게 한다.
    if (lines.some((l, i) => at.kinds[i] === 'other' && MCP_ALT_FORM_RE.test(l))) return { content: currentToml, alreadyPresent: true };
    // 테이블이 없다 → 끝에 새 블록. 고아 마커(테이블만 지워진 흔적)는 걷어낸다.
    const cleaned = deleteLines(lines, new Set([...at.beginIdx, ...at.endIdx])).join('\n');
    const block = [MCP_MARKER_BEGIN, MCP_TABLE_HEADER, ...ownKeys, MCP_MARKER_END].map((l) => l + cr).join('\n');
    const trimmed = cleaned.replace(/\s+$/, '');
    const sep = trimmed.length > 0 ? `${cr}\n${cr}\n` : '';
    return { content: `${bom}${trimmed}${sep}${block}\n`, alreadyPresent: false };
  }

  // 마커도 forgen 시그니처도 없는 같은 이름의 테이블 = 사용자가 직접 관리. 건드리지도, append 하지도 않는다.
  if (!at.owned) return { content: currentToml, alreadyPresent: true };

  const tableBody = lines.slice(at.header + 1, at.bodyEnd);
  // 손으로 고쳐 여러 줄이 된 command/args 는 안전하게 다시 쓸 수 없다 — 그대로 둔다.
  const own = tableBody.filter((l) => MCP_OWN_KEY_RE.test(l));
  if (own.some((l) => !/(["'\]])\s*(#.*)?$/.test(l.trim()))) return { content: currentToml, alreadyPresent: true };
  // 사용자가 Codex 로 이 서버에 붙인 설정(enabled, startup_timeout_sec …)은 테이블 안에 유지.
  const extraKeys = tableBody.filter((l) => l.trim() !== '' && !MCP_OWN_KEY_RE.test(l)).map((l) => l.replace(/\r$/, ''));
  const block = [MCP_MARKER_BEGIN, lines[at.header].replace(/\r$/, ''), ...ownKeys, ...extraKeys, MCP_MARKER_END].map((l) => l + cr);

  // 마커는 어디에 있든 전부 걷어내고, 테이블 바로 위/아래에 다시 둔다 (재배치/소실된 마커 정규화).
  const SENTINEL = '\u0000forgen-mcp-block\u0000';
  const drop = new Set<number>([...at.beginIdx, ...at.endIdx]);
  for (let i = at.header + 1; i < at.bodyEnd; i += 1) drop.add(i);
  const kept = deleteLines(lines.map((l, i) => (i === at.header ? SENTINEL : l)), drop);
  const pos = kept.indexOf(SENTINEL);
  const next = kept[pos + 1];
  // 블록 뒤에 다른 내용이 바로 붙으면 빈 줄로 구분
  const needsGap = next !== undefined && next.trim() !== '';
  kept.splice(pos, 1, ...block, ...(needsGap ? [cr] : []));
  const content = joinToml(bom, kept);
  return { content, alreadyPresent: content === currentToml };
}

/**
 * forgen MCP 블록 제거 (uninstall, ADR-016 D4). forgen 테이블(본문 + 하위 테이블)과 마커 줄만 걷어낸다.
 * 마커도 시그니처도 없는 같은 이름의 테이블(사용자 관리)은 건드리지 않는다.
 * `removed` 는 테이블을 실제로 지웠을 때만 true — 고아 마커만 치운 경우는 false.
 */
export function removeMcpBlock(currentToml: string): { content: string; removed: boolean } {
  const { bom, body } = tomlShape(currentToml);
  const lines = body.split('\n');
  const at = locateMcp(lines);
  if (at.beginIdx.length === 0 && at.endIdx.length === 0 && !at.owned) return { content: currentToml, removed: false };
  const drop = new Set<number>([...at.beginIdx, ...at.endIdx]);
  if (at.owned) {
    for (let i = at.header; i < at.bodyEnd; i += 1) drop.add(i);
    // 하위 테이블은 Codex 가 어디로 옮겼든 함께 제거 (command 없는 서버 정의가 남지 않게).
    // 각 하위 테이블도 끝의 빈 줄/주석(다음 항목의 장식)은 남긴다.
    lines.forEach((l, i) => {
      if (at.kinds[i] !== 'header' || !MCP_SUBTABLE_RE.test(l.trim())) return;
      for (let k = i; k < tableBodyEnd(lines, at.kinds, i, isMcpMarker); k += 1) drop.add(k);
    });
  }
  const out = trimEofBlankLines(deleteLines(lines, drop));
  while (out.length > 1 && out[0].trim() === '') out.shift(); // 파일 맨 앞 빈 줄
  return { content: joinToml(bom, out), removed: at.owned };
}

// ── ADR-016 D1: notify 폴백 (config.toml top-level `notify`) ───────────

/** forgen notify 바이너리 argv 접두 (`--` 뒤는 사용자가 수동으로 붙인 체인 프로그램). */
function forgenNotifyArgv(pkgRoot: string): string[] {
  return ['node', path.join(pkgRoot, 'dist', 'host', 'codex-notify.js')];
}

const NOTIFY_OWN_COMMENTS = [
  '# forgen turn-complete fallback (ADR-016): works even while forgen hooks are untrusted.',
  '# To chain your own notifier, append:  "--", "<program>", "<args…>"  (kept across re-install).',
];
const isNotifyOwnComment = (t: string): boolean =>
  t.startsWith('# forgen turn-complete fallback') || t.startsWith('# To chain your own notifier');
const isNotifyMarker = (t: string): boolean => t === NOTIFY_MARKER_BEGIN || t === NOTIFY_MARKER_END;
/** `notify`, `"notify"`, `'notify'` 키 (dotted `notify.x` 포함) — 어느 것이든 forgen 의 notify 와 충돌한다. */
const NOTIFY_KEY_RE = /^[ \t]*(?:notify|"notify"|'notify')[ \t]*[.=]/;
/** forgen notify argv 의 시그니처: `…/dist/host/codex-notify.js` */
const NOTIFY_SIGNATURE_RE = /[\\/]dist[\\/]host[\\/]codex-notify\.js$/;

/** `notify = ["a","b"]` 한 줄을 argv 로. 여러 줄 배열·홑따옴표·뒤 주석 등 JSON 으로 못 읽으면 null. */
function parseNotifyArgvLine(line: string): string[] | null {
  const value = line.trim().match(/^(?:notify|"notify"|'notify')[ \t]*=[ \t]*(\[.*\])$/)?.[1];
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((a) => typeof a === 'string') ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

interface NotifyBlockParts {
  /** forgen 이 쓴 줄(마커/주석/notify)이 하나라도 있는가 */
  touched: boolean;
  /** forgen notify 줄이 있는가 (argv 시그니처로 판정) */
  hasForgenLine: boolean;
  /** forgen notify 줄의 argv (없으면 null) */
  argv: string[] | null;
  /** BEGIN 마커 바로 아래의 notify 줄이 손편집돼(여러 줄 배열 등) 한 줄 JSON 으로 읽히지 않는다 */
  custom: boolean;
  /** forgen 이 쓴 줄을 뺀 나머지 (원래 순서 그대로) */
  rest: string[];
  /** forgen 것이 아닌 `notify` 키가 어딘가에 있는가 (사용자 정의) */
  userNotifyKey: boolean;
}

/**
 * forgen notify 줄은 **argv 시그니처**(`…/dist/host/codex-notify.js`)로 찾는다. 마커는 Codex 가 옮기거나
 * 없앨 수 있고, Codex 가 `notify` 값을 직접 바꾸면 forgen 블록 안에 사용자의 값이 들어앉기도 한다
 * (그때 그 줄은 forgen 것이 아니다 — 마커/주석만 걷어내고 값은 보존).
 */
function parseNotifyBlock(lines: string[]): NotifyBlockParts {
  const kinds = classifyLines(lines);
  const own = new Set<number>();
  lines.forEach((l, i) => {
    if (kinds[i] === 'cont') return; // 여러 줄 값 안의 텍스트는 건드리지 않는다
    const t = l.trim();
    if (isNotifyMarker(t) || isNotifyOwnComment(t)) own.add(i);
  });
  let argv: string[] | null = null;
  const forgenIdx = lines.findIndex((l, i) => {
    if (kinds[i] !== 'other' || !NOTIFY_KEY_RE.test(l)) return false;
    const parsed = parseNotifyArgvLine(l);
    if (!parsed?.some((a) => NOTIFY_SIGNATURE_RE.test(a))) return false;
    argv = parsed;
    return true;
  });
  if (forgenIdx !== -1) own.add(forgenIdx);

  // BEGIN 바로 아래(forgen 주석만 사이)의 notify 키가 한 줄 JSON 이 아니면 손편집된 블록 — 호출부가 그대로 둔다.
  let custom = false;
  const begin = lines.findIndex((l) => l.trim() === NOTIFY_MARKER_BEGIN);
  if (begin !== -1) {
    let i = begin + 1;
    while (i < lines.length && isNotifyOwnComment(lines[i].trim())) i += 1;
    if (i < lines.length && NOTIFY_KEY_RE.test(lines[i]) && parseNotifyArgvLine(lines[i]) === null) custom = true;
  }
  return {
    touched: own.size > 0,
    hasForgenLine: forgenIdx !== -1,
    argv,
    custom,
    rest: deleteLines(lines, own),
    userNotifyKey: lines.some((l, i) => !own.has(i) && kinds[i] === 'other' && NOTIFY_KEY_RE.test(l)),
  };
}

/**
 * config.toml 에 forgen notify 블록을 upsert.
 *
 * - Codex 의 `notify` 는 top-level 단일 argv 다. 사용자가 이미 정의했으면 **건드리지 않는다** — 그리고
 *   forgen 줄이 남아 있으면 제거한다 (중복 키 = config.toml 파싱 실패 → Codex 기동 불가).
 * - top-level 키는 첫 테이블 헤더 앞에 와야 하므로 블록은 항상 파일 최상단(BOM 뒤)에 둔다.
 * - 사용자가 forgen argv 뒤에 `"--", "<prog>", …` 로 자기 notifier 를 체인해 뒀으면 그 꼬리를 보존.
 *   블록의 notify 줄을 한 줄 JSON 으로 읽을 수 없으면(여러 줄 배열 등 손편집) 아무것도 바꾸지 않는다.
 * - forgen 이 쓴 줄 외에는 원래 순서 그대로 둔다 (Codex 가 사이에 끼워 넣은 root 키 포함).
 */
export function upsertNotifyBlock(currentToml: string, pkgRoot: string): { content: string; status: CodexNotifyStatus } {
  const { bom, body, cr } = tomlShape(currentToml);
  const lines = body.split('\n');
  const { touched, rest, argv: existingArgv, custom, userNotifyKey } = parseNotifyBlock(lines);
  if (custom) return { content: currentToml, status: 'custom-block' };

  // 보수적 판정: forgen 줄 밖 어디든 `notify =` 줄이 있으면 사용자 정의로 본다 (프로필 테이블 안이어도 skip —
  // 폴백을 못 넣는 쪽이 config 를 깨뜨리는 쪽보다 낫다).
  if (userNotifyKey) {
    return { content: touched ? joinToml(bom, rest) : currentToml, status: 'user-defined' };
  }

  const sep = existingArgv ? existingArgv.indexOf('--') : -1;
  const chainTail = existingArgv && sep !== -1 ? existingArgv.slice(sep) : [];
  const argv = [...forgenNotifyArgv(pkgRoot), ...chainTail];
  const block = [NOTIFY_MARKER_BEGIN, ...NOTIFY_OWN_COMMENTS, `notify = ${JSON.stringify(argv)}`, NOTIFY_MARKER_END].map((l) => l + cr);

  let start = 0;
  while (start < rest.length && rest[start].trim() === '') start += 1;
  const tail = rest.slice(start);
  const content = joinToml(bom, tail.length > 0 ? [...block, cr, ...tail] : [...block, '']);
  return { content, status: content === currentToml ? 'already-present' : 'installed' };
}

/**
 * forgen notify 블록 제거 (`--no-notify`, uninstall).
 *
 * - 사용자가 블록의 notify 줄을 여러 줄 배열 등으로 손편집했으면(`custom`) **건드리지 않는다** — 첫 줄만
 *   지우면 남은 줄이 깨진 TOML 이 되어 Codex 가 기동하지 못한다 (critic 2026-10-02).
 * - `"--"` 뒤에 사용자가 체인해 둔 자기 notifier 가 있으면 그 argv 만으로 `notify` 를 되돌려 놓는다.
 * - `removed` 는 forgen notify 줄을 실제로 지웠을 때만 true. 고아 마커/주석만 치운 경우는 false
 *   (내용은 정리된 것을 돌려준다).
 */
export function removeNotifyBlock(currentToml: string): { content: string; removed: boolean; custom: boolean; restoredChain: string[] } {
  const { bom, body, cr } = tomlShape(currentToml);
  const { touched, hasForgenLine, rest, argv, custom } = parseNotifyBlock(body.split('\n'));
  if (custom) return { content: currentToml, removed: false, custom: true, restoredChain: [] };
  if (!touched) return { content: currentToml, removed: false, custom: false, restoredChain: [] };
  const sep = argv ? argv.indexOf('--') : -1;
  const restoredChain = argv && sep !== -1 ? argv.slice(sep + 1) : [];
  let start = 0;
  while (start < rest.length - 1 && rest[start].trim() === '') start += 1;
  const tail = trimEofBlankLines(rest.slice(start));
  const hasContent = tail.some((l) => l.trim() !== '');
  const restored = restoredChain.length > 0 ? [`notify = ${JSON.stringify(restoredChain)}${cr}`, ...(hasContent ? [cr] : [])] : [];
  return { content: joinToml(bom, [...restored, ...tail]), removed: hasForgenLine, custom: false, restoredChain };
}

export interface HooksFile {
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
      // 빈 그룹(`{"hooks": []}`)은 uninstall 이 다른 도구 훅의 trust 인덱스를 지키려고 남긴 자리표시다 —
      // 재설치 시 그 자리를 다시 채워 forgen 훅이 원래 인덱스(= 이미 승인된 trust 키)로 돌아가게 한다.
      const isPlaceholder = Array.isArray((group as { hooks?: unknown } | null)?.hooks)
        && ((group as { hooks: unknown[] }).hooks.length === 0);
      if (isForgenManagedHook(group, opts.pkgRoot) || isPlaceholder) {
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
  } else {
    // opt-out 은 "더 이상 등록하지 않음" 이 아니라 "없앰" 이어야 한다 (이전 설치의 블록이 남지 않게).
    const r = removeNotifyBlock(configToml);
    configToml = r.content; // 고아 마커만 정리된 경우도 반영
    if (r.removed) notify = 'removed';
    else if (r.custom) notify = 'custom-block';
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
    // upstream 은 raw 플래그를 해시한다 (SessionEnd 의 "동기로 실행" 강등은 실행 방식에만 반영).
    async: handler.async === true,
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

interface CodexHookState { hash: string | null; enabled: boolean }

/** config.toml 의 `[hooks.state."<key>"]` (또는 literal `'<key>'`) 섹션 → trusted_hash / enabled. */
function parseCodexHookState(toml: string): Map<string, CodexHookState> {
  const state = new Map<string, CodexHookState>();
  let current: CodexHookState | null = null;
  for (const raw of toml.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const header = line.match(/^\[hooks\.state\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\]\s*(#.*)?$/);
    if (header) {
      // basic string 은 이스케이프(\\, \") 를 풀고, literal string 은 그대로.
      const key = header[1] !== undefined ? header[1].replace(/\\(["\\])/g, '$1') : header[2];
      current = { hash: null, enabled: true };
      state.set(key, current);
      continue;
    }
    if (/^\s*\[/.test(line)) { current = null; continue; }
    if (current === null) continue;
    const hash = line.match(/^\s*trusted_hash\s*=\s*(?:"([^"]*)"|'([^']*)')/);
    if (hash) current.hash = hash[1] ?? hash[2];
    if (/^\s*enabled\s*=\s*false\b/.test(line)) current.enabled = false;
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
  // Codex 는 $CODEX_HOME 을 canonicalize 한 경로로 키를 쓴다 — 심링크된 홈에서는 raw 경로와 다르다.
  const keyPrefixes = [opts.hooksPath];
  try {
    const real = fs.realpathSync(opts.hooksPath);
    if (real !== opts.hooksPath) keyPrefixes.push(real);
  } catch { /* hooks.json 없음 (dry-run) */ }
  const lookup = (key: string): CodexHookState | undefined => {
    for (const prefix of keyPrefixes) {
      const hit = state.get(`${prefix}:${key}`);
      if (hit) return hit;
    }
    return undefined;
  };

  let total = 0;
  let trusted = 0;
  const untrusted: string[] = [];
  const modified: string[] = [];
  const disabled: string[] = [];
  const ignoredByCodex: string[] = [];
  const events = (hooksFile?.hooks ?? {}) as Record<string, unknown[]>;
  for (const [event, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, gi) => {
      const g = group as { matcher?: unknown; hooks?: Array<Record<string, unknown>> };
      if (!Array.isArray(g.hooks)) return;
      g.hooks.forEach((h, hi) => {
        if (!isForgenHookCommand(h.command, opts.pkgRoot)) return;
        const key = `${codexHookEventKey(event)}:${gi}:${hi}`;
        if (!CODEX_SUPPORTED_HOOK_EVENTS.has(event)) { ignoredByCodex.push(key); return; }
        total += 1;
        const recorded = lookup(key);
        if (!recorded || recorded.hash === null) { untrusted.push(key); return; }
        if (recorded.hash !== codexHookTrustHash(event, g.matcher, h)) { modified.push(key); return; }
        if (!recorded.enabled) { disabled.push(key); return; }
        trusted += 1;
      });
    });
  }
  return { total, trusted, untrusted, modified, disabled, ignoredByCodex, noStateRecorded: state.size === 0 };
}

// ── ADR-014 D2: Codex custom agents (~/.codex/agents/ch-*.toml) ──────

export const AGENT_TOML_MARKER = '# forgen-managed';
export const AGENT_NAME_PREFIX = 'ch-';

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
      return !isManagedAgentToml(fs.readFileSync(p, 'utf-8'));
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
      if (!isManagedAgentToml(fs.readFileSync(p, 'utf-8'))) continue;
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
export const DEV_GUIDE_SKILL_PATTERN = /^forgen-(react|vue|node|go)-/;

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
      if (!hasManagedSkillMarker(existing)) continue; // 사용자 작성 또는 손상 — skip
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

/** AGENTS.md 의 forgen 블록 제거 (uninstall). 블록뿐이던 파일은 삭제한다. */
export function removeForgenRulesFromAgentsMd(opts: { agentsMdPath: string; dryRun: boolean }): { removed: boolean; fileDeleted: boolean } {
  let current: string;
  try { current = fs.readFileSync(opts.agentsMdPath, 'utf-8'); } catch { return { removed: false, fileDeleted: false }; }
  const re = new RegExp(`\\n*${escapeRegex(AGENTS_MD_BEGIN)}[\\s\\S]*?${escapeRegex(AGENTS_MD_END)}\\n?`);
  if (!re.test(current)) return { removed: false, fileDeleted: false };
  const rest = current.replace(re, '\n').replace(/^\n+/, '');
  const empty = rest.trim().length === 0;
  // 심링크면 링크를 지우지 않고 대상 파일에 써 넣는다 (링크만 지우면 대상에 블록이 남는다).
  const isLink = fs.lstatSync(opts.agentsMdPath).isSymbolicLink();
  const deleteFile = empty && !isLink;
  if (!opts.dryRun) {
    if (deleteFile) fs.unlinkSync(opts.agentsMdPath);
    else fs.writeFileSync(opts.agentsMdPath, empty ? '' : (rest.endsWith('\n') ? rest : `${rest}\n`), 'utf-8');
  }
  return { removed: true, fileDeleted: deleteFile };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
