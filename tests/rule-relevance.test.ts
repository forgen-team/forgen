/**
 * rule-relevance — 턴 단위 룰 관련도 (ADR-017 D2)
 *
 *   (a) relevantRules 임계: 일반 용어 2개 또는 식별자급 1개 · 공통어 단독 제외 · 정렬
 *   (b) 성능: 룰 100개 × 프롬프트 1개 ≤ 5ms (warm-up 후 best-of-5 — 병렬 CI 노이즈 방지)
 *   (c) turn-rules 파일: 프롬프트 원문 없이 sha256 앞 16자만 · 손상 파일 fail-open · state-gc prefix
 *   (d) renderTurnRules / formatTurnRuleLine — 원 교정 연결 문구
 *
 * 격리 HOME (vi.mock node:os).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const TEST_HOME = `/tmp/forgen-rule-relevance-test-${process.pid}`;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME, tmpdir: () => actual.tmpdir() };
});

const {
  relevantRules, ruleTerms, isSpecificTerm, RELEVANCE_THRESHOLD, PROMPT_HASH_LENGTH,
  promptHash, turnRulesPath, writeTurnRules, readTurnRules, resolveTurnRulesSession,
} = await import('../src/engine/rule-relevance.js');
const { renderTurnRules, formatTurnRuleLine } = await import('../src/core/status-cli.js');
const { pruneState } = await import('../src/core/state-gc.js');
const { STATE_DIR } = await import('../src/core/paths.js');
import type { Rule } from '../src/store/types.js';

function rule(id: string, trigger: string, policy: string, over: Partial<Rule> = {}): Rule {
  return {
    rule_id: id, category: 'workflow', scope: 'me', trigger, policy, strength: 'default',
    source: 'behavior_inference', status: 'active', evidence_refs: [], render_key: `w.${id}`,
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...over,
  };
}

const KO_LANG = rule('ko-lang', '사용자 응답 언어', '오너에게 보내는 답변은 항상 한국어로. 영어로 답하지 말 것', { source: 'explicit_correction', strength: 'strong' });
const PARALLEL = rule('parallel', '에이전트 병렬화 제약', '병렬 에이전트 사용을 자유롭게 진행해도 되며, 팀(Team) 방식으로만 진행할 필요가 없다');
const DESIGN = rule('design', '설계 검증 방식 - Fable 투입', '설계 단계에서는 Fable 같은 상위 모델을 미리 투입하여 blind spot을 조기에 발견하라');
const MOCK = rule('L1-no-mock', 'mock-validation-claim', 'mock/stub/fake 기반 검증으로 완료 선언 금지. 실제 실행 기반 증거만 유효', { source: 'explicit_correction', strength: 'hard' });
const STATUSLINE = rule('statusline', 'statusline 재설계', 'statusline 두 줄 고정, 출처 없는 숫자는 표시하지 않는다');
const COMMON_ONLY = rule('common', '코드 파일 테스트', '코드를 수정하고 파일을 추가하고 테스트를 실행한다');

describe('relevantRules — 임계·공통어·식별자', () => {
  const ALL = [KO_LANG, PARALLEL, DESIGN, MOCK, STATUSLINE, COMMON_ONLY];

  it('한글 3음절(한국어)은 식별자급 — 단독 매칭으로 "사용자 응답 언어" 룰이 잡힌다 (ADR-017 검증 기준)', () => {
    const r = relevantRules('한국어로 답해줘 이거 리뷰해줘', ALL);
    expect(r.map((x) => x.rule_id)).toEqual(['ko-lang']);
    expect(r[0].matchedTerms).toEqual(['한국어']);
    expect(r[0].score).toBe(RELEVANCE_THRESHOLD);
  });

  it('2음절 일반 용어 1개(설계)만으로는 안 잡힌다 — 2개(설계+검증)면 잡힌다', () => {
    expect(relevantRules('설계 좀 봐줘', ALL)).toEqual([]);
    const r = relevantRules('설계 검증 부탁해', ALL);
    expect(r.map((x) => x.rule_id)).toEqual(['design']);
    expect(r[0].matchedTerms.sort()).toEqual(['검증', '설계']);
  });

  it('병렬 에이전트 프롬프트: 병렬(0.5)+에이전트(1.0) = 1.5 로 parallel 만 — 활용형(검증해)은 명사(검증)와 안 맞아 design 은 설계 0.5 로 탈락', () => {
    const r = relevantRules('병렬 에이전트로 설계 검증해', ALL);
    expect(r.map((x) => x.rule_id)).toEqual(['parallel']);
    expect(r[0].score).toBe(1.5);
    expect(r[0].matchedTerms.sort()).toEqual(['병렬', '에이전트']);
  });

  it('공통어(코드/파일/테스트/수정/추가/사용자/작업)만 겹치면 관련 아님', () => {
    expect(relevantRules('코드 파일 테스트 수정 추가 사용자 작업', ALL)).toEqual([]);
    expect(ruleTerms(COMMON_ONLY)).toEqual([]);
  });

  it('영문 6자 이상(statusline)은 식별자급, 5자 이하(codex/fable)는 단독 불충분', () => {
    expect(relevantRules('statusline 왜 안 나와', ALL).map((x) => x.rule_id)).toEqual(['statusline']);
    expect(relevantRules('fgx --codex 로 켜지나', ALL)).toEqual([]);
    expect(relevantRules('fable 써', ALL)).toEqual([]);
    expect(isSpecificTerm('fable')).toBe(false);
    expect(isSpecificTerm('statusline')).toBe(true);
    expect(isSpecificTerm('병렬')).toBe(false);
    expect(isSpecificTerm('에이전트')).toBe(true);
  });

  it('영문은 단어 경계 매칭 — "mocking" 은 "mock" 과 다르고, 하이픈 트리거는 분해돼 매칭', () => {
    expect(relevantRules('mocking 라이브러리 추천', ALL)).toEqual([]);
    const r = relevantRules('mock 으로 validation 통과시키면 돼?', ALL);
    expect(r.map((x) => x.rule_id)).toEqual(['L1-no-mock']);
  });

  it('빈 프롬프트·빈 룰 → []', () => {
    expect(relevantRules('', ALL)).toEqual([]);
    expect(relevantRules('한국어', [])).toEqual([]);
  });

  it('score 내림차순, 동점은 rule_id 순 — 결정적', () => {
    const a = rule('b-rule', '한국어 응답', '한국어로 답해');
    const b = rule('a-rule', '한국어 응답', '한국어로 답해');
    expect(relevantRules('한국어', [a, b]).map((x) => x.rule_id)).toEqual(['a-rule', 'b-rule']);
  });
});

describe('relevantRules — 성능', () => {
  // 벽시계 측정은 병렬 vitest 워커·동시 에이전트 부하에 흔들린다(4코어 load 10 에서 3ms 작업이 8ms 로 측정됨).
  // warm-up 후 best-of-10 로 노이즈를 걷어내고, 그래도 넘치면 재시도한다 — 상한 자체는 5ms 로 유지.
  it('룰 100개 × 프롬프트 1개 ≤ 5ms (warm-up 3회 후 best-of-10)', { retry: 3 }, () => {
    const hundred = Array.from({ length: 100 }, (_, i) => rule(`r${i}`, `트리거 ${i} 설계 단계 리서치`, `새 작업 착수 전 최신 AI 동향을 웹 검색으로 먼저 파악하고, 그 컨텍스트 위에서 로컬 코드 감사를 시작하라 (${i})`));
    const prompt = '병렬 에이전트로 설계 검증해. 한국어로 답해줘. statusline 도 봐줘';
    for (let i = 0; i < 3; i++) relevantRules(prompt, hundred);
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      relevantRules(prompt, hundred);
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThanOrEqual(5);
  });

  it('8단어 창 추출은 extractTags 의 8개 cap 에 걸리지 않는다 — 긴 policy 의 뒷부분 용어도 남는다', () => {
    const long = rule('long', '구조 감사 중 흐름 중단', '광범위한 구조 감사가 필요한 상황에서는 병렬 에이전트를 사용해도 되지만, 단일 프로세스로 구조 파악 중일 때는 전체 분석 흐름이 끝날 때까지 중단하지 말고 새로운 방향 지시를 내려라');
    const terms = ruleTerms(long);
    expect(terms).toContain('프로세스');
    expect(terms).toContain('에이전트');
    expect(terms.length).toBeGreaterThan(8);
  });

  it('프롬프트 32KB 초과분은 보지 않는다 (훅 지연 방지) — 뒤에만 있는 용어는 매칭 안 됨', () => {
    const huge = `${'x '.repeat(20_000)} 한국어로 답해`;
    expect(relevantRules(huge, [KO_LANG])).toEqual([]);
    expect(relevantRules(`한국어로 답해 ${'x '.repeat(20_000)}`, [KO_LANG]).map((x) => x.rule_id)).toEqual(['ko-lang']);
  });
});

describe('turn-rules 파일 — 원문 저장 금지 · fail-open · GC', () => {
  beforeEach(() => { fs.rmSync(TEST_HOME, { recursive: true, force: true }); fs.mkdirSync(STATE_DIR, { recursive: true }); });
  afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

  it('write → read 왕복: 프롬프트 원문 대신 sha256 앞 16자, 세션 id 는 sanitize 된 파일명', () => {
    const prompt = '한국어로 답해줘 비밀번호는 hunter2';
    const written = writeTurnRules('sess/A', prompt, relevantRules(prompt, [KO_LANG]));
    const p = turnRulesPath('sess/A');
    expect(p).toMatch(/turn-rules-sess_A\.json$/);
    const raw = fs.readFileSync(p, 'utf-8');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('한국어로 답해줘');
    expect(written.prompt_hash).toHaveLength(PROMPT_HASH_LENGTH);
    expect(written.prompt_hash).toBe(promptHash(prompt));
    expect((fs.statSync(p).mode & 0o777)).toBe(0o600);
    const read = readTurnRules('sess/A');
    expect(read?.rules).toEqual([{ rule_id: 'ko-lang', score: 1.0, matchedTerms: ['한국어'] }]);
    expect(read?.session_id).toBe('sess/A');
  });

  it('부재·손상(JSON 아님 / rules 가 배열 아님 / 항목 불량) → null 또는 불량 항목 제거', () => {
    expect(readTurnRules('nope')).toBeNull();
    fs.writeFileSync(turnRulesPath('bad1'), '{not json');
    expect(readTurnRules('bad1')).toBeNull();
    fs.writeFileSync(turnRulesPath('bad2'), JSON.stringify({ rules: 'x' }));
    expect(readTurnRules('bad2')).toBeNull();
    fs.writeFileSync(turnRulesPath('bad3'), JSON.stringify({ rules: [{ rule_id: 'ok', score: 1 }, { rule_id: 7 }, null] }));
    expect(readTurnRules('bad3')?.rules).toEqual([{ rule_id: 'ok', score: 1, matchedTerms: [] }]);
  });

  it('resolveTurnRulesSession: 지정 세션 파일이 있으면 그것, 없으면 가장 최근 파일', () => {
    expect(resolveTurnRulesSession('none')).toBeNull();
    writeTurnRules('old', 'p', []);
    const oldPath = turnRulesPath('old');
    fs.utimesSync(oldPath, (Date.now() - 60_000) / 1000, (Date.now() - 60_000) / 1000);
    writeTurnRules('new', 'p', []);
    expect(resolveTurnRulesSession('old')).toBe('old');
    expect(resolveTurnRulesSession(undefined)).toBe('new');
    expect(resolveTurnRulesSession('missing')).toBe('new');
  });

  it('state-gc: turn-rules- 는 세션 스코프 — 7일 지나면 정리', () => {
    const now = Date.now();
    const old = now - 10 * 24 * 3600_000;
    writeTurnRules('stale', 'p', []);
    fs.utimesSync(turnRulesPath('stale'), old / 1000, old / 1000);
    writeTurnRules('fresh', 'p', []);
    const report = pruneState({ stateDir: STATE_DIR, outcomesDir: path.join(STATE_DIR, 'outcomes'), now, dryRun: false });
    expect(report.pruned).toBe(1);
    expect(fs.existsSync(turnRulesPath('stale'))).toBe(false);
    expect(fs.existsSync(turnRulesPath('fresh'))).toBe(true);
  });
});

describe('status --turn 렌더 — 원 교정 연결', () => {
  const origin = (r: Rule) => {
    if (r.rule_id === 'ko-lang') return { date: '2026-09-29', kind: 'prefer-from-now', quote: '분석할 때마다 한국어로 답해', quoteSource: 'user' as const };
    if (r.rule_id === 'L1-no-mock') return { date: '2026-09-30', kind: 'avoid-this', quote: '', quoteSource: 'none' as const };
    return null;
  };

  it('파일 없음 / 관련 룰 0 → "이번 턴 관련 룰 없음"', () => {
    expect(renderTurnRules(null, [KO_LANG], origin)).toEqual(['이번 턴 관련 룰 없음']);
    expect(renderTurnRules({ at: '', session_id: 's', prompt_hash: 'h', rules: [] }, [KO_LANG], origin)).toEqual(['이번 턴 관련 룰 없음']);
  });

  it('[category/strength] policy (score) — 출처: 날짜 당신의 말 (kind): "원문" / 교정 기록 / 채굴 룰 / 삭제된 룰', () => {
    expect(formatTurnRuleLine(KO_LANG, 1, origin)).toBe('[workflow/strong] 오너에게 보내는 답변은 항상 한국어로. 영어로 답하지 말 것 (1.0) — 출처: 2026-09-29 당신의 말 (prefer-from-now): "분석할 때마다 한국어로 답해"');
    expect(formatTurnRuleLine(MOCK, 1.5, origin)).toBe('[workflow/hard] mock/stub/fake 기반 검증으로 완료 선언 금지. 실제 실행 기반 증거만 유효 (1.5) — 출처: 2026-09-30 교정 기록 (avoid-this)');
    expect(formatTurnRuleLine(PARALLEL, 1.5, origin)).toMatch(/^\[workflow\/default\] 병렬 에이전트 사용을 .* \(1\.5\) — 채굴 룰$/);
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
    const lines = renderTurnRules({
      at: '2026-10-06T12:34:56.000Z', session_id: 'abcdef12-3456', prompt_hash: 'deadbeefdeadbeef',
      rules: [{ rule_id: 'ko-lang', score: 1, matchedTerms: ['한국어'] }, { rule_id: 'gone', score: 1, matchedTerms: [] }],
    }, [KO_LANG, PARALLEL], origin).map(strip);
    expect(lines[0]).toBe('이번 턴 관련 룰 2 (세션 abcdef12 · 2026-10-06 12:34 · 프롬프트 deadbeefdeadbeef)');
    expect(lines[1]).toContain('— 출처: 2026-09-29 당신의 말 (prefer-from-now): "분석할 때마다 한국어로 답해"');
    expect(lines[2]).toBe('    매칭: 한국어');
    expect(lines[3]).toBe('  gone (1.0) — 룰 파일 없음(삭제됨)');
  });
});
