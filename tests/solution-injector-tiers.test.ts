/**
 * Progressive Disclosure 3층 주입 (claude-mem 스타일 index→summary→full 대응)
 *
 * solution-injector.ts의 renderSolutionTiers/buildFullTier/buildSummaryTier/
 * buildIndexTier를 직접 단위 테스트한다. compound-read MCP tool로 이미 갖고
 * 있던 Tier 3(전문)은 그대로 두고, 이번 변경은 Tier 0~2 배분만 다룬다:
 *   - 매치 1건 & 전문이 작으면 Tier 0(전문)
 *   - 매치 2건 이상: 1위만 Tier 2(요약), 나머지는 Tier 1(인덱스 라인)
 */
import { describe, it, expect } from 'vitest';
import {
  buildFullTier,
  buildIndexTier,
  buildSummaryTier,
  renderSolutionTiers,
} from '../src/hooks/solution-injector.js';
import {
  DEFAULT_EVIDENCE,
  serializeSolutionV3,
  type SolutionV3,
} from '../src/engine/solution-format.js';
import { applyRoiDemotions, type RoiDemotions } from '../src/engine/roi-demotion.js';

interface TierSolutionFixture {
  name: string;
  type: string;
  confidence: number;
  matchedTags: string[];
}

function sol(name: string, matchedTags: string[] = ['cache', 'invalidation']): TierSolutionFixture {
  return { name, type: 'pattern', confidence: 0.8, matchedTags };
}

/** 유효한 V3 프론트매터를 가진 fixture 솔루션 텍스트 생성 (buildFullTier의 parseSolutionV3 성공 조건) */
function makeSolutionRaw(name: string, content: string, context = 'Fixture context line.'): string {
  const solution: SolutionV3 = {
    frontmatter: {
      name,
      version: 1,
      status: 'verified',
      confidence: 0.8,
      type: 'pattern',
      scope: 'me',
      tags: ['test'],
      identifiers: [],
      evidence: { ...DEFAULT_EVIDENCE },
      created: '2026-01-01',
      updated: '2026-01-01',
      supersedes: null,
      extractedBy: 'auto',
    },
    context,
    content,
  };
  return serializeSolutionV3(solution);
}

describe('renderSolutionTiers — 랭크별 tier 배정', () => {
  it('단일 매치 & 전문이 캡 이하면 Tier 0(전문) 그대로 주입한다', () => {
    const raw = makeSolutionRaw('solo-fix', 'A short body well under the full-text cap.');
    const rendered = renderSolutionTiers([sol('solo-fix')], new Map([['solo-fix', raw]]));

    expect(rendered.get('solo-fix')).toBe(buildFullTier(sol('solo-fix'), raw));
    expect(rendered.get('solo-fix')).toContain('A short body well under the full-text cap.');
  });

  it('단일 매치라도 전문이 캡을 넘으면 Tier 2(요약)로 폴백한다', () => {
    const bigBody = 'word '.repeat(400); // 1200자(FULL_TEXT_MAX_CHARS) 초과
    const raw = makeSolutionRaw('big-solo', bigBody);

    expect(buildFullTier(sol('big-solo'), raw)).toBeNull();
    const rendered = renderSolutionTiers([sol('big-solo')], new Map([['big-solo', raw]]));
    expect(rendered.get('big-solo')).toBe(buildSummaryTier(sol('big-solo'), raw));
  });

  it('매치 3건 — 1위만 Tier 2(요약), 2~3위는 Tier 1(인덱스 + compound-read 힌트)', () => {
    const raws = new Map([
      ['top', makeSolutionRaw('top', 'Top line one.\nTop line two.\nTop line three.')],
      ['second', makeSolutionRaw('second', 'Second solution body line.')],
      ['third', makeSolutionRaw('third', 'Third solution body line.')],
    ]);
    const sols = [sol('top'), sol('second'), sol('third')];
    const rendered = renderSolutionTiers(sols, raws);

    expect(rendered.get('top')).toBe(buildSummaryTier(sol('top'), raws.get('top')!));
    expect(rendered.get('second')).toBe(buildIndexTier(sol('second'), raws.get('second')!));
    expect(rendered.get('third')).toBe(buildIndexTier(sol('third'), raws.get('third')!));

    // 인덱스 라인은 compound-read MCP 힌트를 포함해야 Tier 3 pull 경로를 안내한다.
    expect(rendered.get('second')).toContain('compound-read("second")');
    expect(rendered.get('third')).toContain('compound-read("third")');
    // 요약 tier에는 인덱스 전용 힌트가 없다 (다른 텍스트 형태).
    expect(rendered.get('top')).not.toContain('compound-read(');
  });

  it('rawByName에 없는 솔루션(fs 읽기 실패 시뮬)도 fail-open으로 렌더된다', () => {
    const sols = [sol('a'), sol('b')];
    const rendered = renderSolutionTiers(sols, new Map());
    expect(rendered.get('a')).toContain('a [pattern|0.80]');
    expect(rendered.get('b')).toContain('compound-read("b")');
  });
});

describe('tier 별 글자 수 캡 준수', () => {
  it('Tier 2(요약)는 헤더 포함 400자 이내로 수렴한다 (SUMMARY_MAX_CHARS=300 스니펫 캡)', () => {
    const raw = makeSolutionRaw('long-summary', 'x'.repeat(1000));
    const rendered = buildSummaryTier(sol('long-summary'), raw);
    expect(rendered.length).toBeLessThanOrEqual(400);
  });

  it('Tier 1(인덱스) one-liner는 100자를 넘지 않는다', () => {
    const raw = makeSolutionRaw('long-index', 'y'.repeat(1000));
    const rendered = buildIndexTier(sol('long-index'), raw);
    const oneLiner = rendered.split(': ')[1]?.split(' — ')[0] ?? '';
    expect(oneLiner.length).toBeLessThanOrEqual(100);
  });
});

describe('ROI 강등/격리와 tier 배분의 상호작용', () => {
  it('격리(quarantine)된 솔루션은 applyRoiDemotions에서 이미 제거되어 tier 렌더 대상에 없다', () => {
    const matches = [
      { name: 'a', relevance: 0.9 },
      { name: 'quarantined', relevance: 0.8 },
      { name: 'b', relevance: 0.5 },
    ];
    const demotions: RoiDemotions = {
      quarantined: {
        solutionId: 'quarantined',
        reason: 'low-roi',
        demotedAt: '2026-01-01T00:00:00Z',
        windowCount: 2, // 2회 연속 → 격리
        lastEvaluatedAt: '2026-01-01T00:00:00Z',
        surfaced: 10,
        actedOn: 0,
      },
    };
    const adjusted = applyRoiDemotions(matches, demotions);
    expect(adjusted.map(m => m.name)).not.toContain('quarantined');

    const sols = adjusted.map(m => sol(m.name));
    const raws = new Map(sols.map(s => [s.name, makeSolutionRaw(s.name, 'body line')]));
    const rendered = renderSolutionTiers(sols, raws);
    expect(rendered.has('quarantined')).toBe(false);
    expect(rendered.size).toBe(2);
  });

  it('강등(×0.5)된 솔루션은 재정렬로 순위가 밀려 Tier 1로 내려갈 수 있다', () => {
    const matches = [
      { name: 'demoted', relevance: 0.9 }, // 강등 전엔 1위
      { name: 'clean', relevance: 0.6 },
    ];
    const demotions: RoiDemotions = {
      demoted: {
        solutionId: 'demoted',
        reason: 'low-roi',
        demotedAt: '2026-01-01T00:00:00Z',
        windowCount: 1, // 1회 — 격리 아님, 강등만
        lastEvaluatedAt: '2026-01-01T00:00:00Z',
        surfaced: 5,
        actedOn: 0,
      },
    };
    const adjusted = applyRoiDemotions(matches, demotions);
    // 0.9*0.5=0.45 < 0.6 → clean이 1위로 재정렬됨
    expect(adjusted.map(m => m.name)).toEqual(['clean', 'demoted']);

    const sols = adjusted.map(m => sol(m.name));
    const raws = new Map(sols.map(s => [s.name, makeSolutionRaw(s.name, 'one line body here.')]));
    const rendered = renderSolutionTiers(sols, raws);
    // tier 배정은 (강등 후) 재정렬된 순서를 그대로 따른다 — clean이 Tier 2, demoted가 Tier 1.
    expect(rendered.get('clean')).toBe(buildSummaryTier(sol('clean'), raws.get('clean')!));
    expect(rendered.get('demoted')).toBe(buildIndexTier(sol('demoted'), raws.get('demoted')!));
  });
});

describe('사이즈 절감 — 3건 매치 픽스처 (구 방식 대비)', () => {
  it('신규 tier 렌더는 전원-Tier2였던 구 방식 대비 injections 본문을 50% 이상 절감한다', () => {
    // 실제 솔루션 본문은 보통 문단 단위(수백 자)로 작성된다 — 짧은 한 줄짜리
    // 픽스처는 Tier2/Tier1 차이가 거의 안 나서 절감 효과를 과소평가한다.
    const bodyLines = [
      'When a flaky integration test fails intermittently under load, first check whether the assertion depends on wall-clock timing rather than an explicit awaited signal, because timing-based assertions are the single largest source of nondeterministic CI failures.',
      'Prefer polling with a bounded retry loop over a fixed sleep, and always assert on the terminal state rather than an intermediate one so that a slow CI runner does not turn a passing test into a false negative.',
      'If the flake persists after removing timing assumptions, capture the full stack trace and correlate it against the service logs for that run before filing a bug, since the root cause is usually a genuine race rather than the test itself.',
    ].join('\n');

    // budget.solutionsPerPrompt의 실사용 상한(3)과 동일한 3건 매치 시나리오.
    const sols = [sol('m1'), sol('m2'), sol('m3')];
    const raws = new Map(sols.map(s => [s.name, makeSolutionRaw(s.name, bodyLines)]));

    // 구 방식: 매치 전원이 동일한 Tier 2(요약) 포맷을 받았다.
    const oldFormat = sols.map(s => `- ${buildSummaryTier(s, raws.get(s.name)!)}`).join('\n');

    const rendered = renderSolutionTiers(sols, raws);
    const newFormat = sols.map(s => `- ${rendered.get(s.name)}`).join('\n');

    expect(newFormat.length).toBeLessThanOrEqual(oldFormat.length * 0.5);
    // 절대 캡으로도 고정 — 3건 매치 시나리오가 실제로 작아졌음을 브리틀하지 않게 확인.
    expect(newFormat.length).toBeLessThanOrEqual(600);
  });
});
