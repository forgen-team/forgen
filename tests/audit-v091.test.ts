/**
 * 0.9.1 단위: #2 대표 숫자(세션 가중) · #7 지시문 판별 · #9 저장한 처방 재사용(대상 해시) · #10 도움말 언어 · #13 인용 비밀 가림.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
    const q = maskQuote('배포해 sk-abcdefghijklmnopqrstuv 그리고 ghp_abcdefghijklmnopqrstuvwx password=hunter2 me@example.com', 200);
    expect(q).not.toMatch(/sk-abc|ghp_abc|hunter2|me@example\.com/);
    expect(q).toContain('password=••••');
    expect(maskQuote('가'.repeat(100), 80).length).toBe(80);
  });
});
