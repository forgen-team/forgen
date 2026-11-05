/**
 * D5 회수 골든 세트: tests/fixtures/recall-golden.json (정답 27 + 없어야 함 21).
 * 실제 hook 프로세스로 측정한다. 수정 전 수치는 BASELINE 에 고정했다 (0.6.8 파이프라인, 같은 픽스처).
 * 합격: 오주입 증가 금지, 재현율 수정 전의 2배 이상 또는 70% 이상.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, buildHome, loadGolden, measure, type Metrics } from './helpers/recall-harness';

// 수정 전(HEAD 의 매처·태그 코드, 같은 픽스처·같은 하네스) 실측: 정답 27 중 12 회수, 없어야 함 21 중 5 오주입, 정답 외 주입 5.
const BASELINE = { recall: 12 / 27, negInjections: 5, wrongInjections: 5 };

let root: string;
let m: Metrics;
let migrated: Metrics;
const g = loadGolden();

beforeAll(() => {
  root = process.env.RECALL_KEEP ?? fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-recall-'));
  fs.mkdirSync(root, { recursive: true });
  const home = buildHome(root, g);
  m = measure(home, path.join(root, 'work'), g);
  // 같은 홈에 제품의 마이그레이션 명령(retag --apply, habits --apply)을 적용한 뒤 다시 잰다.
  applyMigrations(home, path.join(root, 'work'));
  migrated = measure(home, path.join(root, 'work'), g, 'migrated');
  if (process.env.RECALL_REPORT_MIGRATED) fs.writeFileSync(process.env.RECALL_REPORT_MIGRATED, JSON.stringify(migrated, null, 1));
  if (process.env.RECALL_REPORT) fs.writeFileSync(process.env.RECALL_REPORT, JSON.stringify(m, null, 1));
}, 240_000);
afterAll(() => { if (!process.env.RECALL_KEEP) fs.rmSync(root, { recursive: true, force: true }); });

describe('recall golden', () => {
  it('세트 크기', () => { expect(g.cases.length).toBeGreaterThanOrEqual(40); });
  it('무관 프롬프트 오주입이 수정 전보다 늘지 않는다', () => {
    expect(m.negInjections).toBeLessThanOrEqual(BASELINE.negInjections);
    expect(m.wrongInjections).toBeLessThanOrEqual(BASELINE.wrongInjections);
  });
  it('재현율 수정 전의 2배 이상 또는 70% 이상', () => {
    expect(m.recall >= 0.7 || m.recall >= BASELINE.recall * 2).toBe(true);
  });
  it('retag --apply 와 habits --apply 뒤에도 같은 합격선을 지킨다', () => {
    expect(migrated.negInjections).toBeLessThanOrEqual(BASELINE.negInjections);
    expect(migrated.wrongInjections).toBeLessThanOrEqual(BASELINE.wrongInjections);
    expect(migrated.recall >= 0.7 || migrated.recall >= BASELINE.recall * 2).toBe(true);
  });
  it('habits --apply 는 습관 로그를 behavior 로 옮기고 solutions 에서 뺀다', () => {
    const base = path.join(root, 'home', '.forgen', 'me');
    expect(fs.existsSync(path.join(base, 'solutions', 'works-with-typescript.md'))).toBe(false);
    expect(fs.existsSync(path.join(base, 'behavior', 'habit-works-with-typescript.md'))).toBe(true);
  });
});
