/**
 * D3 (docs/plans/2026-11-17-rule-quality-redesign.md): avoid-this 교정 1건이 session 룰 + 승급된 me 룰,
 * 활성 룰 2개로 남던 문제 — 승급 직후 같은 evidence 의 session 룰을 superseded 로 바꾼다.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-session-twin-'));
process.env.FORGEN_HOME = TMP_HOME;
process.env.FORGEN_DISABLE_PROJECT_RULES = '1';

const { processCorrection } = await import('../src/forge/evidence-processor.js');
const { promoteSessionCandidates } = await import('../src/store/evidence-store.js');
const { loadAllRules } = await import('../src/store/rule-store.js');

beforeEach(() => {
  fs.rmSync(path.join(TMP_HOME, 'me'), { recursive: true, force: true });
});

const active = () => loadAllRules().filter((r) => r.status === 'active');

describe('승급 시 session 쌍둥이 정리', () => {
  it('avoid-this 1건 → 승급 후 활성 룰은 me 1개, session 룰은 superseded(superseded_by=me)', () => {
    processCorrection({ session_id: 's1', kind: 'avoid-this', message: '작업 중에는 전체 테스트를 돌리지 않는다', target: 'run tests mid-task', axis_hint: 'quality_safety' });
    expect(active().map((r) => r.scope)).toEqual(['session']);
    expect(promoteSessionCandidates('s1')).toBe(1);
    const act = active();
    expect(act.map((r) => r.scope)).toEqual(['me']);
    const twin = loadAllRules().find((r) => r.scope === 'session')!;
    expect(twin.status).toBe('superseded');
    expect(twin.lifecycle?.superseded_by).toBe(act[0].rule_id);
    expect(twin.status_history?.at(-1)?.reason).toBe('promoted-to-me');
  });

  it('이미 있는 me 룰로 승급(재관측)돼도 새 session 룰은 정리된다', () => {
    processCorrection({ session_id: 's1', kind: 'avoid-this', message: '작업 중에는 전체 테스트를 돌리지 않는다', target: 'run tests mid-task', axis_hint: 'quality_safety' });
    promoteSessionCandidates('s1');
    processCorrection({ session_id: 's2', kind: 'avoid-this', message: '작업 중에는 전체 테스트를 돌리지 않는다', target: 'run tests mid-task', axis_hint: 'quality_safety' });
    expect(active()).toHaveLength(2);
    promoteSessionCandidates('s2');
    expect(active().map((r) => r.scope)).toEqual(['me']);
  });

  it('승급 대상이 아닌 fix-now 의 session 룰은 그대로 둔다 (12시간 유예 경로)', () => {
    processCorrection({ session_id: 's1', kind: 'fix-now', message: '이 함수 이름을 바꿔라', target: 'rename fn', axis_hint: 'communication_style' });
    expect(promoteSessionCandidates('s1')).toBe(0);
    expect(active().map((r) => r.scope)).toEqual(['session']);
  });

  it('다른 교정의 session 룰은 건드리지 않는다', () => {
    processCorrection({ session_id: 's1', kind: 'fix-now', message: '이 함수 이름을 바꿔라', target: 'rename fn', axis_hint: 'communication_style' });
    processCorrection({ session_id: 's1', kind: 'avoid-this', message: '작업 중에는 전체 테스트를 돌리지 않는다', target: 'run tests mid-task', axis_hint: 'quality_safety' });
    promoteSessionCandidates('s1');
    const act = active();
    expect(act.map((r) => `${r.scope}:${r.trigger}`).sort()).toEqual(['me:run tests mid-task', 'session:rename fn']);
  });
});
