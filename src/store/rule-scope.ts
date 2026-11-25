/**
 * 룰의 프로젝트 범위.
 *
 * 프로젝트 안: 전역 룰 + 그 프로젝트 룰만 주입·강제한다. 다른 프로젝트 룰이 무관한 응답을 막던 오탐의 원인이다.
 * 프로젝트 밖(홈 디렉터리 등): 전역 룰과 범위 미정 룰만 준다. 프로젝트 룰은 작업이 그 프로젝트로 들어갈 때
 * 한 번 넣는다(project-switch.ts). 0.8.0 S5 에서 바뀜 — 예전에는 "전부 준다"였는데 활성 룰이 예산을 넘겨
 * 관련성과 무관하게 순위로 잘리는 것이 실측됐다(93개 중 53개 탈락).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Rule } from './types.js';
import { canonicalProjectKey, registryKeyFor } from './project-registry.js';

/**
 * cwd 의 프로젝트 키. 순서: 프로젝트 키 등록부(0.8.0 S3, git 아닌 폴더도 됨) → git 저장소 폴더 이름(소문자,
 * worktree 는 본 저장소 이름, 등록부의 별칭이면 그 키). 프로젝트가 아니면 null.
 */
export function projectKeyFor(cwd: string): string | null {
  let dir: string;
  try { dir = fs.realpathSync(cwd); } catch { dir = path.resolve(cwd); }
  try {
    const reg = registryKeyFor(dir);
    if (reg) return reg;
  } catch { /* 등록부 문제는 git 판정으로 */ }
  const git = gitProjectKey(dir);
  if (!git) return null;
  try { return canonicalProjectKey(git); } catch { return git; }
}

function gitProjectKey(dir: string): string | null {
  let home: string;
  try { home = fs.realpathSync(os.homedir()); } catch { home = os.homedir(); }
  for (let cur = dir; ; cur = path.dirname(cur)) {
    if (cur === home) return null; // 홈 자체가 git 저장소여도 프로젝트로 보지 않는다.
    const gitPath = path.join(cur, '.git');
    try {
      const st = fs.statSync(gitPath);
      if (st.isDirectory()) return path.basename(cur).toLowerCase();
      const match = /gitdir:\s*(.+)/.exec(fs.readFileSync(gitPath, 'utf-8'));
      const worktreeOf = match?.[1].trim().match(/(.+)[\\/]\.git[\\/]worktrees[\\/]/)?.[1];
      return path.basename(worktreeOf ?? cur).toLowerCase();
    } catch { /* 상위로 */ }
    if (cur === path.dirname(cur)) return null;
  }
}

function inProjects(projects: readonly string[], projectKey: string): boolean {
  if (projects.includes(projectKey)) return true;
  try { return projects.some((p) => canonicalProjectKey(p) === projectKey); } catch { return false; }
}

/** 범위를 정하지 못한 룰(0.8.0 S2). 주입은 하되 차단·판정에는 쓰지 않는다. */
export function isScopeUnresolved(rule: Pick<Rule, 'scope_state' | 'projects'>): boolean {
  return rule.scope_state === 'unresolved' && !rule.projects?.length;
}

/** 컨텍스트로 넣을 룰인가. */
export function appliesForContext(rule: Rule, projectKey: string | null): boolean {
  if (!rule.projects?.length) return true;
  if (projectKey === null) return false;
  return inProjects(rule.projects, projectKey);
}

/** 차단·판정까지 할 룰인가. 범위 미정 룰은 어디서도 차단하지 않는다. */
export function appliesForEnforcement(rule: Rule, projectKey: string | null): boolean {
  if (isScopeUnresolved(rule)) return false;
  if (!rule.projects?.length) return true;
  return projectKey !== null && inProjects(rule.projects, projectKey);
}

/**
 * 여러 룰을 하나로 합칠 때의 프로젝트 범위 (2026-11 재설계 D6-1).
 * 구성원 projects 의 합집합. 구성원 중 하나라도 전역(projects 없음)이면 결과도 전역(undefined).
 * 예전 병합 경로는 projects 를 아예 넘기지 않아 프로젝트 룰이 병합되면 전역 룰이 됐다.
 */
export function mergeRuleProjects(rules: Array<Pick<Rule, 'projects'>>): string[] | undefined {
  if (rules.length === 0) return undefined;
  const out = new Set<string>();
  for (const r of rules) {
    if (!r.projects?.length) return undefined;
    for (const p of r.projects) out.add(p);
  }
  return [...out].sort();
}
