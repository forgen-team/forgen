/**
 * D12-G: R10 (T5 충돌 탐지의 한글 \b 버그, "실행하라/실행하지 마라" 미탐), R9 (오병합), explicit 룰 무확인 흡수 금지.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detect as detectT5, hasNegation } from '../src/engine/lifecycle/trigger-t5-conflict.js';
import { isSameConcept, policySimilarity } from '../src/engine/correction-clustering.js';
import type { Rule } from '../src/store/types.js';

function rule(id: string, policy: string, over: Partial<Rule> = {}): Rule {
  return {
    rule_id: id, category: 'workflow', scope: 'me', trigger: 't', policy, strength: 'default', source: 'explicit_correction',
    status: 'active', evidence_refs: [`ev-${id}`], render_key: `workflow.${id}`,
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...over,
  } as Rule;
}
const conflicts = (a: string, b: string) => detectT5({ rules: [rule('a', a), rule('b', b)] }).length > 0;

describe('R10 T5 충돌 탐지 (한글)', () => {
  it.each([
    ['한글 금지 표지', '프로덕션 배포는 사용자 승인 없이 금지한다고 했다', true],
    ['마라', '테스트 서버에 직접 배포하지 마라 반드시 스테이징 거친다', true],
    ['말 것', '배포 스크립트는 수정하지 말 것 그대로 실행한다', true],
    ['않는다', '마이그레이션은 확인 없이 실행하지 않는다 백업 먼저', true],
    ['긍정 문장은 부정이 아님', '마이그레이션은 백업 후 즉시 실행한다 결과 보고', false],
  ] as const)('hasNegation: %s', (_n, text, expected) => { expect(hasNegation(text)).toBe(expected); });

  it('실행하라 vs 실행하지 마라 쌍을 잡는다', () => {
    expect(conflicts('데이터베이스 마이그레이션 스크립트는 항상 즉시 실행하라 기다리지 않고', '데이터베이스 마이그레이션 스크립트는 사용자 확인 전에는 실행하지 마라')).toBe(true);
  });
  it('조사·어미 변형(배포한다/배포하지 말 것)도 어간으로 비교', () => {
    expect(conflicts('스테이징 환경에서 먼저 배포한다 검증 이후 진행', '스테이징 환경에 배포하지 말 것 곧바로 프로덕션 진행')).toBe(true);
  });
  it('같은 어조의 두 룰은 충돌이 아니다', () => {
    expect(conflicts('데이터베이스 마이그레이션은 백업 후 실행하라 반드시', '데이터베이스 마이그레이션 로그를 남기고 실행하라 매번')).toBe(false);
  });
  it('공통 어간이 없으면(상반이지만 무관) 충돌이 아니다', () => {
    expect(conflicts('답변은 한국어로 작성하라 항상 존댓말 사용', '프로덕션 데이터베이스 삭제는 금지한다 절대 하지 않는다')).toBe(false);
  });
});

describe('R9 오병합 방지', () => {
  it('외부 의존성 진행 교정이 rm 룰에 링크되지 않는다 (공유 태그 부족)', () => {
    expect(isSameConcept('외부 의존성이 막혀 있어도 가능한 부분은 진행한다', '사용자 confirm 없는 rm -rf 실행 금지')).toBe(false);
  });
  it('경계값: 유사도가 임계와 정확히 같으면 묶지 않는다', () => {
    const a = '실제 동작 검증 없이 완료 선언 금지 프로덕션 확인';
    const b = '실제 동작 검증 후 완료 선언 프로덕션 확인 필수';
    const sim = policySimilarity(a, b);
    expect(isSameConcept(a, b, sim)).toBe(false); // sim > tau 가 아니므로
  });
  it('진짜 같은 개념은 계속 묶인다', () => {
    expect(isSameConcept('완료 선언 전에 실제 동작을 검증하라 프로덕션 환경 확인', '실제 동작 검증 후에만 완료 선언 프로덕션 확인 필수')).toBe(true);
  });
});

describe('explicit 룰은 사용자 확인 없이 흡수되지 않는다', () => {
  const home = path.join(os.tmpdir(), `forgen-merge-${process.pid}`);
  const dir = path.join(home, '.forgen', 'me', 'rules');
  beforeEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    vi.resetModules();
    vi.stubEnv('HOME', home); vi.stubEnv('FORGEN_HOME', path.join(home, '.forgen')); vi.stubEnv('FORGEN_DISABLE_PROJECT_RULES', '1');
    for (const [id, p] of [['a', '완료 선언 전에 실제 동작을 검증하라 프로덕션 환경 확인'], ['b', '완료 선언 전 실제 검증 필수 라우트 존재만으로 완성 판단 금지'], ['c', '실제 동작 검증 후에만 완료 선언 프로덕션 확인 필수']]) {
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(rule(id, p, { category: 'quality', render_key: `quality.${id}` })));
    }
  });
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); });

  it('기본(자동) 경로는 제안만 쓰고 원본을 건드리지 않는다', async () => {
    const { runCorrectionClustering, MERGE_PROPOSALS_PATH } = await import('../src/engine/correction-cluster-runner.js');
    expect(await runCorrectionClustering()).toEqual([]);
    for (const id of ['a', 'b', 'c']) expect(JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8')).status).toBe('active');
    const prop = JSON.parse(fs.readFileSync(MERGE_PROPOSALS_PATH, 'utf-8'));
    expect(prop.proposals).toHaveLength(1);
    expect(prop.proposals[0].members.sort()).toEqual(['a', 'b', 'c']);
  });
  it('확인(confirmed)하면 병합된다', async () => {
    const { runCorrectionClustering } = await import('../src/engine/correction-cluster-runner.js');
    expect((await runCorrectionClustering({ confirmed: true })).length).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'a.json'), 'utf-8')).status).toBe('superseded');
  });
});
