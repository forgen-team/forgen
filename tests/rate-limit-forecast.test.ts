/**
 * ADR-017 D5 — 한도 소진 예측. 순수 함수 수학 + 숨김 조건 + 파일 내성.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({ TEST_HOME: `/tmp/forgen-test-rlf-${process.pid}` }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const {
  samplesFromPayload, currentWindowTail, estimateRate, forecastWindow, forecastAll,
  appendSamples, readSamples, compactSamples, fmtForecast, fmtClock,
  MIN_SAMPLES, MIN_SPAN_MS, MIN_RISE_PCT, SAMPLE_TTL_MS, COMPACT_MIN_BYTES,
} = await import('../src/core/rate-limit-forecast.js');

const MIN = 60_000;
const H = 3600_000;
const T0 = Date.parse('2026-10-06T12:00:00Z');
const reset = Math.floor((T0 + 2 * H) / 1000); // 14:00Z

function series(points: Array<[number, number]>, resets_at: number | null = reset) {
  return points.map(([minAgo, used]) => ({ t: T0 - minAgo * MIN, used, resets_at }));
}

describe('samplesFromPayload', () => {
  it('두 창 모두 숫자면 2개, null/비수치면 그 창은 생략', () => {
    expect(samplesFromPayload({ five_hour: { used_percentage: 63, resets_at: reset }, seven_day: { used_percentage: 21, resets_at: reset } }, T0)).toHaveLength(2);
    expect(samplesFromPayload({ five_hour: { used_percentage: null, resets_at: reset }, seven_day: { used_percentage: 21 } }, T0)).toEqual([{ w: 'seven_day', t: T0, used: 21, resets_at: null }]);
    expect(samplesFromPayload(undefined, T0)).toEqual([]);
    expect(samplesFromPayload({ five_hour: null }, T0)).toEqual([]);
  });
});

describe('currentWindowTail — 창 경계', () => {
  it('resets_at 이 바뀌면 그 이전 샘플을 버린다', () => {
    const s = [...series([[40, 80], [30, 90]], reset - 18000), ...series([[20, 5], [10, 10]], reset)];
    expect(currentWindowTail(s).map((x) => x.used)).toEqual([5, 10]);
  });
  it('사용률이 떨어지면(리셋) 그 이전 샘플을 버린다', () => {
    const s = series([[30, 70], [20, 80], [10, 3], [0, 6]], null);
    expect(currentWindowTail(s).map((x) => x.used)).toEqual([3, 6]);
  });
  it('정렬되지 않은 입력도 시간순 처리', () => {
    const s = series([[0, 30], [20, 10], [10, 20]]);
    expect(currentWindowTail(s).map((x) => x.used)).toEqual([10, 20, 30]);
  });
});

describe('estimateRate — 양끝점 기울기 + 숨김 조건 (critic SEV-1 반영)', () => {
  it(`샘플 < ${MIN_SAMPLES} 이면 null`, () => {
    expect(estimateRate(series([[20, 10], [0, 20]]), T0, 30 * MIN)).toBeNull();
  });
  it('시간 폭이 창별 최소(5h 15분 / 7d 2h) 미만이면 null', () => {
    expect(estimateRate(series([[10, 10], [5, 15], [0, 20]]), T0, 30 * MIN, 'five_hour')).toBeNull();
    expect(estimateRate(series([[20, 10], [10, 15], [0, 20]]), T0, 30 * MIN, 'five_hour')).not.toBeNull();
    expect(estimateRate(series([[60, 10], [30, 15], [0, 20]]), T0, 24 * H, 'seven_day')).toBeNull(); // 1h < 2h
    expect(estimateRate(series([[180, 10], [90, 15], [0, 20]]), T0, 24 * H, 'seven_day')).not.toBeNull();
  });
  it(`창 내 총 증가 < ${MIN_RISE_PCT}%p(양자화 잡음)면 null`, () => {
    expect(estimateRate(series([[20, 50], [10, 50.3], [0, 50.9]]), T0, 30 * MIN)).toBeNull();
  });
  it('lookback 밖 샘플은 무시', () => {
    expect(estimateRate(series([[90, 0], [10, 10], [0, 12]]), T0, 30 * MIN)).toBeNull();
  });
  it('등속 증가 → 정확한 기울기', () => {
    const r = estimateRate(series([[20, 10], [10, 20], [0, 30]]), T0, 30 * MIN)!;
    expect(r.rate * MIN).toBeCloseTo(1, 9); // 1%/min
    expect(r.n).toBe(3);
  });
  it('플래토 뒤 짧은 dt 의 점프 하나(계단 데이터)에서 과대 추정하지 않는다 — 양끝점이라 순서·간격 무관', () => {
    // 30분 정체(50%) 후 마지막 20초에 +1% → 진짜 추세 ≈ 2%/h
    const plateau = Array.from({ length: 10 }, (_, i) => [30 - i * 3, 50] as [number, number]);
    const s = [...series(plateau), { t: T0 - 20_000, used: 50, resets_at: reset }, { t: T0, used: 51, resets_at: reset }];
    const r = estimateRate(s, T0, 30 * MIN)!;
    expect(r.rate * H).toBeLessThanOrEqual(2.1); // ≤ 2%/h (이전 EMA 는 54.5%/h)
    // 같은 총량(+10%)이 처음에 오든 끝에 오든 같은 기울기
    const early = [...series([[30, 40]]), ...series([[29, 50], [15, 50], [0, 50]])];
    const late = [...series([[30, 40], [15, 40], [1, 40]]), ...series([[0, 50]])];
    expect(estimateRate(early, T0, 30 * MIN)!.rate).toBeCloseTo(estimateRate(late, T0, 30 * MIN)!.rate, 12);
  });
});

describe('forecastWindow', () => {
  it('리셋 전 소진: 1%/min, 70% → 30분 뒤 100%, 리셋은 2시간 뒤', () => {
    const f = forecastWindow('five_hour', series([[20, 50], [10, 60], [0, 70]]), T0, { t: T0, used: 70, resets_at: reset })!;
    expect(f.exhaustAt).toBeCloseTo(T0 + 30 * MIN, -2);
    expect(f.exhaustsBeforeReset).toBe(true);
    expect(f.projectedAtReset).toBe(100);
    expect(f.ratePerHour).toBeCloseTo(60, 6);
    expect(fmtForecast(f, T0)).toMatch(/^5h 70% → \d\d:\d\d 소진 \(리셋 \d\d:\d\d\)$/);
  });
  it('여유: 7d 창 3시간 동안 +18%(0.1%/min) → 리셋(2h) 시 22%', () => {
    const f = forecastWindow('seven_day', series([[180, -8], [90, 1], [0, 10]]), T0, { t: T0, used: 10, resets_at: reset })!;
    expect(f.exhaustsBeforeReset).toBe(false);
    expect(f.projectedAtReset).toBeCloseTo(22, 6);
    expect(fmtForecast(f, T0)).toMatch(/^7d 10% → 리셋 \d\d:\d\d 여유 \(예상 22%\)$/);
  });
  it('기울기 0 또는 음수 → 예측 숨김, 사용률만', () => {
    const f = forecastWindow('five_hour', series([[20, 40], [10, 40], [0, 40]]), T0, { t: T0, used: 40, resets_at: reset })!;
    expect(f.exhaustAt).toBeNull();
    expect(fmtForecast(f, T0)).toMatch(/^5h 40% \(리셋 \d\d:\d\d\)$/);
  });
  it('샘플 부족 → 예측 숨김', () => {
    const f = forecastWindow('five_hour', series([[0, 40]]), T0)!;
    expect(f.exhaustAt).toBeNull();
    expect(f.sampleCount).toBe(1);
  });
  it('샘플 없음 → null', () => {
    expect(forecastWindow('five_hour', [], T0)).toBeNull();
  });
  it('리셋 직후(사용률 하락) 이전 창 기울기를 쓰지 않는다', () => {
    const s = series([[40, 60], [30, 80], [20, 95], [5, 2], [0, 3]]);
    const f = forecastWindow('five_hour', s, T0, { t: T0, used: 3, resets_at: reset })!;
    expect(f.used).toBe(3);
    expect(f.exhaustAt).toBeNull(); // 새 창 샘플 2개뿐
  });
  it('표시 게이트(critic SEV-1): 현재 페이로드에 창이 없으면(null) 파일 샘플이 있어도 null', () => {
    expect(forecastWindow('five_hour', series([[20, 80], [10, 90], [0, 97]]), T0, null)).toBeNull();
  });
  it('resets_at 이 이미 지난 현재 샘플은 숨김(리셋 순간 CC 가 창을 drop 하기 전 값)', () => {
    const past = Math.floor((T0 - 60_000) / 1000);
    expect(forecastWindow('five_hour', series([[20, 80], [10, 90], [0, 97]], past), T0, { t: T0, used: 97, resets_at: past })).toBeNull();
  });
  it('현재 샘플이 파일에도 있으면(동일 t) 중복 집계하지 않는다', () => {
    const cur = { t: T0, used: 70, resets_at: reset };
    const f = forecastWindow('five_hour', [...series([[20, 50], [10, 60]]), cur], T0, cur)!;
    expect(f.sampleCount).toBe(3);
  });
});

describe('forecastAll', () => {
  it('창별로 분리해 계산', () => {
    const all = [
      ...series([[20, 50], [10, 60], [0, 70]]).map((s) => ({ ...s, w: 'five_hour' as const })),
      ...series([[0, 20]]).map((s) => ({ ...s, w: 'seven_day' as const })),
    ];
    const r = forecastAll(all, T0);
    expect(r.five_hour?.exhaustAt).not.toBeNull();
    expect(r.seven_day?.exhaustAt).toBeNull();
  });
  it('current 가 주어지면 그 안에 있는 창만 출력 — 파일에 7d 샘플이 있어도 페이로드에 없으면 생략', () => {
    const all = [
      ...series([[20, 50], [10, 60], [0, 70]]).map((s) => ({ ...s, w: 'five_hour' as const })),
      ...series([[0, 20]]).map((s) => ({ ...s, w: 'seven_day' as const })),
    ];
    const r = forecastAll(all, T0, [{ w: 'five_hour', t: T0, used: 70, resets_at: reset }]);
    expect(r.five_hour).toBeDefined();
    expect(r.seven_day).toBeUndefined();
    expect(forecastAll(all, T0, [])).toEqual({});
  });
});

describe('fmtClock', () => {
  it('다음날이면 D+1 접두', () => {
    const now = new Date(2026, 9, 6, 23, 0).getTime();
    expect(fmtClock(now + 2 * H, now)).toBe('D+1 01:00');
    expect(fmtClock(now + 30 * MIN, now)).toBe('23:30');
  });
});

describe('샘플 파일 — 잘린 줄 내성 · TTL', () => {
  it('append → read 왕복, 잘린 줄·비정상 줄 무시, TTL 초과 제거', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-rlf-'));
    const p = path.join(dir, 'samples.jsonl');
    appendSamples([{ w: 'five_hour', t: T0, used: 10, resets_at: reset }], p);
    fs.appendFileSync(p, '{"w":"five_hour","t":1,"us'); // 취소로 잘린 줄
    fs.appendFileSync(p, '\nnot json\n');
    appendSamples([{ w: 'seven_day', t: T0 - SAMPLE_TTL_MS - 1, used: 5, resets_at: null }], p); // TTL 초과
    appendSamples([{ w: 'seven_day', t: T0, used: 6, resets_at: null }], p);
    const got = readSamples(p, T0);
    expect(got.map((s) => [s.w, s.used])).toEqual([['five_hour', 10], ['seven_day', 6]]);
    // 가드: 작은 파일/최근 수정은 압축하지 않는다(동시 append 유실 방지). force 로만 압축.
    expect(compactSamples(p, T0)).toBe(false);
    expect(fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).length).toBeGreaterThan(2);
    expect(compactSamples(p, T0, true)).toBe(true);
    expect(fs.readFileSync(p, 'utf-8').trim().split('\n')).toHaveLength(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  it('파일 없음 → []', () => {
    expect(readSamples('/nonexistent/x.jsonl', T0)).toEqual([]);
  });
  it(`큰 파일(≥${COMPACT_MIN_BYTES}B)이라도 60초 내 수정이면 압축 안 함, 조용하면 압축`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-rlf-'));
    const p = path.join(dir, 's.jsonl');
    const line = JSON.stringify({ w: 'five_hour', t: Date.now() - SAMPLE_TTL_MS - 1, used: 1, resets_at: null }); // 실제 now 기준 TTL 초과
    fs.writeFileSync(p, `${Array.from({ length: Math.ceil(COMPACT_MIN_BYTES / (line.length + 1)) + 1 }, () => line).join('\n')}\n`);
    expect(compactSamples(p, Date.now())).toBe(false); // 방금 수정
    const quiet = (Date.now() - 120_000) / 1000;
    fs.utimesSync(p, quiet, quiet);
    expect(compactSamples(p, Date.now())).toBe(true);
    expect(fs.readFileSync(p, 'utf-8')).toBe('');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('여러 세션 샘플이 섞여도 현재 창만으로 예측 (실사용 관측 회귀)', () => {
  it('다른 resets_at(오래된 세션) 샘플이 사이사이 끼어도 현재 창 기울기를 낸다', () => {
    const cur = series([[20, 50], [10, 60], [0, 70]]);
    const stale = [
      { t: T0 - 15 * MIN, used: 100, resets_at: Math.floor(Date.parse('2026-07-16T09:30:00Z') / 1000) },
      { t: T0 - 5 * MIN, used: 14, resets_at: Math.floor(Date.parse('2026-07-02T10:10:00Z') / 1000) },
    ];
    const mixed = [...cur, ...stale].sort((a, b) => a.t - b.t);
    const f = forecastWindow('five_hour', mixed, T0, { t: T0, used: 70, resets_at: reset })!;
    expect(f.exhaustAt).not.toBeNull();
    expect(f.ratePerHour).toBeCloseTo(60, 6);
    expect(f.sampleCount).toBe(3);
  });
});
