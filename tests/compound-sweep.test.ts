import { describe, it, expect } from 'vitest';
import { selectSweepCandidates, DEFAULT_SWEEP_OPTS, buildCronLine, upsertCronText, type TranscriptMeta } from '../src/core/compound-sweep-cli.js';
import { effectiveCooldownMs } from '../src/hooks/context-guard.js';

const NOW = 1_700_000_000_000;
const H = 3600_000;
function meta(id: string, ageH: number, prompts: number): TranscriptMeta {
  return { sessionId: id, transcriptPath: `/t/${id}.jsonl`, cwd: '/w', mtimeMs: NOW - ageH * H, promptCount: prompts };
}
const opts = { nowMs: NOW, ...DEFAULT_SWEEP_OPTS };

describe('selectSweepCandidates (ADR-011 compound backstop)', () => {
  it('창(24h) 밖 transcript 제외', () => {
    const r = selectSweepCandidates([meta('old', 30, 50)], {}, opts);
    expect(r).toHaveLength(0);
  });

  it('promptCount < 최소(10) 제외', () => {
    const r = selectSweepCandidates([meta('thin', 1, 5)], {}, opts);
    expect(r).toHaveLength(0);
  });

  it('최근(2h 내) sweep 된 세션 제외, stale 은 포함', () => {
    const items = [meta('fresh', 1, 20), meta('stale', 1, 20)];
    const state = { fresh: { sweptAt: NOW - 1 * H }, stale: { sweptAt: NOW - 5 * H } };
    const r = selectSweepCandidates(items, state, opts);
    expect(r.map((c) => c.sessionId)).toEqual(['stale']);
  });

  it('한 번도 안 쓸린 세션 포함', () => {
    const r = selectSweepCandidates([meta('new', 1, 20)], {}, opts);
    expect(r.map((c) => c.sessionId)).toEqual(['new']);
  });

  it('oldest-swept 우선 정렬', () => {
    const items = [meta('a', 1, 20), meta('b', 1, 20), meta('c', 1, 20)];
    const state = { a: { sweptAt: NOW - 3 * H }, b: { sweptAt: NOW - 10 * H } }; // c: 미swept(=0, 최우선)
    const r = selectSweepCandidates(items, state, opts);
    expect(r.map((c) => c.sessionId)).toEqual(['c', 'b', 'a']);
  });

  it('maxPerRun 상한', () => {
    const items = Array.from({ length: 12 }, (_, i) => meta(`s${i}`, 1, 20));
    const r = selectSweepCandidates(items, {}, { ...opts, maxPerRun: 5 });
    expect(r).toHaveLength(5);
  });

  it('maxPerRun 0 이면 빈 결과', () => {
    expect(selectSweepCandidates([meta('x', 1, 20)], {}, { ...opts, maxPerRun: 0 })).toHaveLength(0);
  });
});

describe('cron 헬퍼 (ADR-011 자동설치)', () => {
  it('buildCronLine: 스케줄 + node + cli + sweep + 로그 + 마커 (경로 shell-quote)', () => {
    const line = buildCronLine('/usr/bin/node', '/pkg/dist/cli.js', '/log/sweep.log');
    expect(line).toContain("'/usr/bin/node' '/pkg/dist/cli.js' compound sweep");
    expect(line).toContain(">> '/log/sweep.log' 2>&1");
    expect(line).toContain('# forgen-compound-sweep');
    expect(line.startsWith('17 * * * *')).toBe(true);
  });

  it('buildCronLine: 공백/메타문자 경로 안전 quote (injection 방지)', () => {
    const line = buildCronLine('/opt/my node/bin/node', "/x/a'b/cli.js", '/l/s p.log');
    // 공백 경로가 quote 안에 → word-split 안 됨
    expect(line).toContain("'/opt/my node/bin/node'");
    // single-quote 이스케이프
    expect(line).toContain("'/x/a'\\''b/cli.js'");
    expect(line).toContain("'/l/s p.log'");
  });

  it('upsertCronText: 신규 추가', () => {
    const out = upsertCronText('0 6 * * * other-job\n', 'LINE # forgen-compound-sweep (ADR-011)');
    expect(out).toContain('other-job');
    expect(out).toContain('LINE # forgen-compound-sweep');
  });

  it('upsertCronText: 멱등 — 기존 forgen 라인 교체(중복 안 함)', () => {
    const existing = 'other\nOLD # forgen-compound-sweep (ADR-011)\n';
    const out = upsertCronText(existing, 'NEW # forgen-compound-sweep (ADR-011)');
    expect(out).not.toContain('OLD');
    expect(out.match(/forgen-compound-sweep/g)).toHaveLength(1);
    expect(out).toContain('other');
  });

  it('upsertCronText: 제거(line=null) — forgen 라인만 삭제, 타 job 보존', () => {
    const out = upsertCronText('keep-me\nX # forgen-compound-sweep (ADR-011)\n', null);
    expect(out).toContain('keep-me');
    expect(out).not.toContain('forgen-compound-sweep');
  });
});

describe('barren backoff 성장 예외 (ADR-011 B수정)', () => {
  const BARREN = 30 * 60 * 1000;
  const NORMAL = 5 * 60 * 1000;
  it('barren(0건) + 세션 미성장 → barren cooldown 유지', () => {
    expect(effectiveCooldownMs({ extractedSolutions: 0, promptCount: 20 }, 22)).toBe(BARREN);
  });
  it('barren(0건) + 세션 성장(≥5) → 정상 cooldown(재추출 허용)', () => {
    expect(effectiveCooldownMs({ extractedSolutions: 0, promptCount: 20 }, 26)).toBe(NORMAL);
  });
  it('추출 성과 있으면 성장과 무관하게 정상 cooldown', () => {
    expect(effectiveCooldownMs({ extractedSolutions: 2, promptCount: 20 }, 20)).toBe(NORMAL);
  });
});
