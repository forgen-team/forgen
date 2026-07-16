/**
 * forgen statusline — Claude Code statusLine 명령
 *
 * Claude Code는 statusLine.command를 주기적으로 호출하고 stdin에 JSON을 전달함.
 * 이 명령은 compact multi-line 형식으로 HUD 정보를 출력함.
 *
 * Line 1: 모델 | cwd | git branch
 * Line 2: (TODO: context/usage — stdin spec 미확인으로 생략)
 * Line 3: CLAUDE.md count | rules count | MCPs count | hooks count
 * Line 4: (TODO: tool counts — 추적 인프라 없음)
 * Line 5: (TODO: active task — 추적 인프라 없음)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { loadActiveRules } from '../store/rule-store.js';
import { STATE_DIR } from './paths.js';
import { classifySolutions } from './lifecycle-classifier.js';

// 0.4.6 perf #13 — statusline 출력을 5초 캐싱.
// claude statusLine 은 짧은 간격으로 재호출되는데 매번 git/find/rule-store 를
// 실행하면 ~100ms 누적. CACHE_TTL_MS 동안 동일 출력 재사용.
const STATUSLINE_CACHE_PATH = path.join(STATE_DIR, 'statusline-cache.txt');
const CACHE_TTL_MS = 5_000;

// ANSI codes
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

interface StdinPayload {
  model?: { display_name?: string };
  workspace?: { current_dir?: string };
  [key: string]: unknown;
}

function readStdinJson(): StdinPayload {
  // stdin이 TTY면 파이프 입력 없음 → 빈 payload로 fallback
  if (process.stdin.isTTY) return {};
  try {
    const raw = fs.readFileSync('/dev/stdin', 'utf-8').trim();
    if (!raw) return {};
    return JSON.parse(raw) as StdinPayload;
  } catch {
    return {};
  }
}

function getGitBranch(cwd: string): string {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    })
      .toString()
      .trim();
    const isDirty = (() => {
      try {
        const status = execSync('git status --porcelain', {
          cwd,
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 2000,
        }).toString().trim();
        return status.length > 0;
      } catch {
        return false;
      }
    })();
    return `git:(${branch}${isDirty ? '*' : ''})`;
  } catch {
    return '';
  }
}

function getSettingsJson(claudeDir: string): Record<string, unknown> {
  const settingsPath = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function countMcps(settings: Record<string, unknown>): number {
  const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
  if (!mcpServers || typeof mcpServers !== 'object') return 0;
  return Object.keys(mcpServers).length;
}

function countHooks(settings: Record<string, unknown>): number {
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks || typeof hooks !== 'object') return 0;
  return Object.values(hooks).reduce<number>((acc, matchers) => {
    if (!Array.isArray(matchers)) return acc;
    return acc + matchers.length;
  }, 0);
}

function countClaudeMd(cwd: string): number {
  try {
    const result = execSync('find . -maxdepth 2 -name CLAUDE.md', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).toString().trim();
    if (!result) return 0;
    return result.split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

function buildLine1(payload: StdinPayload, cwd: string): string {
  const modelName = payload.model?.display_name ?? 'Claude';
  const gitBranch = getGitBranch(cwd);
  const cwdDisplay = cwd.replace(os.homedir(), '~');
  const parts = [`${BOLD}${CYAN}${modelName}${RESET}`];
  parts.push(`${DIM}${cwdDisplay}${RESET}`);
  if (gitBranch) parts.push(`${GREEN}${gitBranch}${RESET}`);
  return parts.join(`  ${DIM}|${RESET}  `);
}

/** Build lifecycle line: "🔥X 🟡X 🥶X 💀X 🌱X" — P3 신설. 0건이면 null */
function buildLifecycleLine(): string | null {
  try {
    const classified = classifySolutions();
    if (classified.length === 0) return null;
    const counts = { hot: 0, warm: 0, cold: 0, dead: 0, new: 0 };
    for (const c of classified) counts[c.lifecycle]++;
    const total = counts.hot + counts.warm + counts.cold + counts.dead + counts.new;
    if (total === 0) return null;
    return [
      `${YELLOW}🔥${counts.hot}${RESET}`,
      `${YELLOW}🟡${counts.warm}${RESET}`,
      `${DIM}🥶${counts.cold}${RESET}`,
      `${DIM}💀${counts.dead}${RESET}`,
      `${DIM}🌱${counts.new}${RESET}`,
    ].join(`  `);
  } catch {
    return null;
  }
}

/**
 * ADR-010 W2-2: 사용량 세그먼트("📊 N/5h · N/wk") 제거 — native /usage 가
 * plan limit 를 정확히 분해한다. 이관 사실을 딱 1회만 공지 (state flag).
 */
function buildUsageLine(): string | null {
  try {
    const noticeFlag = path.join(STATE_DIR, 'usage-notice-shown');
    if (!fs.existsSync(noticeFlag)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(noticeFlag, new Date().toISOString());
      return `${DIM}ℹ 사용량 표시는 native /usage 로 이동했습니다 (이 안내는 1회만 표시)${RESET}`;
    }
    return null;
  } catch {
    return null;
  }
}

function buildLine3(claudeDir: string, cwd: string): string {
  const settings = getSettingsJson(claudeDir);
  const claudeMdCount = countClaudeMd(cwd);
  const rulesCount = (() => {
    try {
      return loadActiveRules().length;
    } catch {
      return 0;
    }
  })();
  const mcpCount = countMcps(settings);
  const hookCount = countHooks(settings);

  return [
    `${YELLOW}${claudeMdCount} CLAUDE.md${RESET}`,
    `${YELLOW}${rulesCount} rules${RESET}`,
    `${YELLOW}${mcpCount} MCPs${RESET}`,
    `${YELLOW}${hookCount} hooks${RESET}`,
  ].join(`  ${DIM}|${RESET}  `);
}

/** 0.4.6 perf #13: cached output if fresh. */
function readCacheIfFresh(): string | null {
  try {
    const stat = fs.statSync(STATUSLINE_CACHE_PATH);
    if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
      return fs.readFileSync(STATUSLINE_CACHE_PATH, 'utf-8');
    }
  } catch { /* no cache or stale */ }
  return null;
}

function writeCache(content: string): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATUSLINE_CACHE_PATH, content);
  } catch { /* fail-open */ }
}

export async function handleStatusline(): Promise<void> {
  // 캐시 hit 시 stdin payload 무시하고 바로 출력 (5초 윈도우 내 동일 출력 가정).
  // 라인 단위 cache → console.log 라인별 (테스트 호환).
  const cached = readCacheIfFresh();
  if (cached !== null) {
    for (const line of cached.split('\n').filter(Boolean)) console.log(line);
    return;
  }

  const payload = readStdinJson();
  const cwd = payload.workspace?.current_dir ?? process.cwd();
  const claudeDir = path.join(os.homedir(), '.claude');

  const line1 = buildLine1(payload, cwd);
  const line3 = buildLine3(claudeDir, cwd);
  const usageLine = buildUsageLine();
  const lifecycleLine = buildLifecycleLine();

  // Line 2 (context/usage): stdin JSON spec 미확인으로 생략 — TODO
  // Line 4 (tool counts): 추적 인프라 없음 — TODO
  // Line 5 (active task): 추적 인프라 없음 — TODO

  console.log(line1);
  console.log(line3);
  if (usageLine) console.log(usageLine);
  if (lifecycleLine) console.log(lifecycleLine);

  // W2-2: 1회 공지(usageLine)는 캐시에 넣지 않는다 — 캐시 재생 시
  // "1회만" 약속이 5초 창 동안 반복 위반되는 실측 버그 방지.
  const cacheLines = [line1, line3];
  if (lifecycleLine) cacheLines.push(lifecycleLine);
  const cacheBody = `${cacheLines.join('\n')}\n`;
  writeCache(cacheBody);
}
