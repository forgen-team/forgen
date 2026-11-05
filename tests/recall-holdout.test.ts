/**
 * 보류(holdout) 회수 세트: 외부 리뷰가 쓴 프롬프트. 동의어 사전을 고칠 때 이 세트를 보고 맞추지 않는다.
 * 합격선은 오주입이 수정 전보다 늘지 않는 것뿐이다. 재현율은 합격선이 아니라 보고용 수치다.
 * 수정 전(사전에 측정 픽스처 낱말·넓은 계열이 들어 있던 상태, 같은 세트·같은 하네스) 실측:
 *   정답 21 중 14 회수, 없어야 함 22 중 5 오주입, 정답 외 주입 7 (run2 구간 20개 중 4 케이스).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHome, measure, type Golden, type Metrics } from './helpers/recall-harness';

const BEFORE = { recall: 14, negInjections: 5, wrongInjections: 7 };
const g: Golden = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures', 'recall-holdout.json'), 'utf-8'));
let root: string;
let m: Metrics;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-holdout-'));
  m = measure(buildHome(root, g), path.join(root, 'work'), g, 'holdout');
  if (process.env.RECALL_REPORT_HOLDOUT) fs.writeFileSync(process.env.RECALL_REPORT_HOLDOUT, JSON.stringify(m, null, 1));
}, 240_000);
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('recall holdout', () => {
  it('세트 크기', () => { expect(g.cases.length).toBeGreaterThanOrEqual(40); });
  it('오주입이 수정 전보다 늘지 않는다', () => {
    expect(m.negInjections).toBeLessThanOrEqual(BEFORE.negInjections);
    expect(m.wrongInjections).toBeLessThanOrEqual(BEFORE.wrongInjections);
  });
  it('재현율은 보고용 (합격선 없음, 수정 전 14 와 함께 출력)', () => {
    const recalled = m.perCase.filter((c) => c.expect.length > 0 && c.expect.every((e) => c.got.includes(e))).length;
    console.log(`holdout recall ${recalled}/${m.positives} (수정 전 ${BEFORE.recall}), negInj ${m.negInjections}/${m.negCases}, wrong ${m.wrongInjections}`);
    expect(recalled).toBeGreaterThan(0);
  });
});
