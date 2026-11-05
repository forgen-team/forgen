/**
 * A3 비용·과금 / A5 프라이버시 안내. FORGEN_HOME 은 import 시점에 고정되므로 모듈을 새 홈으로 다시 로드한다.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

let home: string;
async function load() {
  vi.resetModules();
  const consent = await import('../src/core/compound-consent.js');
  const flow = await import('../src/core/flow-status.js');
  return { consent, flow };
}
const event = (e: Record<string, unknown>) => {
  const p = path.join(home, 'state', 'extraction-events.jsonl');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, `${JSON.stringify({ at: new Date().toISOString(), ...e })}\n`);
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-bill-'));
  process.env.FORGEN_HOME = home;
  delete process.env.ANTHROPIC_API_KEY; delete process.env.FORGEN_NO_AUTO_COMPOUND; delete process.env.FORGEN_AUTO_COMPOUND;
});
afterEach(() => { delete process.env.ANTHROPIC_API_KEY; fs.rmSync(home, { recursive: true, force: true }); });

describe('A5 안내 문구는 ADR-019 전송 범위와 일치한다', () => {
  it('어시스턴트 발화, 파일 내용 일부, 마스킹·<private> 제외, 내 계정의 Haiku 를 모두 말한다', async () => {
    const { consent } = await load();
    const t = consent.HAIKU_FIRST_NOTICE;
    for (const must of ['내 발화', '어시스턴트 발화', '파일 내용의 일부', '비밀키는 마스킹', '<private>', '내 계정의 Claude Haiku', 'forgen compound consent off']) expect(t).toContain(must);
  });
});

describe('A3 API 과금 안내', () => {
  it('ANTHROPIC_API_KEY 가 없으면 과금 문구가 없다', async () => {
    const { consent } = await load();
    expect(consent.apiBillingNote()).toBeNull();
    const n = await consent.takeSessionStartNotice();
    expect(n).toContain('세션 학습이 켜져 있습니다');
    expect(n).not.toContain('API 과금');
  });

  it('키가 있으면 첫 안내에 "API 과금 계정으로 호출됨"과 끄는 법이 들어가고, 이후 반복되지 않는다', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const { consent } = await load();
    const first = await consent.takeSessionStartNotice();
    expect(first).toContain('API 과금 계정');
    expect(first).toContain('forgen compound consent off');
    expect(await consent.takeSessionStartNotice()).toBeNull();
  });

  it('첫 안내를 이미 본 뒤에 키가 생기면 과금 안내를 한 번 따로 보인다. 기본값 ON 은 유지된다', async () => {
    const a = await load();
    expect(await a.consent.takeSessionStartNotice()).toContain('세션 학습이 켜져 있습니다');
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const b = await load();
    expect(b.consent.getHaikuConsentState()).toEqual({ enabled: true, source: 'default' });
    expect(await b.consent.takeSessionStartNotice()).toContain('API 과금 계정');
    expect(await b.consent.takeSessionStartNotice()).toBeNull();
  });

  it('status 에 과금 계정 표시와 오늘 호출 수·세션당 호출 수가 나온다', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    event({ kind: 'haiku-call', phase: 'solution', outcome: 'ok', sessionId: 'a' });
    event({ kind: 'haiku-call', phase: 'behavior', outcome: 'ok', sessionId: 'a' });
    event({ kind: 'haiku-call', phase: 'solution', outcome: 'timeout', sessionId: 'b' });
    event({ kind: 'queued', sessionId: 'b' }); // 호출 이벤트가 아님
    const { flow } = await load();
    expect(flow.haikuCallStats()).toEqual({ today: 3, failedToday: 1, maxPerSession: 2, sessionsToday: 2 });
    expect(flow.haikuUsageLine()).toContain('오늘 호출 3회');
    const st = flow.haikuStatus();
    // PATH 에 claude 가 없으면 'unavailable' 이라 과금 줄이 없을 수 있다 — 있는 환경에서만 검증
    if (st.state === 'on') {
      expect(st.detail).toContain('API 과금 계정으로 호출됨');
      expect(st.detail).toContain('오늘 호출 3회');
    }
  });
});
