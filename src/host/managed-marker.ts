/**
 * forgen-managed 소유 판정 — install/uninstall 공용.
 *
 * "이 파일을 forgen 이 썼는가" 를 잘못 판정하면 사용자 파일을 덮어쓰거나 지운다. 그래서 마커가 *정해진
 * 위치* 에 있을 때만 forgen 소유로 본다 (본문에 마커 문자열을 인용한 사용자 파일과 구분).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const SKILL_MARKER = '<!-- forgen-managed -->';
const AGENT_TOML_MARKER = '# forgen-managed';

/**
 * SKILL.md: frontmatter(`---` … 첫 번째 닫는 `---`) **바로 뒤** 에 마커가 있어야 한다.
 * (이전의 lazy 정규식은 본문의 `---` 구분선 뒤에 나오는 마커까지 매치했다 — critic 2026-10-02.)
 */
export function hasManagedSkillMarker(content: string): boolean {
  const text = content.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return false;
  const close = text.indexOf('\n---\n', 3);
  if (close === -1) return false;
  return text.slice(close + 5).trimStart().startsWith(SKILL_MARKER);
}

/** Codex agent TOML: 첫 줄이 정확히 마커여야 한다 (`# forgen-managed-by-me` 같은 접두 일치는 사용자 파일). */
export function isManagedAgentToml(content: string): boolean {
  return content.split('\n', 1)[0].replace(/\r$/, '') === AGENT_TOML_MARKER;
}

/**
 * 패키지가 실제로 제공하는 dev-guide 스킬 이름 (`forgen-<stack>-<skill>`).
 * uninstall 은 이름 패턴이 아니라 이 목록으로 소유를 판정한다 — 사용자가 만든 `forgen-react-mine` 을 지우지 않게.
 */
export function listDevGuideSkillNames(pkgRoot: string): Set<string> {
  const names = new Set<string>();
  const root = path.join(pkgRoot, 'assets', 'dev-guide');
  try {
    for (const tier of fs.readdirSync(root)) {
      const skillsBase = path.join(root, tier, 'skills');
      if (!fs.existsSync(skillsBase)) continue;
      for (const stack of fs.readdirSync(skillsBase)) {
        const stackDir = path.join(skillsBase, stack);
        if (!fs.statSync(stackDir).isDirectory()) continue;
        for (const skill of fs.readdirSync(stackDir)) {
          if (fs.existsSync(path.join(stackDir, skill, 'SKILL.md'))) names.add(`forgen-${stack}-${skill}`);
        }
      }
    }
  } catch { /* 자산 없음 */ }
  return names;
}

/**
 * `<skillsDir>/<name>/SKILL.md` 한 개를 제거하고 디렉토리가 비면 디렉토리도 지운다.
 * 사용자가 그 디렉토리에 다른 파일을 넣어 뒀으면 디렉토리는 남는다. 실제로 SKILL.md 를 지웠을 때만 true.
 */
export function removeSkillFile(skillsDir: string, name: string, dryRun: boolean): boolean {
  const dir = path.join(skillsDir, name);
  const file = path.join(dir, 'SKILL.md');
  try {
    if (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory()) return false;
    fs.lstatSync(file); // 없으면 throw
    if (dryRun) return true;
    fs.unlinkSync(file);
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* ignore */ }
    return true;
  } catch {
    return false;
  }
}

/**
 * `<skillsDir>` 아래에서 forgen 이 설치한 dev-guide 스킬 디렉토리 이름을 고른다 (ADR-016 0.5.9).
 *
 * 이전의 stale 정리는 이름 패턴(`forgen-*`)만 보고 디렉토리를 재귀 삭제해 사용자가 만든 `forgen-notes`,
 * `forgen-react-mine` 까지 지웠다. 소유 근거는 둘 중 하나여야 한다:
 *   (a) 패키지가 현재 제공하는 이름, 또는
 *   (b) SKILL.md 가 `…/assets/dev-guide/…` 를 가리키는 심링크 — 이전 버전이 설치한 것 (대상이 사라진
 *       dangling 링크여도 링크 문자열로 판정).
 */
export function listOwnedDevGuideSkillDirs(skillsDir: string, pkgRoot: string): string[] {
  const known = listDevGuideSkillNames(pkgRoot);
  let entries: string[];
  try { entries = fs.readdirSync(skillsDir); } catch { return []; }
  return entries.filter((name) => {
    if (!name.startsWith('forgen-')) return false;
    if (known.has(name)) return true;
    try {
      const target = fs.readlinkSync(path.join(skillsDir, name, 'SKILL.md'));
      return /[\\/]assets[\\/]dev-guide[\\/]/.test(target);
    } catch {
      return false; // 심링크가 아님 = 사용자가 쓴 파일이거나 없음
    }
  });
}

/** install 의 stale 정리: forgen 소유 dev-guide 스킬의 SKILL.md 만 지운다. 반환: 지운 수. */
export function removeOwnedDevGuideSkills(skillsDir: string, pkgRoot: string, dryRun = false): number {
  let removed = 0;
  for (const name of listOwnedDevGuideSkillDirs(skillsDir, pkgRoot)) {
    if (removeSkillFile(skillsDir, name, dryRun)) removed += 1;
  }
  return removed;
}
