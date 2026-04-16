import * as os from 'node:os';
import * as path from 'node:path';

const HOME = os.homedir();

/** ~/.claude/ — Claude Code 설정 디렉토리 */
export const CLAUDE_DIR = path.join(HOME, '.claude');
export const CODEX_DIR = path.join(HOME, '.codex');

/** ~/.claude/settings.json — Claude Code 설정 파일 */
export const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');

/**
 * ~/.compound/ — LEGACY harness home (pre-v5).
 *
 * @deprecated A5 (2026-04-09): this path must NEVER be used for WRITES.
 * It exists solely as the source path for `migrateToForgen()`.
 * All new writes must target `FORGEN_HOME`-based paths. Consumers that
 * read from this path should prefer the FORGEN_HOME equivalent first
 * and fall back here only during migration.
 *
 * Pre-A5, `harness.ts:ensureDirectories` and several hooks actively
 * created directories under this path, causing a dual-reality where
 * state could diverge between `~/.compound/` and `~/.forgen/` when the
 * migration symlink was broken (sudo install, SIP, CI, manual delete).
 */
export const COMPOUND_HOME = path.join(HOME, '.compound');

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

/** ~/.forgen/state/session-quality/ — 세션 품질 점수 */
export const SESSION_QUALITY_DIR = path.join(STATE_DIR, 'session-quality');

/** ~/.forgen/state/meta-learning/ — 메타학습 상태 파일 */
export const META_LEARNING_DIR = path.join(STATE_DIR, 'meta-learning');

/** ~/.forgen/lab/ — Lab 적응형 최적화 엔진 데이터 */
export const LAB_DIR = path.join(FORGEN_HOME, 'lab');

/** ~/.forgen/lab/events.jsonl — Lab 이벤트 로그 (JSONL) */
export const LAB_EVENTS = path.join(LAB_DIR, 'events.jsonl');

/** ~/.forgen/me/forge-profile.json — 글로벌 Forge 프로필 */
export const FORGE_PROFILE = path.join(ME_DIR, 'forge-profile.json');

// ── v1 호환 경로 (ME_*와 동일 — 점진 제거 예정) ──

/** @deprecated use ME_DIR */
export const V1_ME_DIR = ME_DIR;

/** @deprecated use FORGE_PROFILE */
export const V1_PROFILE = FORGE_PROFILE;

/** @deprecated use ME_RULES */
export const V1_RULES_DIR = ME_RULES;

/** @deprecated use ME_BEHAVIOR */
export const V1_EVIDENCE_DIR = ME_BEHAVIOR;

/** ~/.forgen/me/recommendations/ — Pack Recommendation */
export const V1_RECOMMENDATIONS_DIR = path.join(ME_DIR, 'recommendations');

/** @deprecated use ME_SOLUTIONS */
export const V1_SOLUTIONS_DIR = ME_SOLUTIONS;

/** @deprecated use STATE_DIR */
export const V1_STATE_DIR = STATE_DIR;

/** ~/.forgen/state/sessions/ — Session Effective State */
export const V1_SESSIONS_DIR = path.join(STATE_DIR, 'sessions');

/** ~/.forgen/state/raw-logs/ — Raw Log */
export const V1_RAW_LOGS_DIR = path.join(STATE_DIR, 'raw-logs');

/** @deprecated use GLOBAL_CONFIG */
export const V1_GLOBAL_CONFIG = GLOBAL_CONFIG;

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
