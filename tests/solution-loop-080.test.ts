/**
 * 0.8.0 K1~K4: 솔루션 루프 — 출처 표시, 재관측 기록, 근거 인용, 승인으로만 검증, 상태 기준 승급 시계.
 * 실제 dist CLI 로 저장하고 파일을 읽어 확인한다.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const have = fs.existsSync(path.join(DIST, 'cli.js'));

let root: string; let home: string; let fhome: string; let sol: string;
const env = () => {
  const e: Record<string, string | undefined> = { ...process.env, HOME: home, FORGEN_HOME: fhome, FORGEN_NESTED_RUN: '' };
  delete e.FORGEN_CWD; delete e.COMPOUND_CWD;
  return e as NodeJS.ProcessEnv;
};
const cli = (args: string[]) => spawnSync(process.execPath, [path.join(DIST, 'cli.js'), ...args], { encoding: 'utf-8', cwd: home, env: env(), timeout: 30000 });
const fm = (name: string) => yaml.load(fs.readFileSync(path.join(sol, `${name}.md`), 'utf-8').split('---')[1]) as Record<string, any>;
const BODY = '여러 세션에 걸친 실험에서는 먼저 격리 환경을 만들고 실제 데이터 복사본에 대고 돌린 뒤 결과를 비교한다. 이유는 실데이터 손상을 막기 위해서다.';
const save = (title: string, body: string, extra: string[]) => cli(['compound', '--solution', title, body, '--context', 'ctx', ...extra]);

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-k080-')));
  home = path.join(root, 'home'); fhome = path.join(home, '.forgen'); sol = path.join(fhome, 'me', 'solutions');
  fs.mkdirSync(sol, { recursive: true });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe.skipIf(!have)('K3·K1 자동 추출은 출처·세션·근거를 남긴다', () => {
  it('--source auto 는 extractedBy auto, 세션·인용·statusSince 를 기록', () => {
    const r = save('isolated-replay-first', BODY, ['--source', 'auto', '--session', 's1', '--quote-kind', 'user', '--quote', '실데이터에 바로 돌리지 말고 복사본에서 먼저']);
    expect(r.status, r.stderr).toBe(0);
    const f = fm('isolated-replay-first');
    expect(f).toMatchObject({ extractedBy: 'auto', status: 'candidate', evidenceSessions: ['s1'] });
    expect(f.grounding[0]).toMatchObject({ kind: 'user', session: 's1' });
    expect(typeof f.statusSince).toBe('string');
  });
  it('사람이 직접 추가하면 지금처럼 manual', () => {
    save('manual-lesson', BODY, []);
    expect(fm('manual-lesson').extractedBy).toBe('manual');
  });
});

describe.skipIf(!have)('K2 재관측은 기록하되 검증이 아니다', () => {
  it('다른 세션에서 같은 교훈 → 파일 1개, 재추출 +1, 세션 2곳, 상태 그대로', () => {
    const r = save('isolated-replay-first', BODY, ['--source', 'auto', '--session', 's2', '--quote-kind', 'assistant', '--quote', '복사본에서 돌린 결과를 비교했다']);
    expect(r.stdout).toContain('re-observed');
    const f = fm('isolated-replay-first');
    expect(f.evidenceSessions).toEqual(['s1', 's2']);
    expect(f.evidence.reExtracted).toBe(1);
    expect(f.status).toBe('candidate');
    expect(f.grounding).toHaveLength(2);
    expect(fs.readdirSync(sol).filter((x) => x.startsWith('isolated-replay-first'))).toHaveLength(1);
  });
  it('같은 세션의 반복 추출은 세지 않는다', () => {
    save('isolated-replay-first', BODY, ['--source', 'auto', '--session', 's2']);
    expect(fm('isolated-replay-first').evidence.reExtracted).toBe(1);
  });
  it('추출 모델이 같은 이름을 쓰면 본문 표현이 달라도 재관측 (본문 유사도로는 가를 수 없어서)', () => {
    save('isolated-replay-first', '실험은 격리 폴더의 복사본으로 먼저 돌리고 원본에는 마지막에만 적용한다. 원본을 망가뜨리지 않기 위해서다.', ['--source', 'auto', '--session', 's3', '--quote-kind', 'user', '--quote', '원본 말고 복사본으로 먼저 해']);
    expect(fs.existsSync(path.join(sol, 'isolated-replay-first-2.md'))).toBe(false);
    expect(fm('isolated-replay-first').evidenceSessions).toEqual(['s1', 's2', 's3']);
    expect(fm('isolated-replay-first').grounding).toHaveLength(3);
  });
  it('사람이 같은 이름으로 다시 추가하면 지금처럼 건너뛴다', () => {
    const r = save('isolated-replay-first', BODY, []);
    expect(r.stdout).toContain('already exists');
  });
  it('lifecycle 이 재관측 후보를 자동으로 verified 로 올리지 않는다', () => {
    cli(['compound', '--lifecycle', '--apply']);
    expect(fm('isolated-replay-first').status).toBe('candidate');
  });
  it('review 에 오르고, 승인하면 verified', () => {
    const list = cli(['compound', 'review']);
    expect(list.stdout).toContain('isolated-replay-first');
    expect(list.stdout).toContain('세션 3곳');
    expect(list.stdout).not.toContain('manual-lesson');
    const ok = cli(['compound', 'review', '--approve', 'isolated-replay-first', 'manual-lesson']);
    expect(ok.stdout).toContain('isolated-replay-first → verified');
    expect(ok.stdout).toContain('manual-lesson: 승인 대기 목록에 없음');
    expect(fm('isolated-replay-first').status).toBe('verified');
    expect(fm('manual-lesson').status).toBe('candidate');
  });
});

describe.skipIf(!have)('K2 0.8.0 이전 솔루션의 원래 세션', () => {
  const legacyCtx = '조건\n\n출처: proj 프로젝트 세션 abcd1234 (2026-11-06), auto-compound';
  it('Context 표식의 세션과 같은 세션이면 재관측이 아니다', () => {
    cli(['compound', '--solution', 'legacy-lesson', BODY, '--context', legacyCtx]);
    save('legacy-lesson', BODY, ['--source', 'auto', '--session', 'abcd1234-ffff-0000']);
    expect(fm('legacy-lesson').evidence.reExtracted).toBe(0);
    expect(fm('legacy-lesson').evidenceSessions).toBeUndefined();
  });
  it('다른 세션이면 원래 세션을 legacy 로 되살려 2곳으로 센다', () => {
    save('legacy-lesson', BODY, ['--source', 'auto', '--session', 'beef0000-1111']);
    expect(fm('legacy-lesson').evidenceSessions).toEqual(['legacy:abcd1234', 'beef0000-1111']);
    expect(cli(['compound', 'review']).stdout).toContain('legacy-lesson');
  });
});

describe.skipIf(!have)('K4 승급 시계는 상태가 된 날 기준', () => {
  it('매일 쓰여 updated 가 오늘이어도 statusSince 가 8일 전이면 experiment → candidate', () => {
    const old = new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const doc = { name: 'clock-check', version: 1, status: 'experiment', confidence: 0.3, type: 'pattern', scope: 'me', tags: ['a'], identifiers: [],
      evidence: { injected: 0, reflected: 3, negative: 0, sessions: 3, reExtracted: 0 }, created: old, updated: today, statusSince: old, supersedes: null, extractedBy: 'auto' };
    fs.writeFileSync(path.join(sol, 'clock-check.md'), `---\n${yaml.dump(doc)}---\n\n## Context\nc\n\n## Content\n${BODY}\n`);
    const r = cli(['compound', '--lifecycle', '--apply']);
    expect(r.status, r.stderr).toBe(0);
    const f = fm('clock-check');
    expect(f.status).toBe('candidate');
    expect(f.statusSince).toBe(today);
  });
});

describe.skipIf(!have)('K3 relabel', () => {
  it('러너 출처 표식이 있는 manual 만 고치고, 되돌릴 수 있다', () => {
    cli(['compound', '--solution', 'old-auto-lesson', BODY, '--context', '조건\n\n출처: proj 프로젝트 세션 1234abcd (2026-11-20), auto-compound']);
    expect(fm('old-auto-lesson').extractedBy).toBe('manual');
    const pre = cli(['compound', 'relabel']);
    expect(pre.stdout).toContain('old-auto-lesson');
    expect(pre.stdout).not.toContain('manual-lesson');
    expect(fm('old-auto-lesson').extractedBy).toBe('manual'); // 미리보기는 바꾸지 않음
    cli(['compound', 'relabel', '--apply']);
    expect(fm('old-auto-lesson').extractedBy).toBe('auto');
    cli(['compound', 'relabel', '--undo']);
    expect(fm('old-auto-lesson').extractedBy).toBe('manual');
  });
});

describe('K1 근거 인용 검사', async () => {
  const { quoteInSummary } = await import('../src/engine/quote-grounding.js');
  const summary = '[user] 실데이터에 바로 돌리지 말고, "복사본"에서 먼저 돌려 봐.\n[assistant] 복사본에서 돌린 결과를 비교했다.';
  it('공백·문장부호·따옴표가 달라도 같은 문장이면 통과', () => expect(quoteInSummary('실데이터에 바로 돌리지 말고 복사본에서 먼저', summary)).toBe(true));
  it('요약에 없는 문장은 거부', () => expect(quoteInSummary('실데이터에 바로 돌려도 괜찮다고 했다', summary)).toBe(false));
  it('너무 짧은 인용은 거부', () => expect(quoteInSummary('복사본', summary)).toBe(false));
});

describe('K2 프롬프트에 보여 줄 기존 이름', async () => {
  const { nearestSolutionNames } = await import('../src/engine/solution-names.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-names-'));
  const put = (name: string, tags: string[], status = 'candidate') => fs.writeFileSync(path.join(dir, `${name}.md`),
    `---\n${yaml.dump({ name, version: 1, status, confidence: 0.5, type: 'pattern', scope: 'me', tags, identifiers: [], evidence: { injected: 0, reflected: 0, negative: 0, sessions: 0, reExtracted: 0 }, created: '2026-11-01', updated: '2026-11-01', supersedes: null, extractedBy: 'auto' })}---\n\n## Context\nc\n\n## Content\nb\n`);
  put('docker-isolation', ['docker', '격리', '복사본']);
  put('unrelated', ['css', 'layout']);
  put('gone', ['docker', '격리'], 'retired');
  fs.writeFileSync(path.join(dir, 'broken.md'), 'not yaml');
  it('요약과 태그가 겹치는 순, 은퇴·깨진 파일 제외', () => {
    const names = nearestSolutionNames(dir, '도커 docker 격리 환경의 복사본에서 실험했다', 30);
    expect(names[0]).toBe('docker-isolation');
    expect(names).not.toContain('gone');
    expect(names).not.toContain('broken');
    expect(names).toContain('unrelated'); // 겹침 0 이어도 최근 것으로 채운다
  });
  it('폴더가 없으면 빈 목록', () => expect(nearestSolutionNames(path.join(dir, 'nope'), 'x', 5)).toEqual([]));
});

describe('K1 인용 정규화 (CJK 문장부호)', async () => {
  const { quoteInSummary } = await import('../src/engine/quote-grounding.js');
  it('。、「」 차이를 무시한다', () => expect(quoteInSummary('실데이터 말고、복사본에서「먼저」돌려 봐。', '[user] 실데이터 말고, 복사본에서 "먼저" 돌려 봐.')).toBe(true));
});

describe.skipIf(!have)('§8.1 자동 복귀는 candidate 로만', () => {
  it('재추출로 다시 나온 은퇴 솔루션은 은퇴 전 verified 여도 candidate 로 돌아온다', () => {
    const doc = { name: 'was-verified', version: 1, status: 'retired', retiredReason: 'stale', confidence: 0.8, type: 'pattern', scope: 'me', tags: ['a'], identifiers: [],
      evidence: { injected: 0, reflected: 0, negative: 0, sessions: 0, reExtracted: 0 }, created: '2026-10-01', updated: '2026-10-01', supersedes: null, extractedBy: 'auto' };
    fs.writeFileSync(path.join(sol, 'was-verified.md'), `---\n${yaml.dump(doc)}---\n\n## Context\nc\n\n## Content\n${BODY}\n`);
    save('was-verified', BODY, ['--source', 'auto', '--session', 'sx']);
    expect(fm('was-verified').status).toBe('candidate');
  });
  it('오너가 직접 reopen 하면 은퇴 전 수준을 유지', () => {
    const f = fm('was-verified');
    const doc = { ...f, status: 'retired', retiredReason: 'stale', confidence: 0.8 };
    fs.writeFileSync(path.join(sol, 'was-verified.md'), `---\n${yaml.dump(doc)}---\n\n## Context\nc\n\n## Content\n${BODY}\n`);
    cli(['compound', 'reopen', 'was-verified']);
    expect(fm('was-verified').status).toBe('verified');
  });
});
