/**
 * 0.9.1 단위: #2 대표 숫자(세션 가중) · #7 지시문 판별 · #9 저장한 처방 재사용(대상 해시) · #10 도움말 언어 · #13 인용 비밀 가림.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 비밀처럼 보이는 가짜 값(저장소 비밀 검사에 걸리지 않게 실행 중에 만든다) */
const FAKE_KEY = ['sk', 'abcdefghijklmnopqrstuv'].join('-');
const FAKE_GH = ['ghp', 'abcdefghijklmnopqrstuvwx'].join('_');
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fg-v091-')));
const PREV = { FORGEN_HOME: process.env.FORGEN_HOME };
process.env.FORGEN_HOME = path.join(ROOT, '.forgen');

const { representative, groupSame, recentSessionsByFolder } = await import('../src/audit/activity.js');
const { isDirective } = await import('../src/audit/checks.js');
const { maskQuote } = await import('../src/audit/quote.js');
const { savedFix, fixHelp } = await import('../src/audit/fix-cli.js');
const { auditHelp } = await import('../src/audit/cli.js');
const { stateHash, fixDir } = await import('../src/audit/fix.js');

afterAll(() => {
  if (PREV.FORGEN_HOME === undefined) delete process.env.FORGEN_HOME; else process.env.FORGEN_HOME = PREV.FORGEN_HOME;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('#2 대표 숫자', () => {
  it('최근 30일 세션 3개 이상 폴더만, 세션 수 가중 — 값은 쓰인 폴더 범위 안', () => {
    const r = representative([{ value: -10, sessions: 20 }, { value: -20, sessions: 5 }, { value: -40, sessions: 1 }]);
    expect(r?.weighted).toBe(true);
    expect(r?.folders).toBe(2);
    expect(r?.value).toBe(-12); // (−10·20 + −20·5) / 25
    expect(r?.value).toBeGreaterThanOrEqual(r?.min as number);
    expect(r?.value).toBeLessThanOrEqual(r?.max as number);
    expect(representative([{ value: -10, sessions: 1 }, { value: -30, sessions: 0 }])).toMatchObject({ weighted: false, value: -20 });
    expect(groupSame([{ a: 1 }, { a: 1 }, { a: 2 }], (x) => String(x.a)).map((g) => g.rows.length)).toEqual([2, 1]);
  });
  it('세션 수는 대화 기록의 cwd 로 센다 — 홈에서 시작해 프로젝트로 들어간 세션도 그 프로젝트', () => {
    const claude = path.join(ROOT, '.claude');
    const home = path.join(ROOT, 'h');
    const proj = path.join(home, 'proj');
    const d = path.join(claude, 'projects', '-h');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 's1.jsonl'), `${JSON.stringify({ cwd: home })}\n${JSON.stringify({ cwd: path.join(proj, 'sub') })}\n`);
    fs.writeFileSync(path.join(d, 's2.jsonl'), `${JSON.stringify({ cwd: home })}\n`);
    const old = path.join(d, 's3.jsonl');
    fs.writeFileSync(old, `${JSON.stringify({ cwd: proj })}\n`);
    const t = new Date(Date.now() - 40 * 86_400_000);
    fs.utimesSync(old, t, t);
    const m = recentSessionsByFolder(claude, [home, proj]);
    expect(m.get(home)).toBe(2);
    expect(m.get(proj)).toBe(1);
  });
});

describe('#7 지시문 판별 (실데이터 표본에서 고른 모양)', () => {
  const md = (text: string) => ({ text, layer: 'project' as const });
  it.each([
    ['- `HEALTHCHECK` 명령어 반드시 포함', true],
    ['- 무한 스크롤 필터: 서버사이드 SQL WHERE에서 수행 (클라이언트 금지)', true],
    ['- useEffect 의존성 배열에 객체/배열 직접 넣지 말고 `useMemo`로 안정화', true],
    ['- Sidebar/Navigation shrink-0 필수', true],
    ['- Stop immediately when editing the same file 3+ times', true],
    ['- No empty catch blocks — at minimum log or re-throw', true],
    ['- [결정은 질문으로](feedback_x.md) — 정할 것은 본문 나열 말고 질문으로', true],
    ['- `react-best-practices.skill.md` - React/Next.js 최적화 (상세: 매뉴얼 참조)', false],
    ['- **데이터 페칭**: React Query', false],
    ['- **상태 관리**: Jotai (zustand 아님)', false],
    ['| 2 | Work Memory | `/init-memory` 커맨드 | PLANS.md 로 추적 |', false],
    ['- Go Store 파일 분리 패턴', false],
    ['- ARIA combobox 검색 UI', false],
    ['## 반복 수정 경고', false],
    ['- `deploy.skill.md` - 프로덕션 배포 절차 (빌드 후 nginx 재시작 필수!)', false],
    ['- BYOK로 외부 API를 쓰되 키와 데이터의 주권은 내가 갖는다', true],
  ])('%s → %s', (text, want) => { expect(isDirective(md(text))).toBe(want); });
  it('forgen 룰·교정 메모 파일은 언제나 지시', () => {
    expect(isDirective({ text: 'React Query', layer: 'forgen-rule' })).toBe(true);
    expect(isDirective({ text: 'React Query', layer: 'memory-topic' })).toBe(true);
  });
});

describe('#9 저장한 처방 재사용', () => {
  it('대상 파일 해시가 그대로면 저장한 처방을 돌려주고, 바뀌었으면 null(다시 계획)', () => {
    const target = path.join(ROOT, 'mem.md');
    fs.writeFileSync(target, '- a\n');
    const fix = { id: 'merge-12345678', kind: 'merge', title: 't', why: 'w', evidence: [], ops: [{ op: 'delete-line', path: target, text: '- a' }], equivalents: [], marks: [], model: false, tokens: 1 };
    fs.mkdirSync(fixDir(), { recursive: true });
    fs.writeFileSync(path.join(fixDir(), 'plan-latest.json'), JSON.stringify({ schema: 'forgen-fix-plan/1', generatedAt: 'x', fixes: [{ ...fix, hashes: { [target]: stateHash(target) } }] }));
    expect(savedFix('merge-1234')?.id).toBe('merge-12345678');
    fs.writeFileSync(target, '- a\n- b\n');
    expect(savedFix('merge-12345678')).toBeNull();
    expect(savedFix('nope')).toBeNull();
  });
});

describe('A1 사실 진술 · A2 저장 처방 나이 · B9 홈 줄이기', () => {
  it('설명문은 지시가 아니어도 사실 진술(부딪힘 후보), 표·제목·파일 목록 줄은 아님', async () => {
    const { isFactualClaim } = await import('../src/audit/checks.js');
    const md = (text: string) => ({ text, layer: 'project' as const });
    expect(isFactualClaim(md('현재 앱 구성: apps/web, apps/rss-server. OCR·주식은 제거되었습니다.'))).toBe(true);
    expect(isDirective(md('현재 앱 구성: apps/web, apps/rss-server. OCR·주식은 제거되었습니다.'))).toBe(false);
    expect(isFactualClaim(md('| 2 | apps/web | 셸 |'))).toBe(false);
    expect(isFactualClaim(md('## 구성'))).toBe(false);
  });
  it('저장 처방은 가장 최근 감사 회차보다 오래됐거나 대상 폴더가 그 뒤 바뀌면 다시 계산', () => {
    const target = path.join(ROOT, 'm2', 'mem.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '- a\n');
    const fix = { id: 'merge-aaaabbbb', kind: 'merge', title: 't', why: 'w', evidence: [], ops: [{ op: 'delete-line', path: target, text: '- a' }], equivalents: [], marks: [], model: false, tokens: 1 };
    const write = (generatedAt: string, dirs: Record<string, string>) => fs.writeFileSync(path.join(fixDir(), 'plan-latest.json'), JSON.stringify({ schema: 'forgen-fix-plan/1', generatedAt, fixes: [{ ...fix, hashes: { [target]: stateHash(target) }, dirs }] }));
    fs.mkdirSync(fixDir(), { recursive: true });
    // 대상 폴더 지문은 저장할 때와 같은 방식으로 — 새 파일이 생기면 달라진다
    write(new Date().toISOString(), {});
    expect(savedFix('merge-aaaabbbb')?.id).toBe('merge-aaaabbbb');
    write(new Date().toISOString(), { [path.dirname(target)]: 'stale-stamp' });
    expect(savedFix('merge-aaaabbbb')).toBeNull();
    // 감사 회차가 처방보다 나중이면 다시 계산
    fs.mkdirSync(path.join(process.env.FORGEN_HOME as string, 'audit', '20991231T000000Z-ffffffff'), { recursive: true });
    write('2026-01-01T00:00:00.000Z', {});
    expect(savedFix('merge-aaaabbbb')).toBeNull();
    fs.rmSync(path.join(process.env.FORGEN_HOME as string, 'audit', '20991231T000000Z-ffffffff'), { recursive: true });
  });
  it('계정 홈(/home/<이름>)은 HOME 을 바꿔 돌려도 ~ 로 줄인다', async () => {
    const { shortPath } = await import('../src/audit/html.js');
    const user = os.userInfo().username;
    expect(shortPath(`/home/${user}/proj/CLAUDE.md`, '/tmp/elsewhere')).toBe('~/proj/CLAUDE.md');
    expect(shortPath('/tmp/elsewhere/x', '/tmp/elsewhere')).toBe('~/x');
    expect(shortPath('/opt/x', '/tmp/elsewhere')).toBe('/opt/x');
  });
});

describe('그때 모습 — 교정 뒤에 덧붙인 메모로 "이미 적혀 있었다"고 세지 않는다', () => {
  it('교정 뒤 Edit 으로 교정 인용을 덧붙인 메모: 교정 시점 내용에는 그 문장이 없다', async () => {
    const { itemAt, reconstructAt } = await import('../src/audit/memory-items.js');
    const { bigrams } = await import('../src/audit/lexical.js');
    const orig = '---\nname: lean\ndescription: 화면 문구는 필요한 말만\n---\n부가 텍스트를 화면 본문에 늘어놓지 말 것.\n';
    const added = '\n2026-10-29 추가: 프로세스가 너무 길고 눌러야 할 것도 많다 — 핵심 과제는 1~3탭.\n';
    const now = orig + added;
    const writes = [
      { rel: 'x/memory/lean.md', at: '2026-10-26T00:00:00.000Z', tool: 'Write', content: orig, full: orig },
      { rel: 'x/memory/lean.md', at: '2026-10-29T10:00:00.000Z', tool: 'Edit', content: `부가 텍스트를 화면 본문에 늘어놓지 말 것.\n${added}`, edits: [{ old: '부가 텍스트를 화면 본문에 늘어놓지 말 것.\n', new: `부가 텍스트를 화면 본문에 늘어놓지 말 것.\n${added}` }] },
    ];
    // 교정은 10-29 09:00(덧붙이기 전)
    expect(reconstructAt(now, writes, '2026-10-29T09:00:00.000Z')).toBe(orig);
    const item = { key: 'topic:x/memory/lean.md', kind: 'memory-topic' as const, text: now, grams: bigrams(now), since: '2026-10-26T00:00:00.000Z', sinceVia: 'transcript-write' as const, history: { raw: now, writes } };
    const at = itemAt(item, '2026-10-29T09:00:00.000Z');
    expect(at?.text).not.toContain('눌러야 할 것');
    expect(at?.text).toContain('부가 텍스트');
    // 되돌릴 수 없는 이력(교정 뒤 통째 Write, 그 앞 전문 없음)은 시점 모름 — 세지 않음
    const w2 = [{ rel: 'x/memory/lean.md', at: '2026-10-30T00:00:00.000Z', tool: 'Write', content: now, full: now }];
    expect(itemAt({ ...item, history: { raw: now, writes: w2 } }, '2026-10-29T09:00:00.000Z')).toBeNull();
    // 덧붙인 Edit 의 대화 기록이 없는 경우(기록이 지워짐): 알려진 전문과 지금 전문에 다 있는 줄만
    const only = [writes[0]];
    expect(reconstructAt(now, only, '2026-10-29T09:00:00.000Z')).not.toContain('눌러야 할 것');
    expect(reconstructAt(now, only, '2026-10-29T09:00:00.000Z')).toContain('부가 텍스트');
    // 이력이 교정보다 앞뿐이면 지금 내용 그대로
    expect(itemAt(item, '2026-11-01T00:00:00.000Z')?.text).toBe(now);
  });
  it('forgen 룰: 처방으로 policy 가 바뀐 경우 그 앞 시점에는 처방 전 문장', async () => {
    const { itemAt } = await import('../src/audit/memory-items.js');
    const { bigrams } = await import('../src/audit/lexical.js');
    const item = { key: 'rule:r', kind: 'forgen-rule' as const, text: '새 문장', grams: bigrams('새 문장'), since: '2026-10-01T00:00:00.000Z', sinceVia: 'created_at' as const, history: { policies: [{ at: '2026-11-01T00:00:00.000Z', before: '옛 문장' }] } };
    expect(itemAt(item, '2026-10-15T00:00:00.000Z')?.text).toBe('옛 문장');
    expect(itemAt(item, '2026-11-15T00:00:00.000Z')?.text).toBe('새 문장');
  });
});

describe('범위 표시(엄격~관대)', () => {
  it('두 판본 값이 다르면 a~b, 같으면 하나', async () => {
    const { rangeText } = await import('../src/audit/recurrence.js');
    const z = { ignored: 0, notLoaded: 0, written: 0, unwrittenRepeat: 0, deletedRepeat: 0, total: 0 };
    const r = { counts: { ...z, total: 25 }, per1000: { ...z, total: 88 }, per30d: { ...z, total: 25 }, range: { strictVersion: 's', lenientVersion: 'l', lenient: { counts: { ...z, total: 43 }, per1000: { ...z, total: 153 }, per30d: { ...z, total: 43 } } } };
    expect(rangeText(r as never, 'total', 'per1000', (x) => `${Math.round(x) / 10}%`)).toBe('8.8%~15.3%');
    expect(rangeText(r as never, 'written', 'counts', String)).toBe('0');
  });
});

describe('판정 설명의 A·B 라벨', () => {
  it('글자순으로 보낸 쌍의 설명 라벨을 호출 순서로 되돌린다(영문 낱말 속 A·B 는 그대로)', async () => {
    const { swapAB } = await import('../src/audit/judge.js');
    expect(swapAB('A는 서버가 있다고, B는 제거됐다고 함')).toBe('B는 서버가 있다고, A는 제거됐다고 함');
    expect(swapAB('API 와 BFF 는 그대로, A/B 만')).toBe('API 와 BFF 는 그대로, B/A 만');
  });
});

describe('#10 도움말 언어', () => {
  it('locale ko 면 audit·fix 도움말이 한국어, en 이면 영어', async () => {
    fs.mkdirSync(process.env.FORGEN_HOME as string, { recursive: true });
    const cfg = path.join(process.env.FORGEN_HOME as string, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ locale: 'en' }));
    // GLOBAL_CONFIG 는 모듈을 읽을 때 정해진다 — 같은 경로인지 먼저 본다
    const { GLOBAL_CONFIG } = await import('../src/core/paths.js');
    if (GLOBAL_CONFIG !== cfg) return; // 다른 테스트가 경로를 먼저 정했으면 건너뜀(아래 e2e 가 본다)
    expect(fixHelp()).toContain('List prescriptions');
    expect(auditHelp()).toContain('Read-only check');
    fs.writeFileSync(cfg, JSON.stringify({ locale: 'ko' }));
    expect(fixHelp()).toContain('처방 목록을 낸다');
    expect(auditHelp()).toContain('읽기만 해서 점검한다');
  });
});

describe('#13 인용 비밀 가림', () => {
  it('키·토큰·이메일·키=값을 가리고 앞 n자만', () => {
    const q = maskQuote(`배포해 ${FAKE_KEY} 그리고 ${FAKE_GH} password=hunter2 me@example.com`, 200);
    expect(q).not.toMatch(/sk-abc|ghp_abc|hunter2|me@example\.com/);
    expect(q).toContain('password=••••');
    expect(maskQuote('가'.repeat(100), 80).length).toBe(80);
  });
});
