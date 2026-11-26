/**
 * 0.9.1 #15 forgen doctor 작동 증명: 무해한 시험 입력을 실제 훅(dist/hooks)에 통과시켜 작동함·ms 를 보이고, 격리 홈만 쓴다.
 * dist 가 없으면(빌드 전) 건너뛴다.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runProofs } from '../src/core/doctor-proof.js';

const PKG = process.cwd();
const built = fs.existsSync(path.join(PKG, 'dist', 'hooks', 'pre-tool-use.js'));

describe.skipIf(!built)('doctor 작동 증명', () => {
  it('네 가지(세션 시작 넣기·교정 기록 보강·차단 룰·상황 맞춤 룰)가 작동하고, 임시 폴더는 남지 않는다', () => {
    const list = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('forgen-doctor-proof-'));
    const before = new Set(list());
    const proofs = runProofs(PKG);
    expect(proofs.map((p) => p.name)).toEqual(['세션 시작에 룰 넣기', '교정 기록 보강', '차단 룰', '상황 맞춤 룰']);
    for (const p of proofs) { expect(p.ok, `${p.name}: ${p.detail}`).toBe(true); expect(p.ms).toBeGreaterThan(0); }
    // 이번 실행이 만든 임시 홈은 남지 않는다(다른 프로세스의 것은 세지 않음)
    expect(list().filter((n) => !before.has(n))).toEqual([]);
  }, 60_000);
});
