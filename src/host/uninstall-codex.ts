/**
 * Codex uninstall — ADR-016 D4
 *
 * `forgen install codex` 가 쓴 것을 되돌린다: hooks.json 의 forgen 훅, config.toml 의 MCP/notify 블록,
 * `skills/`, `agents/ch-*.toml`, cwd 의 AGENTS.md 블록. 사용자 소유물(마커 없는 파일, 심링크, 다른 도구의
 * 훅)은 보존한다.
 *
 * 훅 신뢰 보존: Codex 의 trust 키는 `<event>:<groupIdx>:<hookIdx>` 다. forgen 그룹을 지워 뒤따르는
 * 사용자 그룹의 인덱스가 당겨지면 **다른 도구의 훅이 재승인 전까지 조용히 skip** 된다. 그래서 뒤에 사용자
 * 그룹이 남는 위치의 forgen 그룹은 빈 그룹(`{"hooks": []}`)으로 남겨 인덱스를 유지한다 (Codex 0.153.4 는
 * 빈 그룹을 경고 없이 받아들인다 — `hooks/list` 로 확인). forgen 은 `[hooks.state]` 를 고쳐 쓰지 않는다.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AGENT_NAME_PREFIX,
  codexHookEventKey,
  type HooksFile,
  isForgenHookCommand,
  removeForgenRulesEverywhere,
  removeMcpBlock,
  removeNotifyBlock,
  resolveAgentsMdPath,
} from './install-codex.js';
import { hasManagedSkillMarker, isManagedAgentToml, listDevGuideSkillNames, removeSkillFile } from './managed-marker.js';

export interface CodexUninstallOptions {
  /** forgen package root — 훅 command 소유 판정에 쓴다 (스크립트 시그니처 fallback 이 있어 정확도 비의존). */
  pkgRoot: string;
  /** codex home (default: $CODEX_HOME ?? ~/.codex). */
  codexHome?: string;
  /** AGENTS.md 위치 override (default: cwd 의 git root). 격리 테스트용. */
  agentsMdPath?: string;
  dryRun?: boolean;
}

export interface CodexUninstallResult {
  codexHome: string;
  /** $CODEX_HOME 자체가 없으면 false — 나머지 필드는 전부 0/false */
  present: boolean;
  /** 제거한 forgen 훅 핸들러 수 */
  hooksRemoved: number;
  /** 보존한 사용자(다른 도구) 훅 핸들러 수 */
  userHooksPreserved: number;
  /** 뒤따르는 사용자 그룹의 trust 인덱스를 지키려고 남긴 빈 그룹 수 */
  placeholderGroups: number;
  /** 같은 그룹 안에서 forgen 핸들러가 빠져 인덱스가 바뀐 사용자 훅 (`<event>:<group>:<old>→<new>`) — `/hooks` 재승인 필요 */
  userHooksReindexed: string[];
  hooksFileDeleted: boolean;
  mcpRemoved: boolean;
  notifyRemoved: boolean;
  /** forgen notify 블록이 손편집돼(여러 줄 배열 등) 안전하게 지울 수 없어 그대로 둠 */
  notifyCustomLeft: boolean;
  /** 블록에 체인돼 있던 사용자 notifier argv — 그것만으로 `notify` 를 되돌려 놓았다 */
  notifyChainRestored: string[];
  skillsRemoved: number;
  agentsRemoved: number;
  agentsMdCleaned: boolean;
  /** forgen 블록을 걷어낸 AGENTS.md 경로 (설치 시 기록된 프로젝트들 + 지금의 cwd) */
  agentsMdCleanedPaths: string[];
  /** 단계별 실패 (한 단계가 실패해도 나머지는 진행한다) */
  errors: string[];
}

const FORGEN_HOOKS_DESCRIPTION_RE = /^forgen Codex hooks \(managed/;

interface Group { matcher?: unknown; hooks?: unknown }

function isEmptyGroup(g: unknown): boolean {
  const hooks = (g as Group | null)?.hooks;
  return Array.isArray(hooks) && hooks.length === 0;
}

/** hooks.json 에서 forgen 핸들러 제거 (순수 함수 — 파일을 쓰지 않는다). */
export function stripForgenHooks(file: HooksFile, pkgRoot: string): {
  next: HooksFile | null;
  removed: number;
  preserved: number;
  placeholders: number;
  reindexed: string[];
} {
  let removed = 0;
  let preserved = 0;
  let placeholders = 0;
  const reindexed: string[] = [];
  const nextHooks: Record<string, unknown[]> = {};

  for (const [event, rawGroups] of Object.entries(file.hooks ?? {})) {
    if (!Array.isArray(rawGroups)) { nextHooks[event] = rawGroups as unknown[]; continue; }
    const groups = rawGroups.map((group, gi) => {
      const g = group as Group;
      if (!Array.isArray(g?.hooks)) return group; // 모르는 형태 — 건드리지 않는다
      const kept: unknown[] = [];
      (g.hooks as Array<{ command?: unknown }>).forEach((h, hi) => {
        if (isForgenHookCommand(h?.command, pkgRoot)) { removed += 1; return; }
        if (kept.length !== hi) reindexed.push(`${codexHookEventKey(event)}:${gi}:${hi}→${kept.length}`);
        kept.push(h);
        preserved += 1;
      });
      if (kept.length === g.hooks.length) return group; // forgen 핸들러 없음 — 원본 그대로
      // forgen 전용 그룹은 자리표시용 빈 그룹으로 (matcher 는 의미가 없어 뺀다)
      return kept.length === 0 ? { hooks: [] } : { ...g, hooks: kept };
    });
    // 뒤에서부터 빈 그룹을 걷어낸다 — 뒤따르는 그룹이 없으면 인덱스를 지킬 이유가 없다.
    while (groups.length > 0 && isEmptyGroup(groups[groups.length - 1])) groups.pop();
    if (groups.length === 0) continue;
    placeholders += groups.filter(isEmptyGroup).length;
    nextHooks[event] = groups;
  }

  const { description, hooks: _hooks, ...rest } = file as HooksFile & Record<string, unknown>;
  const keepDescription = typeof description === 'string' && !FORGEN_HOOKS_DESCRIPTION_RE.test(description);
  const nothingLeft = Object.keys(nextHooks).length === 0 && Object.keys(rest).length === 0 && !keepDescription;
  if (nothingLeft) return { next: null, removed, preserved, placeholders, reindexed };
  const next = { ...(keepDescription ? { description } : {}), ...rest, hooks: nextHooks } as HooksFile;
  return { next, removed, preserved, placeholders, reindexed };
}

function removeManagedSkills(skillsDir: string, pkgRoot: string, dryRun: boolean): number {
  let removed = 0;
  let entries: string[];
  try { entries = fs.readdirSync(skillsDir); } catch { return 0; }
  // dev-guide 스킬은 이름 패턴이 아니라 패키지가 실제로 제공하는 이름으로 소유를 판정한다.
  const devGuideNames = listDevGuideSkillNames(pkgRoot);
  for (const name of entries) {
    const skillFile = path.join(skillsDir, name, 'SKILL.md');
    let owned = devGuideNames.has(name);
    if (!owned) {
      try {
        owned = !fs.lstatSync(skillFile).isSymbolicLink() && hasManagedSkillMarker(fs.readFileSync(skillFile, 'utf-8'));
      } catch { owned = false; }
    }
    if (owned && removeSkillFile(skillsDir, name, dryRun)) removed += 1;
  }
  return removed;
}

function removeManagedAgents(agentsDir: string, dryRun: boolean): number {
  let removed = 0;
  let entries: string[];
  try { entries = fs.readdirSync(agentsDir); } catch { return 0; }
  for (const entry of entries) {
    if (!entry.startsWith(AGENT_NAME_PREFIX) || !entry.endsWith('.toml')) continue;
    const p = path.join(agentsDir, entry);
    try {
      if (fs.lstatSync(p).isSymbolicLink()) continue;
      if (!isManagedAgentToml(fs.readFileSync(p, 'utf-8'))) continue;
      if (!dryRun) fs.unlinkSync(p);
      removed += 1;
    } catch { /* best-effort */ }
  }
  return removed;
}

export function planCodexUninstall(opts: CodexUninstallOptions): CodexUninstallResult {
  const codexHome = opts.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const dryRun = opts.dryRun ?? false;
  const result: CodexUninstallResult = {
    codexHome,
    present: fs.existsSync(codexHome),
    hooksRemoved: 0,
    userHooksPreserved: 0,
    placeholderGroups: 0,
    userHooksReindexed: [],
    hooksFileDeleted: false,
    mcpRemoved: false,
    notifyRemoved: false,
    notifyCustomLeft: false,
    notifyChainRestored: [],
    skillsRemoved: 0,
    agentsRemoved: 0,
    agentsMdCleaned: false,
    agentsMdCleanedPaths: [],
    errors: [],
  };
  if (!result.present) return result;

  // 각 단계는 독립이다 — 하나가 실패(읽기 전용 파일 등)해도 나머지 정리는 계속한다.
  const step = (label: string, fn: () => void): void => {
    try { fn(); } catch (e) { result.errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  // 1) hooks.json
  step('hooks.json', () => {
    const hooksPath = path.join(codexHome, 'hooks.json');
    if (!fs.existsSync(hooksPath)) return;
    let hooksFile: unknown;
    try {
      hooksFile = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    } catch {
      throw new Error('not valid JSON — left untouched (remove forgen entries by hand)');
    }
    const hooks = (hooksFile as { hooks?: unknown } | null)?.hooks;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return;
    const stripped = stripForgenHooks(hooksFile as HooksFile, opts.pkgRoot);
    result.hooksRemoved = stripped.removed;
    result.userHooksPreserved = stripped.preserved;
    result.placeholderGroups = stripped.placeholders;
    result.userHooksReindexed = stripped.reindexed;
    if (stripped.removed === 0) return;
    result.hooksFileDeleted = stripped.next === null;
    if (dryRun) return;
    if (stripped.next === null) fs.unlinkSync(hooksPath);
    else fs.writeFileSync(hooksPath, `${JSON.stringify(stripped.next, null, 2)}\n`, 'utf-8');
  });

  // 2) config.toml — MCP / notify 블록
  step('config.toml', () => {
    const configTomlPath = path.join(codexHome, 'config.toml');
    if (!fs.existsSync(configTomlPath)) return;
    const current = fs.readFileSync(configTomlPath, 'utf-8');
    const mcp = removeMcpBlock(current);
    const notify = removeNotifyBlock(mcp.content);
    result.mcpRemoved = mcp.removed;
    result.notifyRemoved = notify.removed;
    result.notifyCustomLeft = notify.custom;
    result.notifyChainRestored = notify.restoredChain;
    if (!dryRun && notify.content !== current) fs.writeFileSync(configTomlPath, notify.content, 'utf-8');
  });

  // 3) skills / agents
  step('skills', () => { result.skillsRemoved = removeManagedSkills(path.join(codexHome, 'skills'), opts.pkgRoot, dryRun); });
  step('agents', () => { result.agentsRemoved = removeManagedAgents(path.join(codexHome, 'agents'), dryRun); });

  // 4) AGENTS.md — 설치 때 기록된 프로젝트 전부 + 지금의 cwd (0.5.9 이전 설치분은 기록이 없어 cwd 만)
  step('AGENTS.md', () => {
    const cwdAgentsMdPath = opts.agentsMdPath ?? resolveAgentsMdPath(opts.pkgRoot);
    result.agentsMdCleanedPaths = removeForgenRulesEverywhere({ hostDir: codexHome, cwdAgentsMdPath, dryRun });
    result.agentsMdCleaned = result.agentsMdCleanedPaths.length > 0;
  });

  return result;
}

/** CLI 출력 — 무엇을 지웠고 무엇을 남겼는지. */
export function renderCodexUninstall(r: CodexUninstallResult): string[] {
  if (!r.present) return [];
  const lines: string[] = [];
  if (r.hooksRemoved > 0) {
    lines.push(`  ✓ Removed ${r.hooksRemoved} forgen hook(s) from Codex hooks.json${r.hooksFileDeleted ? ' (file deleted — nothing else was in it)' : ` (kept ${r.userHooksPreserved} hook(s) from other tools)`}`);
    if (r.placeholderGroups > 0) {
      lines.push(`    ↳ left ${r.placeholderGroups} empty group(s) so the hooks after them keep their Codex trust (deleting them means re-approving those hooks in /hooks)`);
    }
    if (r.userHooksReindexed.length > 0) {
      lines.push(`    ⚠ ${r.userHooksReindexed.length} hook(s) shared a group with forgen and moved (${r.userHooksReindexed.slice(0, 3).join(', ')}) — re-approve them in codex /hooks`);
    }
  }
  if (r.mcpRemoved) lines.push('  ✓ Removed forgen-compound MCP block from Codex config.toml');
  if (r.notifyRemoved) {
    lines.push(r.notifyChainRestored.length > 0
      ? `  ✓ Removed forgen notify wrapper from Codex config.toml — your chained notifier is kept: notify = ${JSON.stringify(r.notifyChainRestored)}`
      : '  ✓ Removed forgen notify block from Codex config.toml');
  }
  if (r.notifyCustomLeft) {
    lines.push('  ⚠ The forgen notify block in Codex config.toml was hand-edited (multi-line) — left in place. Remove the lines between the forgen-managed-notify markers yourself.');
  }
  if (r.skillsRemoved > 0) lines.push(`  ✓ Removed ${r.skillsRemoved} forgen skill(s) from ${path.join(r.codexHome, 'skills')}`);
  if (r.agentsRemoved > 0) lines.push(`  ✓ Removed ${r.agentsRemoved} ch-*.toml agent(s) from ${path.join(r.codexHome, 'agents')}`);
  if (r.agentsMdCleaned) {
    lines.push(`  ✓ Removed forgen block from ${r.agentsMdCleanedPaths.length} AGENTS.md file(s): ${r.agentsMdCleanedPaths.slice(0, 4).join(', ')}${r.agentsMdCleanedPaths.length > 4 ? ', …' : ''}`);
  }
  for (const e of r.errors) lines.push(`  ✗ Codex cleanup — ${e}`);
  return lines;
}
