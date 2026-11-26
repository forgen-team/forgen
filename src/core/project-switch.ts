/**
 * 위치 전환 주입 (0.8.0 S5).
 *
 * 세션이 프로젝트 밖(홈·상위 폴더)에서 시작되면 세션 시작 블록에는 전역·미정 룰과 프로젝트별 색인 한 줄만 들어간다.
 * 작업이 어떤 프로젝트 안으로 들어가는 순간(폴더 이동, 그 프로젝트 파일을 만짐) 그 프로젝트 룰을 **한 번** 넣는다.
 * 고르는 기준은 위치라는 사실뿐이다 — 프롬프트 유사도로 룰을 고르지 않는다(11-17 §6 유지).
 */
import * as path from 'node:path';
import type { Rule } from '../store/types.js';
import { loadActiveRules } from '../store/rule-store.js';
import { projectKeyFor, appliesForContext } from '../store/rule-scope.js';
import { canonicalProjectKey } from '../store/project-registry.js';
import { byPriority, ruleToText } from '../renderer/rule-renderer.js';
import { addSessionRules, markProjectInjected } from './session-context.js';
import { appendSessionRender } from './session-renders.js';

const SWITCH_BUDGET_CHARS = 4000;
const NO_PROJECT = '-';

function projectRulesFor(key: string): Rule[] {
  return loadActiveRules().filter((r) => r.scope === 'me' && r.projects?.length && appliesForContext(r, key)).sort(byPriority);
}

/** 프로젝트 밖에서 시작한 세션 블록에 붙일 색인. 프로젝트 룰이 하나도 없으면 null. */
export function projectRuleIndex(): string | null {
  const counts = new Map<string, number>();
  for (const r of loadActiveRules()) {
    if (r.scope !== 'me' || !r.projects?.length) continue;
    for (const k of new Set(r.projects.map((p) => { try { return canonicalProjectKey(p); } catch { return p; } }))) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const list = [...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ');
  return `## Project Rules\n- Not loaded here (this session started outside a project): ${list}. Each project's rules are added once when you start working in that project's folder.`;
}

/** 세션 시작(또는 압축 뒤 재시작) 때 이번 블록이 어느 프로젝트 기준인지 기록한다. */
export function markSessionStartScope(sessionId: string | undefined, cwd: string | undefined, ruleIds: string[] = []): void {
  if (!sessionId || !cwd || !path.isAbsolute(cwd)) return;
  const project = projectKeyFor(cwd);
  markProjectInjected(sessionId, project ?? NO_PROJECT, { reset: true, cwd, ruleIds });
  // 0.9.0: 지워지지 않는 세션별 렌더 기록 — 감사(audit recurrence)의 "실렸는가" 근거
  appendSessionRender({ session: sessionId, event: 'start', cwd, project, ruleIds });
}

/**
 * 지금 위치(cwd 또는 만진 파일)의 프로젝트 룰을 이 세션에서 아직 안 넣었으면 블록을 돌려주고 넣었다고 적는다.
 * 넣을 룰이 없어도 "넣음"으로 적는다(같은 프로젝트에서 매번 다시 보지 않게).
 */
export function projectSwitchContext(sessionId: string | undefined, where: string | undefined): string | null {
  if (!sessionId || !where || !path.isAbsolute(where)) return null;
  const key = projectKeyFor(where);
  if (!key) return null;
  if (!markProjectInjected(sessionId, key)) return null;
  const rules = projectRulesFor(key);
  if (rules.length === 0) return null;
  const lines: string[] = [];
  const ids: string[] = [];
  let used = 0; let omitted = 0;
  let strong = false;
  for (const r of rules) {
    // 0.9.0 압축 형식(세션 시작 블록과 같은 모양): 이 프로젝트 태그·분류 접두·날짜 꼬리 없음, strong 은 `! `.
    const line = `- ${ruleToText(r, { compact: true, projectKey: key })}`;
    if (used + line.length + 1 > SWITCH_BUDGET_CHARS) { omitted++; continue; }
    lines.push(line); ids.push(r.rule_id); used += line.length + 1;
    if (r.strength === 'strong') strong = true;
  }
  addSessionRules(sessionId, ids);
  if (ids.length) appendSessionRender({ session: sessionId, event: 'switch', cwd: where, project: key, ruleIds: ids });
  const tail = omitted ? `\n- ${omitted} more omitted (budget). List: forgen rule list` : '';
  return `<forgen-rules project="${key}">\nYou are now working in project "${key}". These are this user's rules for it, in addition to the rules given at session start${strong ? ' (! = strong preference)' : ''}:\n${lines.join('\n')}${tail}\n</forgen-rules>`;
}
