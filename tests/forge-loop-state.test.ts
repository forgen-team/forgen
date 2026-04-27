import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  readForgeLoopState,
  renderForgeLoopForSession,
  renderForgeLoopForPrompt,
  FORGE_LOOP_LIMITS,
  type ForgeLoopState,
} from '../src/hooks/shared/forge-loop-state.js';

const TMP = path.join(os.tmpdir(), `forge-loop-state-${process.pid}`);

function writeState(state: unknown): string {
  fs.mkdirSync(TMP, { recursive: true });
  const p = path.join(TMP, 'forge-loop.json');
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
  return p;
}

beforeEach(() => fs.rmSync(TMP, { recursive: true, force: true }));
afterEach(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('readForgeLoopState', () => {
  it('파일 없으면 null', () => {
    expect(readForgeLoopState(path.join(TMP, 'missing.json'))).toBeNull();
  });

  it('잘못된 JSON 은 null (fail-open)', () => {
    fs.mkdirSync(TMP, { recursive: true });
    const p = path.join(TMP, 'bad.json');
    fs.writeFileSync(p, '{not-json');
    expect(readForgeLoopState(p)).toBeNull();
  });

  it('객체가 아니면 null', () => {
    const p = writeState('hello');
    expect(readForgeLoopState(p)).toBeNull();
  });

  it('정상 객체 파싱', () => {
    const state: ForgeLoopState = { active: true, task: 'x', stories: [] };
    const p = writeState(state);
    expect(readForgeLoopState(p)).toMatchObject({ active: true, task: 'x' });
  });
});

describe('renderForgeLoopForSession', () => {
  const NOW = Date.parse('2026-04-27T03:00:00Z');

  it('null → null', () => {
    expect(renderForgeLoopForSession(null, NOW)).toBeNull();
  });

  it('완료된 forge-loop 의 findings 노출 (recent)', () => {
    const state: ForgeLoopState = {
      active: false,
      task: 'forgen v0.4.1 self-audit',
      completedAt: '2026-04-27T02:00:00Z',
      findings: { 'US-01': 'me/ count 실측 완료', 'US-02': '대화→추출 경로 작동' },
    };
    const out = renderForgeLoopForSession(state, NOW);
    expect(out).toContain('<forge-loop-state>');
    expect(out).toContain('Status: completed');
    expect(out).toContain('US-01: me/ count 실측 완료');
    expect(out).toContain('US-02: 대화→추출 경로 작동');
    expect(out).not.toContain('stale');
  });

  it('24h 초과는 stale 라벨', () => {
    const state: ForgeLoopState = {
      active: false,
      task: 'old',
      completedAt: '2026-04-25T00:00:00Z',
      findings: { 'US-01': 'old finding' },
    };
    const out = renderForgeLoopForSession(state, NOW);
    expect(out).toContain('<forge-loop-state stale="true">');
    expect(out).toContain('(stale)');
  });

  it('7일 초과는 inject 안 함', () => {
    const state: ForgeLoopState = {
      active: false,
      completedAt: '2026-04-19T00:00:00Z',
      findings: { 'US-01': 'ancient' },
    };
    expect(renderForgeLoopForSession(state, NOW)).toBeNull();
  });

  it('진행 중 forge-loop 은 stories 진행 상황 노출', () => {
    const state: ForgeLoopState = {
      active: true,
      task: 'v0.4.2 work',
      startedAt: '2026-04-27T02:30:00Z',
      stories: [
        { id: 'US-M1', title: 'RC6 가드', passes: true },
        { id: 'US-D1', title: 'axes 4축 확장', passes: false },
        { id: 'US-P2', title: 'corpus', passes: false },
      ],
    };
    const out = renderForgeLoopForSession(state, NOW);
    expect(out).toContain('Status: in-progress 1/3');
    expect(out).toContain('- US-D1: axes 4축 확장');
    expect(out).toContain('- US-P2: corpus');
    expect(out).not.toContain('US-M1: RC6 가드'); // passes=true 는 pending 아님
  });

  it('findings 도 stories 도 없으면 null', () => {
    const state: ForgeLoopState = { active: false, task: 'x', completedAt: '2026-04-27T02:00:00Z' };
    expect(renderForgeLoopForSession(state, NOW)).toBeNull();
  });

  it('block 길이는 ≤ MAX_INJECT_BYTES', () => {
    const big = 'x'.repeat(2000);
    const state: ForgeLoopState = {
      active: false,
      task: big,
      completedAt: '2026-04-27T02:00:00Z',
      findings: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`US-${i}`, big])),
    };
    const out = renderForgeLoopForSession(state, NOW)!;
    expect(out).not.toBeNull();
    expect(out.length).toBeLessThanOrEqual(FORGE_LOOP_LIMITS.MAX_INJECT_BYTES);
    expect(out.endsWith('...')).toBe(true);
  });

  it('XML 위험 문자는 escape', () => {
    const state: ForgeLoopState = {
      active: false,
      task: '<script>alert(1)</script>',
      completedAt: '2026-04-27T02:00:00Z',
      findings: { 'US-01': '"<>&"' },
    };
    const out = renderForgeLoopForSession(state, NOW)!;
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&amp;');
  });

  it('startedAt 만 있고 completedAt 없으면 startedAt 기준 stale 판정', () => {
    const state: ForgeLoopState = {
      active: false,
      startedAt: '2026-04-19T00:00:00Z',
      findings: { 'US-01': 'long-ago started, never completed' },
    };
    expect(renderForgeLoopForSession(state, NOW)).toBeNull();
  });
});

describe('renderForgeLoopForPrompt', () => {
  const NOW = Date.parse('2026-04-27T03:00:00Z');

  it('active=false 면 null', () => {
    const state: ForgeLoopState = { active: false, stories: [{ id: 'a', title: 'A' }] };
    expect(renderForgeLoopForPrompt(state, NOW)).toBeNull();
  });

  it('진행 중이면 next + 진행률', () => {
    const state: ForgeLoopState = {
      active: true,
      startedAt: '2026-04-27T02:30:00Z',
      stories: [
        { id: 'US-M1', title: 'RC6', passes: true },
        { id: 'US-D1', title: 'axes', passes: false },
      ],
    };
    const out = renderForgeLoopForPrompt(state, NOW);
    expect(out).toContain('<forge-loop-active>');
    expect(out).toContain('Progress: 1/2');
    expect(out).toContain('next: US-D1 axes');
  });

  it('모든 스토리 통과면 null', () => {
    const state: ForgeLoopState = {
      active: true,
      startedAt: '2026-04-27T02:30:00Z',
      stories: [{ id: 'a', title: 'A', passes: true }],
    };
    expect(renderForgeLoopForPrompt(state, NOW)).toBeNull();
  });

  it('7일 초과 active 도 inject 안 함 (좀비 forge-loop 보호)', () => {
    const state: ForgeLoopState = {
      active: true,
      startedAt: '2026-04-19T00:00:00Z',
      stories: [{ id: 'a', title: 'A', passes: false }],
    };
    expect(renderForgeLoopForPrompt(state, NOW)).toBeNull();
  });

  it('block 길이 ≤ MAX_INJECT_BYTES', () => {
    const big = 'x'.repeat(2000);
    const state: ForgeLoopState = {
      active: true,
      startedAt: '2026-04-27T02:30:00Z',
      stories: [{ id: 'huge-id', title: big, passes: false }],
    };
    const out = renderForgeLoopForPrompt(state, NOW)!;
    expect(out.length).toBeLessThanOrEqual(FORGE_LOOP_LIMITS.MAX_INJECT_BYTES);
  });
});

describe('RC6 자기증거 corpus', () => {
  it('이번 세션 사례: head -80 으로 findings 8줄 누락 시나리오 — 정상 inject 가 이를 차단', () => {
    // 시나리오: forge-loop.json 99 lines, findings 가 line 92~99 에 위치.
    // 이전 세션 finding 형식 그대로 재현.
    const state: ForgeLoopState = {
      active: false,
      task: '개인 철학 자가 학습 하네스 — 대화→철학 추출→다음 대화 반영',
      completedAt: '2026-04-27T02:30:00Z',
      stories: Array.from({ length: 6 }, (_, i) => ({
        id: `US-0${i + 1}`,
        title: `story ${i + 1}`,
        passes: true,
      })),
      findings: {
        'US-01': 'me/ 내 rules 4, solutions 29, behavior 636',
        'US-02': '오늘 7개 solution 실제로 추출됨',
        'US-03': '전체 2338 세션 0% 참조율 — H4 detector 신규',
        'US-04': '4축 전부 facets 움직임. score 는 aggregated metric',
        'US-05': '하네스 export 작동. 수정 후 669 파일 export',
        'US-06': 'forgen stats 에 Philosophy (learned) 섹션 추가',
      },
    };
    const out = renderForgeLoopForSession(state, Date.parse('2026-04-27T03:00:00Z'))!;
    expect(out).not.toBeNull();
    // RC6 핵심 — findings 에 있는 "score 는 aggregated metric" 이 컨텍스트에 노출되어야
    // 다음 세션 인터뷰가 D1 가설을 다시 세우지 않음
    expect(out).toContain('aggregated metric');
    expect(out).toContain('US-05');
  });
});
