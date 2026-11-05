/**
 * 룰의 프로젝트 범위.
 *
 * 프로젝트 안: 전역 룰 + 그 프로젝트 룰만 주입·강제한다. 다른 프로젝트 룰이 무관한 응답을 막던 오탐의 원인이다.
 * 프로젝트 밖(홈 디렉터리 등): 어떤 작업인지 알 수 없으니 전부 컨텍스트로 주되, 프로젝트 룰로 차단하지는 않는다.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Rule } from './types.js';

/** cwd 의 프로젝트 키: git 저장소 폴더 이름(소문자). worktree 는 본 저장소 이름. 프로젝트가 아니면 null. */
export function projectKeyFor(cwd: string): string | null {
  let dir: string;
  try { dir = fs.realpathSync(cwd); } catch { dir = path.resolve(cwd); }
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

/** 컨텍스트로 넣을 룰인가. */
export function appliesForContext(rule: Rule, projectKey: string | null): boolean {
  if (!rule.projects?.length || projectKey === null) return true;
  return rule.projects.includes(projectKey);
}

/** 차단·판정까지 할 룰인가. */
export function appliesForEnforcement(rule: Rule, projectKey: string | null): boolean {
  if (!rule.projects?.length) return true;
  return projectKey !== null && rule.projects.includes(projectKey);
}
