/**
 * forgen statusline — ADR-017 D4/D5 2줄 재설계 검증
 *
 * 공식 stdin 스키마의 샘플 페이로드로 렌더 → 세그먼트 유무·색·생략 규칙·세션별 캐시·샘플 기록을 확인.
 * 격리 HOME (vi.mock node:os). git/execSync 는 mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const TEST_HOME = `/tmp/forgen-statusline-test-${process.pid}`;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: (cmd: string) => {
      if (cmd.includes('git rev-parse')) return Buffer.from('main');
      if (cmd.includes('git status --porcelain')) return Buffer.from(' M x');
      return Buffer.from('');
    },
  };
});

vi.mock('../src/store/rule-store.js', () => ({
  loadActiveRules: () => Array.from({ length: 8 }, (_, i) => ({ rule_id: `r${i}`, status: 'active' })),
  loadAllRules: () => [],
}));

const { renderStatusline, buildUserLine, cachePathFor, handleStatuslineWith } = await import('../src/core/statusline-cli.js');
const { STATE_DIR } = await import('../src/core/paths.js');
const { appendSamples, SAMPLES_PATH, SAMPLE_TTL_MS, COMPACT_MIN_BYTES } = await import('../src/core/rate-limit-forecast.js');

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const NOW = Date.parse('2026-10-06T12:00:00Z');
const reset = Math.floor((NOW + 2 * 3600_000) / 1000);

const fullPayload = {
  session_id: 'sess-A',
  model: { id: 'claude-fable-5-1', display_name: 'Fable' },
  workspace: { current_dir: `${TEST_HOME}/workspace/forgen` },
  context_window: { context_window_size: 1_000_000, used_percentage: 42, remaining_percentage: 58 },
  rate_limits: { five_hour: { used_percentage: 63, resets_at: reset }, seven_day: { used_percentage: 21, resets_at: reset + 86400 } },
  cost: { total_cost_usd: 1.234, total_duration_ms: 100 },
};

describe('statusline 2줄 렌더', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(path.join(STATE_DIR, 'enforcement'), { recursive: true });
  });
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('정확히 2줄: 1줄 사용자(모델·경로·ctx·한도·비용), 2줄 forgen(룰·세션 차단·7d 차단·surfaced)', () => {
    const lines = renderStatusline(fullPayload, NOW).map(strip);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Fable · ~\/workspace\/forgen\(main\*\) · ctx 42%\/1M · 5h 63% \(리셋 \d\d:\d\d\) · 7d 21% \(리셋 D\+1 \d\d:\d\d\) · \$1\.23$/);
    expect(lines[1]).toMatch(/^룰 8 · 이 세션 차단 0 · 7d 차단 0 · surfaced 0$/);
  });

  it('운영자 지표(recall/ROI/이모지/CLAUDE.md/MCPs/hooks)는 더 이상 statusline 에 없다', () => {
    const all = renderStatusline(fullPayload, NOW).map(strip).join('\n');
    for (const bad of ['recall', 'ROI', 'CLAUDE.md', 'MCPs', 'hooks', '🔥', '✦', 'native /usage']) expect(all).not.toContain(bad);
  });

  it('데이터 없는 세그먼트는 생략 — 빈 페이로드는 모델/경로만', () => {
    const line = strip(buildUserLine({}, `${TEST_HOME}/x`, {}, NOW));
    expect(line).toBe('Claude · ~/x(main*)');
  });

  it('rate_limits 부재(API 키 사용자)·used_percentage null 이면 한도 세그먼트 생략 — 파일에 옛 샘플이 있어도 (critic SEV-1)', () => {
    const MIN = 60_000;
    appendSamples([
      { w: 'five_hour', t: NOW - 20 * MIN, used: 80, resets_at: reset }, { w: 'five_hour', t: NOW - 10 * MIN, used: 90, resets_at: reset }, { w: 'five_hour', t: NOW - MIN, used: 97, resets_at: reset },
      { w: 'seven_day', t: NOW - MIN, used: 21, resets_at: reset + 86400 },
    ], SAMPLES_PATH);
    for (const rl of [undefined, null, { five_hour: null, seven_day: null }, { five_hour: { used_percentage: null, resets_at: reset }, seven_day: null }]) {
      const line = strip(renderStatusline({ ...fullPayload, rate_limits: rl as never }, NOW)[0]);
      expect(line).not.toContain('5h');
      expect(line).not.toContain('7d');
      expect(line).toContain('ctx 42%/1M');
    }
  });
  it('resets_at 이 지난 창은 숨김', () => {
    const past = Math.floor((NOW - 60_000) / 1000);
    const line = strip(renderStatusline({ ...fullPayload, rate_limits: { five_hour: { used_percentage: 97, resets_at: past } } }, NOW)[0]);
    expect(line).not.toContain('5h');
  });
  it('used_percentage null 이어도 exceeds_200k_tokens 경고는 보인다', () => {
    const line = strip(buildUserLine({ context_window: { used_percentage: null }, exceeds_200k_tokens: true }, '/x', {}, NOW));
    expect(line).toContain('⚠200k');
    expect(line).not.toContain('ctx');
  });

  it('ctx ≥80 노랑, ≥95 빨강, exceeds_200k_tokens 경고', () => {
    const y = buildUserLine({ context_window: { used_percentage: 85, context_window_size: 200_000 } }, '/x', {}, NOW);
    expect(y).toContain('\x1b[33mctx 85%/200k');
    const r = buildUserLine({ context_window: { used_percentage: 96 }, exceeds_200k_tokens: true }, '/x', {}, NOW);
    expect(r).toContain('\x1b[31mctx 96%');
    expect(strip(r)).toContain('⚠200k');
  });

  it('샘플이 쌓이면 한도 소진 예측이 붙고, 리셋 전 소진이면 노랑', () => {
    const MIN = 60_000;
    appendSamples([
      { w: 'five_hour', t: NOW - 20 * MIN, used: 50, resets_at: reset },
      { w: 'five_hour', t: NOW - 10 * MIN, used: 60, resets_at: reset },
    ], SAMPLES_PATH);
    const raw = renderStatusline({ ...fullPayload, rate_limits: { five_hour: { used_percentage: 70, resets_at: reset } } }, NOW)[0];
    expect(strip(raw)).toMatch(/5h 70% → \d\d:\d\d 소진 \(리셋 \d\d:\d\d\)/);
    expect(raw).toContain('\x1b[33m5h 70%');
  });

  it('이 세션 차단 수는 실세션·실차단만 (default 세션·correction 제외)', () => {
    const v = path.join(STATE_DIR, 'enforcement', 'violations.jsonl');
    fs.writeFileSync(v, [
      { at: new Date(NOW).toISOString(), rule_id: 'r1', session_id: 'sess-A', kind: 'block' },
      { at: new Date(NOW).toISOString(), rule_id: 'r1', session_id: 'sess-A', kind: 'correction' },
      { at: new Date(NOW).toISOString(), rule_id: 'r1', session_id: 'sess-B', kind: 'block' },
      { at: new Date(NOW).toISOString(), rule_id: 'r1', session_id: 'default', kind: 'deny' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const line = strip(renderStatusline(fullPayload, NOW)[1]);
    expect(line).toContain('이 세션 차단 1');
  });

  it('ADR-017 D2: 같은 세션의 turn-rules 파일이 있으면 "관련 룰 N", 다른 세션 것·손상 파일이면 "룰 8" 유지', () => {
    const turn = (sid: string, rules: unknown) => fs.writeFileSync(path.join(STATE_DIR, `turn-rules-${sid}.json`), JSON.stringify({ at: new Date(NOW).toISOString(), session_id: sid, prompt_hash: 'abcdef0123456789', rules }));
    turn('sess-B', [{ rule_id: 'r1', score: 1, matchedTerms: ['x'] }]);
    expect(strip(renderStatusline(fullPayload, NOW)[1])).toMatch(/^룰 8 · /);
    turn('sess-A', [{ rule_id: 'r1', score: 1, matchedTerms: ['한국어'] }, { rule_id: 'r2', score: 1.5, matchedTerms: ['병렬', '에이전트'] }]);
    expect(strip(renderStatusline(fullPayload, NOW)[1])).toMatch(/^관련 룰 2 · 이 세션 차단 0 · 7d 차단 0 · surfaced 0$/);
    turn('sess-A', []);
    expect(strip(renderStatusline(fullPayload, NOW)[1])).toMatch(/^관련 룰 0 · /);
    fs.writeFileSync(path.join(STATE_DIR, 'turn-rules-sess-A.json'), '{broken');
    expect(strip(renderStatusline(fullPayload, NOW)[1])).toMatch(/^룰 8 · /);
  });

  it('2줄 캐시는 세션별 파일, 15초 TTL 만료 후 재계산 (1줄은 매번 렌더)', () => {
    expect(cachePathFor('sess-A')).not.toBe(cachePathFor('sess-B'));
    expect(cachePathFor('a/b')).toMatch(/statusline-cache-a_b\.txt$/);
    const first = renderStatusline(fullPayload, NOW, { useForgenCache: true });
    expect(fs.existsSync(cachePathFor('sess-A'))).toBe(true);
    // 캐시 내용을 바꿔치기 → 히트면 바뀐 값, 만료면 재계산
    fs.writeFileSync(cachePathFor('sess-A'), 'CACHED LINE\n');
    const fresh = NOW / 1000; // 테스트 NOW 는 고정 시각이므로 mtime 을 그에 맞춘다
    fs.utimesSync(cachePathFor('sess-A'), fresh, fresh);
    expect(renderStatusline({ ...fullPayload, context_window: { used_percentage: 43 } }, NOW, { useForgenCache: true })[1]).toBe('CACHED LINE');
    const stale = (NOW - 20_000) / 1000;
    fs.utimesSync(cachePathFor('sess-A'), stale, stale);
    expect(strip(renderStatusline(fullPayload, NOW, { useForgenCache: true })[1])).toBe(strip(first[1]));
    expect(renderStatusline(fullPayload, NOW)[1]).not.toBe('CACHED LINE'); // 캐시 옵션 없으면 사용 안 함
  });

  it('handleStatuslineWith: 렌더 2줄 + 샘플 기록 + 세션별 캐시 기록, 두 번째 호출은 캐시 히트로 동일 출력', async () => {
    const out: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
    try {
      await handleStatuslineWith(fullPayload, NOW);
      const first = [...out];
      out.length = 0;
      await handleStatuslineWith(fullPayload, NOW);
      expect(out).toEqual(first);
    } finally {
      console.log = orig;
    }
    expect(out).toHaveLength(2);
    expect(strip(out[0])).toContain('ctx 42%/1M');
    expect(fs.existsSync(cachePathFor('sess-A'))).toBe(true);
    // 샘플은 호출마다 기록 — 5h + 7d × 2회
    expect(fs.readFileSync(SAMPLES_PATH, 'utf-8').trim().split('\n')).toHaveLength(4);
  });

  it('프로덕션 경로(handleStatuslineWith)에서 압축이 실제로 일어난다 — 크고 정적인 파일 + 2% 분기 (critic r2 ⑦)', async () => {
    const stale = JSON.stringify({ w: 'five_hour', t: Date.now() - SAMPLE_TTL_MS - 1, used: 1, resets_at: null });
    fs.mkdirSync(path.dirname(SAMPLES_PATH), { recursive: true });
    fs.writeFileSync(SAMPLES_PATH, `${Array.from({ length: Math.ceil(COMPACT_MIN_BYTES / (stale.length + 1)) + 1 }, () => stale).join('\n')}\n`);
    const quiet = (Date.now() - 120_000) / 1000;
    fs.utimesSync(SAMPLES_PATH, quiet, quiet);
    const before = fs.statSync(SAMPLES_PATH).size;
    const rnd = vi.spyOn(Math, 'random').mockReturnValue(0); // 2% 분기 강제
    const orig = console.log; console.log = () => {};
    try { await handleStatuslineWith(fullPayload, Date.now()); } finally { rnd.mockRestore(); console.log = orig; }
    const after = fs.readFileSync(SAMPLES_PATH, 'utf-8').trim().split('\n');
    expect(fs.statSync(SAMPLES_PATH).size).toBeLessThan(before);
    expect(after).toHaveLength(2); // TTL 지난 줄 전부 제거 + 이번 호출 5h/7d 샘플 2개
  });

  it('FORGEN_HOME 격리에서 모델 캐시가 실 홈이 아니라 STATE_DIR 에 쓰인다 (critic r2 ⑧)', async () => {
    const orig = console.log; console.log = () => {};
    try { await handleStatuslineWith(fullPayload, NOW); } finally { console.log = orig; }
    expect(fs.existsSync(path.join(STATE_DIR, 'current-model-sess-A.json'))).toBe(true);
  });
});
