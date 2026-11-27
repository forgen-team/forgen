/**
 * C2 forgen audit inputs — A0 §1 측정 규칙 고정. 픽스처 대화 기록은 전부 합성이고 임시 HOME·FORGEN_HOME 안에만 만든다.
 * 고정하는 것: 제외 규칙(origin·사이드체인·메타·도구 결과·접두어·Handoff·스크래치패드·서브에이전트) · 대기열 중복 · 다중 분류 ·
 * 주 경계(KST 월~일) · 언어 누수(전체/턴 마지막, JSON·코드뿐·짧은 응답 제외) · 완료 보고·스스로 찾은 결함·M3 · --save 만 쓰기.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fg-inputs-')));
const FH = path.join(ROOT, 'forgen-home');
const CLAUDE = path.join(ROOT, 'claude');
const PREV_FH = process.env.FORGEN_HOME;
process.env.FORGEN_HOME = FH;

const { classifyMulti, primaryOf, hangulStats, lowHangul, isSelfFound, decisionReply, decisionLabel } = await import('../src/audit/inputs-classify.js');
const { runInputs, mondayOf, weekKey, parseKstDate, kstDayStartMs, folderKind } = await import('../src/audit/inputs.js');
const { resolveRange, handleInputs, saveName, renderInputs } = await import('../src/audit/inputs-cli.js');
const { countGate, readGate, GATE_OFF_NOTE } = await import('../src/audit/inputs-gate.js');

afterAll(() => {
  if (PREV_FH === undefined) delete process.env.FORGEN_HOME; else process.env.FORGEN_HOME = PREV_FH;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const HUMAN = { kind: 'human' };
type J = Record<string, unknown>;
const user = (ts: string, content: unknown, extra: J = {}): J => ({ type: 'user', timestamp: ts, origin: HUMAN, message: { role: 'user', content }, ...extra });
const asst = (ts: string, ...texts: string[]): J => ({ type: 'assistant', timestamp: ts, message: { model: 'claude-x', content: texts.map((t) => ({ type: 'text', text: t })) } });
const queued = (ts: string, prompt: unknown, origin: unknown = HUMAN): J => ({ type: 'attachment', timestamp: ts, attachment: { type: 'queued_command', prompt, origin, timestamp: ts } });
function write(dir: string, session: string, lines: J[]): void {
  const p = path.join(CLAUDE, 'projects', dir, `${session}.jsonl`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}
const KO_LONG = '변경 내용을 확인했고 테스트를 모두 통과했습니다. 남은 작업은 없습니다. '.repeat(4);
const EN = 'Now wiring it into the cli and the build banner so that it shows up correctly.';

// 2026-11-16(월) ~ 11-22(일) KST = 2026-11-15T15:00Z ~ 2026-11-22T15:00Z
const W = '-Users-someone-repo-proj';
write(W, 'sess-main-0001', [
  user('2026-11-16T01:00:00Z', '로그인 프로세스 만들어 줘'),
  asst('2026-11-16T01:01:00Z', EN), // 저한글, 턴 마지막 아님
  asst('2026-11-16T01:02:00Z', `${KO_LONG}완료했습니다. 확인해 보니 날짜 처리에 버그가 있어서 고쳤습니다.`), // 완료 보고 + 스스로 찾은 결함
  user('2026-11-16T01:10:00Z', '로그인 했어. 근데 디자인이 깨지더라고'), // proxy + defect
  asst('2026-11-16T01:11:00Z', '{"channelId":"C1","permalink":"https://example.invalid/x","text":"hello world english"}'), // JSON 제외
  asst('2026-11-16T01:12:00Z', '```ts\nconst somethingLong = anotherVeryLongIdentifier(withArguments);\n```'), // 코드뿐 제외
  asst('2026-11-16T01:13:00Z', 'ok'), // 짧음 제외
  user('2026-11-16T01:20:00Z', '한글로'),
  asst('2026-11-16T01:21:00Z', `${KO_LONG}\n## 판단할 것\nA 안(추천) / B 안`),
  user('2026-11-16T01:30:00Z', '아니 B 로 하자'),
  user('2026-11-16T01:31:00Z', [{ type: 'tool_result', content: 'x' }]), // 도구 결과
  user('2026-11-16T01:32:00Z', '[Request interrupted by user]'),
  user('2026-11-16T01:33:00Z', '<command-name>/foo</command-name>'),
  user('2026-11-16T01:34:00Z', [{ type: 'text', text: '<system-reminder>x</system-reminder>' }]),
  user('2026-11-16T01:35:00Z', 'Caveat: local'),
  user('2026-11-16T01:36:00Z', 'Another Claude session sent a message: hi'),
  user('2026-11-16T01:37:00Z', '사이드체인', { isSidechain: true }),
  user('2026-11-16T01:38:00Z', '메타', { isMeta: true }),
  user('2026-11-16T01:39:00Z', '요약', { isCompactSummary: true }), // 압축 1
  user('2026-11-16T01:40:00Z', '다른 세션에서 옴', { origin: { kind: 'peer' } }),
  user('2026-11-16T01:41:00Z', '무인 실행 발화', { origin: undefined }), // 무인
  { type: 'assistant', timestamp: '2026-11-16T01:42:00Z', message: { model: '<synthetic>', content: [{ type: 'text', text: EN }] } },
  queued('2026-11-16T02:00:00Z', 'ㄱㄱ'),
  queued('2026-11-16T02:03:00Z', 'ㄱㄱ'), // 5분 안 같은 앞 60자 → 중복
  queued('2026-11-16T02:09:00Z', 'ㄱㄱ'), // 6분 뒤 → 셈
  queued('2026-11-16T02:10:00Z', '<task>nope</task>', null), // 대기열 origin 없음 + '<' → 뺌
  queued('2026-11-16T02:11:00Z', [{ type: 'text', text: '남은 거 없어?' }]),
  user('2026-11-16T02:20:00Z', '아까 말했잖아 그거 다시 해 달라니까'), // 재설명 규칙은 버림 → 그 외
  // 주 경계: 일 23:59 KST 는 이번 주, 월 00:00 KST 는 다음 주
  user('2026-11-22T14:59:00Z', '일요일 밤 지시'),
  user('2026-11-22T15:00:00Z', '월요일 0시 지시'),
]);
write(W, 'sess-prev-0002', [user('2026-11-10T03:00:00Z', '지난주 지시'), user('2026-11-10T03:10:00Z', '이거 이상해')]);
write('-Users-someone--handoff-runs-x', 'sess-hand-0003', [user('2026-11-17T01:00:00Z', '핸드오프 사람'), user('2026-11-17T01:01:00Z', '무인', { origin: undefined })]);
write('-private-tmp-scratch-1', 'sess-tmp-0004', [user('2026-11-17T01:00:00Z', '스크래치 사람'), user('2026-11-17T01:01:00Z', '무인', { origin: undefined }), user('2026-11-17T01:02:00Z', '무인2', { origin: undefined })]);
write('-private-var-folders-ab-T-x', 'sess-var-0005', [user('2026-11-17T01:00:00Z', '임시 폴더 사람')]);
write(W, 'sess-unat-0006', [user('2026-11-17T01:00:00Z', 'sdk 실행', { origin: undefined }), asst('2026-11-17T01:01:00Z', EN)]);
// 서브에이전트 기록(<세션>/subagents/)은 읽지 않는다
const SUB = path.join(CLAUDE, 'projects', W, 'sess-main-0001', 'subagents');
fs.mkdirSync(SUB, { recursive: true });
fs.writeFileSync(path.join(SUB, 'agent-1.jsonl'), `${JSON.stringify(user('2026-11-16T05:00:00Z', '서브에이전트 발화'))}\n`);
// 압축 경계
fs.appendFileSync(path.join(CLAUDE, 'projects', W, 'sess-main-0001.jsonl'), `${JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-11-16T03:00:00Z' })}\n${JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-11-16T04:00:00Z' })}\n`);

// B1 보고 관문 판정 기록(합성): 완료 보고(11-16 01:02Z) 앞뒤 판정 + 기본 집계 밖 세션 판정 + 깨진 줄
const gateLine = (at: string, session: string, decision: string, problems: string[], missing: string[], judgeNone: boolean) =>
  JSON.stringify({ at, session, cwd: '/x', problems, missing, judgeNone, decision, n: 1 });
fs.mkdirSync(path.join(CLAUDE, 'hooks', 'state'), { recursive: true });
fs.writeFileSync(path.join(CLAUDE, 'hooks', 'state', 'report-gate.jsonl'), [
  gateLine('2026-11-16T01:01:30Z', 'sess-main-0001', 'block', ['top-labels', 'judge'], ['remaining'], true),
  gateLine('2026-11-16T01:05:00Z', 'sess-main-0001', 'pass', [], [], false),
  gateLine('2026-11-17T01:00:00Z', 'sess-unat-0006', 'cap-pass', ['top-labels'], ['done'], true),
  '{깨진 줄',
  gateLine('2026-11-23T01:00:00Z', 'sess-main-0001', 'pass', [], [], false), // 구간 밖(다음 주)
].join('\n'));
// 관문 기록이 없는 사본
const CLAUDE_NOGATE = path.join(ROOT, 'claude-nogate');
fs.cpSync(path.join(CLAUDE, 'projects'), path.join(CLAUDE_NOGATE, 'projects'), { recursive: true });

const SINCE = kstDayStartMs(parseKstDate('2026-11-16'));
const UNTIL = kstDayStartMs(parseKstDate('2026-11-23'));

describe('분류기 (다중 분류, 재설명 없음)', () => {
  it('섞인 발화는 여러 유형, 첫 일치는 A0 순서', () => {
    expect(classifyMulti('로그인 했어. 근데 디자인이 깨지더라고')).toEqual(['proxy', 'defect']);
    expect(primaryOf(classifyMulti('로그인 했어. 근데 디자인이 깨지더라고'))).toBe('proxy');
    expect(classifyMulti('한글로')).toEqual(['lang']);
    expect(classifyMulti('ㄱㄱ')).toEqual(['nudge']);
    expect(classifyMulti('왜 멈췄어')).toEqual(['nudge']);
    expect(classifyMulti('남은 거 없어?')).toEqual(['done']);
    expect(classifyMulti('양옆에 빈공간이 생겨')).toEqual(['defect']);
  });
  it('재설명 규칙은 버렸다 · A0 §5 오분류 사례', () => {
    expect(classifyMulti('아까 말했잖아 그거 다시 해 달라니까')).toEqual([]);
    expect(classifyMulti('이해가 안되네')).toEqual([]);
    expect(classifyMulti('ㄱㄱ 그렇게하고 리뷰 다시 받아보자')).toEqual([]);
  });
  it('언어 누수 판정: 코드·URL·경로 제거, JSON·짧은 응답은 대상 아님', () => {
    expect(lowHangul(hangulStats(EN))).toBe(true);
    expect(lowHangul(hangulStats(KO_LONG))).toBe(false);
    expect(lowHangul(hangulStats('{"a":"english words here and more"}'))).toBeNull();
    expect(lowHangul(hangulStats('```\nconst x = someLongIdentifierHere;\n```'))).toBeNull();
    expect(lowHangul(hangulStats('결과는 /Users/x/projects/foo/bar.ts 와 `someIdentifierLong` 를 보세요'))).toBeNull();
  });
  it('"판단할 것" 라벨: 없음·항목·형식 변형', () => {
    expect(decisionLabel('확인한 것: x\n판단할 것: 없음')).toBe('none');
    expect(decisionLabel('**판단할 것**: 없음.')).toBe('none');
    expect(decisionLabel('## 판단할 것\n\n- 없음')).toBe('none');
    expect(decisionLabel('| 판단할 것 | 없습니다 |')).toBe('none');
    expect(decisionLabel('판단할것: A 안(추천) / B 안')).toBe('item');
    expect(decisionLabel('## 판단할 것\n1. 없음표시 대신 0 으로 둘지(추천: 0)')).toBe('item');
    expect(decisionLabel('결정해야 할 것: A')).toBeNull(); // 라벨은 "판단할 것" 만
  });
  it('스스로 찾은 결함·M3 답 판정', () => {
    expect(isSelfFound('확인해 보니 날짜 처리에 버그가 있어서 고쳤습니다')).toBe(true);
    expect(isSelfFound('I found a regression in the parser')).toBe(true);
    expect(isSelfFound('테스트를 모두 통과했습니다')).toBe(false);
    expect(decisionReply('아니 B 로 하자')).toBe('overturn');
    expect(decisionReply('추천대로 해')).toBe('accept');
    expect(decisionReply('음 생각해 볼게')).toBe('unclear');
  });
});

describe('주 경계 (KST 월~일)', () => {
  it('일 23:59 KST 와 월 00:00 KST 는 다른 주', () => {
    expect(weekKey(Date.parse('2026-11-22T14:59:00Z'))).toBe('2026-11-16');
    expect(weekKey(Date.parse('2026-11-22T15:00:00Z'))).toBe('2026-11-23');
    expect(mondayOf(Date.parse('2026-11-16T00:00:00+09:00'))).toBe(parseKstDate('2026-11-16'));
  });
  it('기본 기간 = 직전 완결 주, --until 은 그날 포함', () => {
    const now = new Date('2026-11-27T10:00:00+09:00'); // 금
    expect(resolveRange([], now)).toEqual({ sinceMs: Date.parse('2026-11-16T00:00:00+09:00'), untilMs: Date.parse('2026-11-23T00:00:00+09:00') });
    expect(resolveRange([], new Date('2026-11-23T00:30:00+09:00')).sinceMs).toBe(Date.parse('2026-11-16T00:00:00+09:00'));
    expect(resolveRange(['--since', '2026-10-28', '--until', '2026-11-27'], now)).toEqual({ sinceMs: Date.parse('2026-10-28T00:00:00+09:00'), untilMs: Date.parse('2026-11-28T00:00:00+09:00') });
    expect(() => resolveRange(['--since', '2026-11-31'], now)).toThrow();
  });
  it('폴더 종류', () => {
    expect(folderKind('-Users-a-repo-x')).toBe('main');
    expect(folderKind('-Users-a-Handoff-x')).toBe('handoff');
    expect(folderKind('-private-var-folders-x')).toBe('handoff');
    expect(folderKind('-private-tmp-x')).toBe('scratchpad');
  });
});

describe('runInputs (합성 기록)', async () => {
  const r = await runInputs({ claudeDir: CLAUDE, sinceMs: SINCE, untilMs: UNTIL, now: new Date('2026-11-27T00:00:00Z') });
  it('사람 발화와 제외 규칙', () => {
    // 지시·로그인+깨짐·한글로·아니 B·ㄱㄱ·ㄱㄱ(6분 뒤)·남은 거·아까 말·일요일 밤 = 9 (월 0시는 다음 주)
    expect(r.total.human).toBe(9);
    expect(r.total.sessions).toBe(1);
    expect(r.excluded).toEqual({ handoff: { human: 2, unattended: 1 }, scratchpad: { human: 1, unattended: 2 }, mainUnattended: 2, queuedDuplicates: 1 });
    expect(r.source.filesRead).toBe(6); // 서브에이전트 기록 제외
  });
  it('다중 분류 합계와 첫 일치', () => {
    expect(r.total.types).toEqual({ nudge: 2, lang: 1, done: 1, proxy: 1, defect: 1, other: 4 });
    expect(r.total.primary).toEqual({ nudge: 2, lang: 1, done: 1, proxy: 1, defect: 0, other: 4 });
    expect(r.total.multiLabeled).toBe(1);
    expect(r.total.simple).toBe(5);
  });
  it('언어 누수: 전체와 턴 마지막 따로', () => {
    // 대상 블록: EN(마지막 아님), 완료 보고(마지막), 판단할 것 보고(마지막) — JSON·코드뿐·짧은·synthetic 제외, 무인 세션 제외
    expect(r.total.lang.all).toEqual({ n: 3, low: 1, ratio: 0.333 });
    expect(r.total.lang.final).toEqual({ n: 2, low: 0, ratio: 0 });
  });
  it('완료 보고·다음 결함·스스로 찾은 결함·M3', () => {
    // 첫 턴의 마지막 블록만 완료 보고("통과했습니다"는 완료 문구가 아님 → 판단할 것 보고는 완료 아님)
    // M2 주 지표 = 결함 보고 1 ÷ 완료 보고 1, 기존 M2 는 보조(afterDone)
    expect(r.total.m2).toEqual({
      defectPerDoneClaim: 1, defectReports: 1, doneClaims: 1,
      afterDone: { turnsWithReply: 3, doneWithNext: 1, nextDefect: 1, ratio: 1, control: { turns: 2, nextDefect: 0, ratio: 0 } },
    });
    expect(r.trend.defectPerDoneClaim).toEqual([
      { week: '2026-11-09', days: 7, value: null, defectReports: 1, doneClaims: 0 },
      { week: '2026-11-16', days: 7, value: 1, defectReports: 1, doneClaims: 1 },
    ]);
    expect(r.total.selfFound).toEqual({ blocks: 1, doneClaimsWithSelfFound: 1, a0Phrase: 0 });
    // "## 판단할 것\nA 안(추천) / B 안" → 라벨 항목 있음, 다음 발화 "아니 B 로 하자" → 뒤집기
    expect(r.total.m3).toEqual({
      labeled: 1, labeledNone: 0, labeledItem: 1, withNext: 1, overturned: 1, accepted: 0, unclear: 0, ratio: 1,
      legacy: { decisionReports: 1, withNext: 1, overturned: 1, accepted: 0, unclear: 0, ratio: 1 },
    });
  });
  it('압축 수와 세션 표', () => {
    expect(r.sessions.compactions).toBe(2);
    expect(r.sessions.top[0]).toMatchObject({ session: 'sess-mai', human: 9, simple: 5, compactions: 2 });
  });
  it('주 행과 지난 주', () => {
    expect(r.weeks.map((w) => [w.week, w.days, w.human])).toEqual([['2026-11-16', 7, 9]]);
    expect(r.previousWeek).toMatchObject({ week: '2026-11-09', human: 2 });
    expect(r.previousWeek?.types.defect).toBe(1);
    expect(saveName(r)).toBe('2026-11-16.json');
  });
  it('모든 묶음에 라벨', () => {
    expect(r.fieldLabels.human).toBe('실측');
    expect(r.fieldLabels['lang.all']).toBe('실측');
    expect(r.fieldLabels.types).toBe('근사');
    expect(r.fieldLabels['selfFound.*']).toBe('근사');
    expect(r.notes.some((n) => n.includes('스스로 찾은 결함') && n.includes('한계'))).toBe(true);
  });
});

describe('보고 관문 (report-gate.jsonl 읽기만)', async () => {
  const r = await runInputs({ claudeDir: CLAUDE, sinceMs: SINCE, untilMs: UNTIL });
  it('decision·problems·missing·judgeNone·막힌 비율', () => {
    expect(r.total.gate).toEqual({
      status: 'ok', judged: 3, byDecision: { block: 1, 'cap-pass': 1, pass: 1 }, byProblem: { judge: 1, 'top-labels': 2 }, byMissing: { done: 1, remaining: 1 },
      judgeNone: 2, inCountedSessions: 2, blockedRatio: 0.333,
    });
    expect(r.weeks[0].gate.judged).toBe(3);
    expect(r.source.reportGate).toMatchObject({ exists: true, firstRecord: '2026-11-16T01:01:30.000Z', unreadableLines: 1 });
  });
  it('첫 기록 전 주는 경고하지 않는다', () => {
    expect(r.previousWeek?.gate.status).toBe('before-first-record');
    expect(r.notes.some((n) => n.includes(GATE_OFF_NOTE))).toBe(false);
    expect(renderInputs(r).join('\n')).not.toContain(GATE_OFF_NOTE);
  });
  it('파일이 없으면 화면과 notes 에 꺼짐 의심', async () => {
    const n = await runInputs({ claudeDir: CLAUDE_NOGATE, sinceMs: SINCE, untilMs: UNTIL });
    expect(n.total.gate.status).toBe('no-file');
    expect(n.notes[0]).toContain(GATE_OFF_NOTE);
    expect(renderInputs(n).join('\n')).toContain(`⚠ ${GATE_OFF_NOTE}`);
  });
  it('첫 기록 이후 완료 보고가 있는데 판정 0 이면 maybe-off', () => {
    const g = readGate(CLAUDE);
    const next = Date.parse('2026-11-30T00:00:00+09:00'); // 판정 기록이 없는 주
    const c = countGate(g, next, next + 7 * 86_400_000, [next + 3_600_000], new Set());
    expect(c).toMatchObject({ status: 'maybe-off', judged: 0, blockedRatio: null });
    expect(countGate(g, next, next + 7 * 86_400_000, [], new Set()).status).toBe('ok'); // 완료 보고 없으면 판정 0 도 정상
    const empty = { ...g, entries: [], firstMs: null };
    expect(countGate(empty, SINCE, UNTIL, [SINCE + 1], new Set()).status).toBe('maybe-off');
  });
});

describe('M3 — "판단할 것" 라벨 보고를 결정적으로 센다', async () => {
  const D = path.join(ROOT, 'claude-m3');
  const p = path.join(D, 'projects', W, 'sess-m3-0007.jsonl');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const long = `${'가'.repeat(900)}\n판단할 것: B 안으로 바꿀지(추천: A 유지)\n${'나'.repeat(900)}`; // 1,600자 넘음 → 판정용 본문은 가운데가 잘림
  fs.writeFileSync(p, [
    user('2026-11-17T01:00:00Z', '작업 1'), asst('2026-11-17T01:01:00Z', '보고입니다.\n판단할 것: 없음'), user('2026-11-17T01:02:00Z', 'ㅇㅇ'),
    asst('2026-11-17T01:03:00Z', '보고\n## 판단할 것\n- A(추천) / B'), user('2026-11-17T01:04:00Z', '추천대로'),
    asst('2026-11-17T01:05:00Z', long), user('2026-11-17T01:06:00Z', '아니 B 로 바꿔'),
    asst('2026-11-17T01:07:00Z', '판단할 것: C 안'), // 다음 사람 발화 없음 → 분모 밖
  ].map((l) => JSON.stringify(l)).join('\n'));
  const r = await runInputs({ claudeDir: D, sinceMs: SINCE, untilMs: UNTIL });
  it('라벨 수·없음·항목·분모(항목 + 다음 발화)·뒤집기, 예전 근사는 따로', () => {
    expect(r.total.m3).toEqual({
      labeled: 4, labeledNone: 1, labeledItem: 3, withNext: 2, overturned: 1, accepted: 1, unclear: 0, ratio: 0.5,
      // 예전 키워드 근사는 잘린 본문을 보므로 긴 보고를 놓치고, "없음" 보고도 센다
      legacy: { decisionReports: 3, withNext: 2, overturned: 0, accepted: 2, unclear: 0, ratio: 0 },
    });
    expect(renderInputs(r).join('\n')).toContain('"판단할 것" 라벨 보고 4 [실측] (없음 1 · 항목 있음 3) → 다음 발화가 뒤집거나 고침 1/2');
  });
});

describe('handleInputs — 기본은 stdout 만, --save 일 때만 FORGEN_HOME/audit/inputs', () => {
  const capture = async (args: string[]) => {
    const orig = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => { lines.push(a.join(' ')); };
    try { await handleInputs(args); } finally { console.log = orig; }
    return lines.join('\n');
  };
  it('저장 없이 JSON', async () => {
    const out = await capture(['--since', '2026-11-16', '--until', '2026-11-22', '--claude-dir', CLAUDE, '--json']);
    expect(JSON.parse(out).total.human).toBe(9);
    expect(fs.existsSync(FH)).toBe(false);
  });
  it('--save', async () => {
    const out = await capture(['--since', '2026-11-16', '--until', '2026-11-22', '--claude-dir', CLAUDE, '--save']);
    expect(out).toContain('사람 발화 9 [실측]');
    expect(fs.readdirSync(path.join(FH, 'audit', 'inputs'))).toEqual(['2026-11-16.json']);
    expect(fs.readdirSync(FH)).toEqual(['audit']);
  });
});
