/**
 * 쿼리 측 맥락 신호 — 프롬프트 밖에서 얻는 보조 토큰 (ADR-017 §1.5a).
 *
 * 회화체 프롬프트는 주제어가 거의 없어("이거 왜 안 돼?") 솔루션 태그와 안 겹친다. 그래서 (a) 현재 프로젝트명
 * (b) 이 세션에서 최근 편집한 파일 경로의 의미 토큰을 보조 신호로 쓴다.
 *
 * 불변식 (오주입 방지가 우선):
 *   - 맥락 토큰은 프롬프트 토큰과 분리해 다룬다(ranking-pipeline 에서 태그당 0.1·상한 0.2 의 순위 가산(게이트 불변), 프롬프트 매칭 ≥1 필수).
 *   - 도구 이름은 쓰지 않는다(Edit/Bash 등 공통어라 오염).
 *   - 경로의 범용 이름(src, dist, index, test …)과 확장자는 버린다.
 *   - 전부 fail-open: 상태 파일이 없거나 깨져도 빈 배열.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR } from '../core/paths.js';
import { sanitizeId } from '../hooks/shared/sanitize-id.js';
import { EN_STOPWORDS } from './solution-format.js';

const MAX_RECENT_FILES = 8;
const MAX_CONTEXT_TOKENS = 24;
const MIN_TOKEN_LEN = 3;

/** 경로 구성요소 중 의미 없는 범용 이름 */
const GENERIC_PATH_TOKENS = new Set<string>([
  'src', 'dist', 'lib', 'bin', 'build', 'out', 'index', 'main', 'app', 'test', 'tests', 'spec', 'specs',
  'util', 'utils', 'common', 'shared', 'types', 'type', 'core', 'node_modules', 'home', 'ubuntu', 'users',
  'workspace', 'tmp', 'var', 'usr', 'opt', 'claude', 'worktrees', 'agent', 'readme', 'package', 'json',
  'config', 'default', 'base', 'helper', 'helpers', 'file', 'files', 'data', 'state', 'docs', 'doc',
]);

/** 'a-b_c.ts', 'FooBar' → ['a','b','c'], ['foo','bar'] 로 쪼갠다. 한글은 그대로 둔다. */
function splitWords(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9가-힣]+/)
    .filter(Boolean);
}

function usable(tok: string): boolean {
  const isKo = /[가-힣]/.test(tok);
  if (tok.length < (isKo ? 2 : MIN_TOKEN_LEN)) return false;
  if (/^\d+$/.test(tok)) return false;
  return !GENERIC_PATH_TOKENS.has(tok) && !EN_STOPWORDS.has(tok);
}

/** 한 경로 구성요소 → 토큰. 하이픈 복합어(solution-injector)는 복합형도 함께 남긴다. */
function segmentTokens(segment: string): string[] {
  const out = splitWords(segment).filter(usable);
  const hyphen = segment.toLowerCase().replace(/_/g, '-');
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(hyphen) && !GENERIC_PATH_TOKENS.has(hyphen)) out.push(hyphen);
  return out;
}

/** cwd → 프로젝트 이름. 워크트리(.claude/worktrees/x)면 그 앞의 리포 디렉터리를 쓴다. */
export function projectNameFromCwd(cwd: string): string {
  const idx = cwd.indexOf(`${path.sep}.claude${path.sep}worktrees${path.sep}`);
  const root = idx > 0 ? cwd.slice(0, idx) : cwd;
  return path.basename(root);
}

/** 순수 함수: cwd + 최근 파일 경로(최신순) → 맥락 토큰(중복 제거, 상한 적용). */
export function contextTokensFromPaths(cwd: string, recentFiles: readonly string[]): string[] {
  const seen = new Set<string>();
  const add = (toks: string[]) => { for (const t of toks) seen.add(t); };

  add(segmentTokens(projectNameFromCwd(cwd)));

  for (const file of recentFiles.slice(0, MAX_RECENT_FILES)) {
    const inCwd = path.isAbsolute(file) && file.startsWith(cwd + path.sep);
    const rel = inCwd ? path.relative(cwd, file) : file;
    const segs = rel.split(/[\\/]/).filter(Boolean);
    // cwd 밖 절대경로는 홈/시스템 경로가 섞이므로 파일명 + 바로 위 디렉터리만 쓴다.
    const used = !inCwd && path.isAbsolute(file) ? segs.slice(-2) : segs;
    used.forEach((seg, i) => {
      const isFile = i === used.length - 1;
      add(segmentTokens(isFile ? seg.replace(/\.[A-Za-z0-9]+$/, '') : seg));
    });
  }
  return [...seen].slice(0, MAX_CONTEXT_TOKENS);
}

/** 세션의 modified-files 상태에서 최근 편집 파일(최신순). 없으면 []. */
export function recentModifiedFiles(sessionId: string | undefined): string[] {
  if (!sessionId) return [];
  try {
    const p = path.join(STATE_DIR, `modified-files-${sanitizeId(sessionId)}.json`);
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      files?: Record<string, { lastModified?: string }>;
    };
    return Object.entries(data.files ?? {})
      .sort((a, b) => (b[1]?.lastModified ?? '').localeCompare(a[1]?.lastModified ?? ''))
      .map(([f]) => f);
  } catch {
    return [];
  }
}

/** 훅 진입점: 맥락 토큰 산출. fail-open. */
export function buildContextTokens(cwd: string, sessionId: string | undefined): string[] {
  try {
    return contextTokensFromPaths(cwd, recentModifiedFiles(sessionId));
  } catch {
    return [];
  }
}
