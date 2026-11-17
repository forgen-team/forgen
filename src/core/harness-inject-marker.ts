/**
 * 래퍼(prepareHarness)가 이미 bootstrap 해서 inject_count 를 센 세션인지 판정 (2026-11 재설계 D8).
 *
 * 래퍼는 자식 런타임에 FORGEN_HARNESS_BOOTSTRAPPED=1 + FORGEN_SESSION_ID(래퍼 bootstrap 의 세션 ID)를 넘긴다.
 * 환경 변수는 그 claude 안에서 띄운 `claude -p`·Codex 같은 중첩 세션에도 상속되므로, 값만 보고 건너뛰면 중첩 세션이
 * 영원히 세지 않는다. 그래서 세션 ID 별 표식 파일을 'wx' 로 한 번만 만들 수 있게 하고, 처음 만든 SessionStart 만
 * 건너뛴다. 이후(중첩 세션, /clear 등)는 정상으로 센다.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { STATE_DIR } from './paths.js';

const DIR = path.join(STATE_DIR, 'harness-bootstrap');
const KEEP_MS = 7 * 86_400_000;

/** 이번 SessionStart 가 래퍼 bootstrap 과 같은 세션의 첫 시작이면 true (그때만 카운트를 건너뛴다). */
export function consumeHarnessBootstrap(env: NodeJS.ProcessEnv = process.env, now: number = Date.now()): boolean {
  if (env.FORGEN_HARNESS_BOOTSTRAPPED !== '1') return false;
  const sid = env.FORGEN_SESSION_ID;
  if (!sid || !/^[\w-]{8,64}$/.test(sid)) return false;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.closeSync(fs.openSync(path.join(DIR, sid), 'wx'));
  } catch {
    return false; // 이미 소비됨(중첩 세션 등) 또는 쓰기 실패 → 정상으로 센다
  }
  try {
    for (const f of fs.readdirSync(DIR)) {
      const p = path.join(DIR, f);
      if (now - fs.statSync(p).mtimeMs > KEEP_MS) fs.unlinkSync(p);
    }
  } catch { /* 정리 실패는 무시 */ }
  return true;
}
