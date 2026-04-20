import * as os from 'node:os';
import * as path from 'node:path';

const HOME = os.homedir();

/** ~/.claude/ — Claude Code 설정 디렉토리 */
export const CLAUDE_DIR = path.join(HOME, '.claude');

/** ~/.claude/settings.json — Claude Code 설정 파일 */
export const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');


/** ~/.forgen/ — v1 하네스 홈 디렉토리 */
export const FORGEN_HOME = path.join(HOME, '.forgen');

/** ~/.forgen/me/ — 개인 공간 (v5.1: ~/.compound/ → ~/.forgen/ 통합) */
export const ME_DIR = path.join(FORGEN_HOME, 'me');

/** ~/.forgen/me/philosophy.json — 개인 철학 */
export const ME_PHILOSOPHY = path.join(ME_DIR, 'philosophy.json');

/** ~/.forgen/me/solutions/ — 개인 솔루션 */
export const ME_SOLUTIONS = path.join(ME_DIR, 'solutions');

/** ~/.forgen/me/behavior/ — 개인 행동 패턴 */
export const ME_BEHAVIOR = path.join(ME_DIR, 'behavior');

/** ~/.forgen/me/rules/ — 개인 규칙 */
export const ME_RULES = path.join(ME_DIR, 'rules');

/** ~/.forgen/me/skills/ — 개인 스킬 (promoted solutions) */
export const ME_SKILLS = path.join(ME_DIR, 'skills');

/** ~/.forgen/packs/ — 팀 팩 저장소 */
export const PACKS_DIR = path.join(FORGEN_HOME, 'packs');

/** ~/.forgen/handoffs/ — 세션 간 핸드오프 데이터 */
export const HANDOFFS_DIR = path.join(FORGEN_HOME, 'handoffs');

/** ~/.forgen/state/ — 상태 파일 디렉토리 */
export const STATE_DIR = path.join(FORGEN_HOME, 'state');

/**
 * ~/.forgen/state/match-eval-log.jsonl — JSONL ranking-decision log for the
 * bootstrap evaluator and offline matcher debugging. Written best-effort by
 * `src/engine/match-eval-log.ts`; never on the hook critical path.
 */
export const MATCH_EVAL_LOG_PATH = path.join(STATE_DIR, 'match-eval-log.jsonl');

/**
 * ~/.forgen/state/solution-quarantine.jsonl — JSONL log of solution files
 * dropped during index build due to malformed frontmatter. Append-only,
 * dedupe-by-path. Used by `forgen doctor` to surface dead solutions that
 * would otherwise vanish silently (see `diagnoseFrontmatter`).
 */
export const SOLUTION_QUARANTINE_PATH = path.join(STATE_DIR, 'solution-quarantine.jsonl');

/**
 * ~/.forgen/state/outcomes/ — per-session JSONL logs of solution inject →
 * outcome events (accept / correct / error / unknown). Written by the
 * solution-outcome-tracker hook. One file per session for write-safety
 * under concurrent sessions. Consumers aggregate across files to compute
 * fitness (see `solution-fitness.ts`).
 */
export const OUTCOMES_DIR = path.join(STATE_DIR, 'outcomes');

/**
 * ~/.forgen/lab/candidates/ — Phase 4 quarantine zone for evolver-agent
 * proposals before they enter the live solution index. The evolver writes
 * here; promotion and rollback commands move files out (to ME_SOLUTIONS
 * or to `lab/archived-{ts}/`). Keeping candidates isolated means a
 * runaway agent cannot silently poison the match pool.
 */
export const CANDIDATES_DIR = path.join(FORGEN_HOME, 'lab', 'candidates');

/** ~/.forgen/lab/archived/ — rollback destination for evolved solutions. */
export const ARCHIVED_DIR = path.join(FORGEN_HOME, 'lab', 'archived');

/** ~/.forgen/sessions/ — 세션 로그 */
export const SESSIONS_DIR = path.join(FORGEN_HOME, 'sessions');

/** ~/.forgen/config.json — 글로벌 설정 */
export const GLOBAL_CONFIG = path.join(FORGEN_HOME, 'config.json');

/** ~/.forgen/state/meta-learning/ — 메타학습 상태 파일 */
export const META_LEARNING_DIR = path.join(STATE_DIR, 'meta-learning');

/** ~/.forgen/lab/ — Lab 적응형 최적화 엔진 데이터 */
export const LAB_DIR = path.join(FORGEN_HOME, 'lab');

/** ~/.forgen/me/forge-profile.json — 글로벌 Forge 프로필 */
export const FORGE_PROFILE = path.join(ME_DIR, 'forge-profile.json');

/** ~/.forgen/me/recommendations/ — Pack Recommendation */
export const V1_RECOMMENDATIONS_DIR = path.join(ME_DIR, 'recommendations');

/** ~/.forgen/state/sessions/ — Session Effective State */
export const V1_SESSIONS_DIR = path.join(STATE_DIR, 'sessions');

/** ~/.forgen/state/raw-logs/ — Raw Log */
export const V1_RAW_LOGS_DIR = path.join(STATE_DIR, 'raw-logs');

// ── 레거시 ──

/** 모든 실행 모드 이름 (cancel/recovery 시 사용) */
export const ALL_MODES = [
  'ralph',
  'autopilot',
  'ultrawork',
  'team',
  'pipeline',
  'ccg',
  'ralplan',
  'deep-interview',
  'forge-loop',
  'ship',
  'retro',
  'learn',
  'calibrate',
] as const;

/** {repo}/.compound/ — 프로젝트 로컬 디렉토리 */
export function projectDir(cwd: string): string {
  return path.join(cwd, '.compound');
}

/** {repo}/.compound/pack.link — 팀 팩 연결 파일 */
export function packLinkPath(cwd: string): string {
  return path.join(projectDir(cwd), 'pack.link');
}

/** {repo}/.compound/philosophy.json — 프로젝트별 철학 */
export function projectPhilosophyPath(cwd: string): string {
  return path.join(projectDir(cwd), 'philosophy.json');
}

/** {repo}/.compound/forge-profile.json — 프로젝트별 Forge 프로필 */
export function projectForgeProfilePath(cwd: string): string {
  return path.join(projectDir(cwd), 'forge-profile.json');
}
