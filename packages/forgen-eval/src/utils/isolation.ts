/**
 * eval/probe 하네스 → 하위 프로세스(claude -p / codex exec / forgen 훅) 격리.
 *
 * 문제(ADR-017 §9 D1 한계): 하네스가 띄운 자식 프로세스의 forgen 훅이 실 ~/.forgen 의
 * violations.jsonl 등에 비-uuid 합성 세션 기록을 남겨 실 집계를 오염시켰다.
 *
 * 규칙: 자식 env 는 항상 `evalChildEnv()` 를 거친다.
 *   - FORGEN_HOME = 프로세스당 1개의 mkdtemp 격리 디렉터리 (실 ~/.forgen 접근 차단)
 *   - FORGEN_SYNTHETIC=1 (격리가 뚫려도 기록에 synthetic:true → 집계 제외)
 * 예외: `--use-real-home` 인자 또는 FORGEN_EVAL_USE_REAL_HOME=1 일 때만 FORGEN_HOME 을 건드리지 않는다
 *       (경고 출력, FORGEN_SYNTHETIC 은 그대로 유지).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let isolatedHome: string | undefined;
let warned = false;

export function useRealHome(): boolean {
  return process.argv.includes('--use-real-home') || process.env.FORGEN_EVAL_USE_REAL_HOME === '1';
}

/** 프로세스당 한 번 생성되는 격리 FORGEN_HOME. */
export function getIsolatedForgenHome(): string {
  if (!isolatedHome) isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-eval-home-'));
  return isolatedHome;
}

/** 자식 프로세스용 env. extra 가 FORGEN_HOME 을 명시해도 real-home 플래그 없이는 격리값이 이긴다. */
export function evalChildEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra, FORGEN_SYNTHETIC: '1' };
  if (useRealHome()) {
    if (!warned) {
      warned = true;
      console.error('[forgen-eval] WARNING: --use-real-home — 하위 프로세스가 실 FORGEN_HOME 을 사용합니다 (기록은 synthetic 표시).');
    }
    return env;
  }
  env.FORGEN_HOME = getIsolatedForgenHome();
  return env;
}
