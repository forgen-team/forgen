/**
 * 0.9.0 감사 기본(C1) — docs/plans/2026-11-25-v1.0-plan.md §4.1 결정적 검사, §12.1-4 합성 A·B·C 축소판.
 * 모든 파일은 임시 HOME·FORGEN_HOME 안에 만든다. 실제 ~/.claude·~/.forgen 은 건드리지 않는다.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fg-audit-')));
const HOME = path.join(ROOT, 'home');
const FH = path.join(HOME, '.forgen');
const CLAUDE = path.join(HOME, '.claude');
fs.mkdirSync(CLAUDE, { recursive: true });
const PREV = { HOME: process.env.HOME, FORGEN_HOME: process.env.FORGEN_HOME, FORGEN_CWD: process.env.FORGEN_CWD };
process.env.HOME = HOME;
process.env.FORGEN_HOME = FH;
delete process.env.FORGEN_CWD;

const { runAudit, writeRun, resultDigest } = await import('../src/audit/run.js');
const { renderAuditHtml, topLines } = await import('../src/audit/html.js');
const { estimateTokens } = await import('../src/audit/tokens.js');
const { parseRulePaths, importTargets, encodeProjectDir } = await import('../src/audit/sources.js');
const { normalizeSentence } = await import('../src/audit/checks.js');
const { createRule, saveRule } = await import('../src/store/rule-store.js');
const { handleAudit } = await import('../src/audit/cli.js');

const W = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const SHARED = '- Always run the full test suite before reporting a task as finished';
const A = path.join(ROOT, 'work', 'proj-a');
const B = path.join(ROOT, 'work', 'proj-b');
const Cdir = path.join(ROOT, 'work', 'projc');
const FOLDERS = [A, B, Cdir, HOME];

function hashTree(dir: string, skip: string[] = []): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    let names: string[] = [];
    try { names = fs.readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      const p = path.join(d, n);
      if (skip.some((s) => p === s || p.startsWith(`${s}/`))) continue;
      let st: fs.Stats;
      try { st = fs.lstatSync(p); } catch { continue; }
      // 폴더는 목록(아래로 내려가며 해시)과 권한만 — audit/ 를 만들면 부모 폴더 시각이 바뀌는 것은 결과물 쪽이다.
      h.update(st.isDirectory() ? `${p}|${st.mode}|` : `${p}|${st.mode}|${st.mtimeMs}|`);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) { try { h.update(fs.readFileSync(p)); } catch { h.update('unreadable'); } }
    }
  };
  walk(dir);
  return h.digest('hex');
}

beforeAll(() => {
  // 사용자 층: 같은 문장 + @import(서로를 들여오는 순환) + 다른 프로젝트 이야기
  W(path.join(CLAUDE, 'CLAUDE.md'), `# Global\n${SHARED}\n- Keep answers short\n- projc release checklist lives in the team wiki\n@extra.md\n`);
  W(path.join(CLAUDE, 'extra.md'), '- Imported guidance line that is long enough\n@CLAUDE.md\n');
  W(path.join(CLAUDE, 'rules', 'style.md'), '- Prefer small focused commits in every repository\n');

  // 합성 A: 300줄 단일 CLAUDE.md, 같은 문장·낡은 경로·없는 npm 스크립트
  fs.mkdirSync(path.join(A, '.git'), { recursive: true });
  fs.mkdirSync(path.join(A, 'docs'), { recursive: true });
  W(path.join(A, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
  const body = Array.from({ length: 296 }, (_, i) => `- Synthetic instruction number ${i} for the fixture`);
  W(path.join(A, 'CLAUDE.md'), [`# Project A`, SHARED, '- Read notes at ~/missing-dir/notes.md before starting', '- Design doc: `docs/missing-design.md`', '- Run `npm run nonexistent-script` to lint', ...body].join('\n'));

  // 합성 B: 사용자·프로젝트·로컬 3층 + .claude/rules 20개(paths 있는 10 · 없는 10) + AGENTS.md
  fs.mkdirSync(path.join(B, '.git'), { recursive: true });
  W(path.join(B, 'CLAUDE.md'), '- Project B uses the synthetic widget toolkit\n');
  W(path.join(B, 'CLAUDE.local.md'), '- Local only override for this machine\n');
  W(path.join(B, 'AGENTS.md'), `${SHARED}\n- Agents file guidance line for project B\n`);
  for (let i = 0; i < 20; i++) {
    const fm = i < 10 ? (i % 3 === 0 ? '---\npaths:\n  - "src/**/*.ts"\n  - lib/**\n---\n' : i % 3 === 1 ? '---\npaths: "src/api/**"\n---\n' : '---\npaths: ["a/**", "b/**"]\n---\n') : (i === 19 ? '---\ndescription: no paths here\n---\n' : '');
    W(path.join(B, '.claude', 'rules', `r${String(i).padStart(2, '0')}.md`), `${fm}- Rule file ${i} says something specific enough\n`);
  }

  // 합성 C: MEMORY.md 230줄·27KB 넘음, 주제 파일 100개(색인 안 된 것 포함), 다른 프로젝트 이야기
  fs.mkdirSync(path.join(Cdir, '.git'), { recursive: true });
  const mem = path.join(CLAUDE, 'projects', encodeProjectDir(Cdir), 'memory');
  const idx = ['# Memory'];
  for (let i = 0; i < 229; i++) idx.push(`- [Topic ${i}](topic_${i}.md) — ${'synthetic description text '.repeat(4)}${i}`);
  W(path.join(mem, 'MEMORY.md'), `${idx.join('\n')}\n`);
  for (let i = 0; i < 100; i++) W(path.join(mem, `topic_${i}.md`), `---\nname: t${i}\ntype: ${i % 2 ? 'feedback' : 'project'}\n---\nbody ${i}\n`);
  W(path.join(mem, 'orphan_note.md'), '---\ntype: user\n---\nnot indexed\n');
  // 홈 메모: 다른 프로젝트(projc) 이야기 + 없는 주제 파일 링크
  const homeMem = path.join(CLAUDE, 'projects', encodeProjectDir(HOME), 'memory');
  W(path.join(homeMem, 'MEMORY.md'), '- [projc deploy order](missing_topic.md) — restart sequence for the projc servers\n- [General habit](general.md) — answers in short paragraphs\n');
  W(path.join(homeMem, 'general.md'), '---\ntype: feedback\n---\nshort answers\n');

  // forgen 룰: 전역인데 한 프로젝트 이야기 · 같은 문장 · 깨진 파일
  const mk = (policy: string, extra: Record<string, unknown> = {}) => saveRule({ ...createRule({ category: 'workflow', scope: 'me', trigger: policy.slice(0, 10), policy, strength: 'default', source: 'explicit_correction', render_key: `w.${policy.length}.${policy.slice(0, 6)}` }), ...extra } as never);
  mk('For projc always rebuild the synthetic image before testing');
  mk(SHARED.slice(2));
  mk('Scoped rule only for proj-a work', { projects: ['proj-a'] });
  W(path.join(FH, 'me', 'rules', 'broken.json'), '{ not json');
  fs.mkdirSync(path.join(FH, 'state'), { recursive: true });
  W(path.join(FH, 'state', 'marker.json'), '{}');
});

afterAll(() => {
  for (const [k, v] of Object.entries(PREV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('토큰 근사 · 파서', () => {
  it('ASCII 4자 ≈ 1, 그 밖 1자 ≈ 0.9', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('가나다라마바사아자차')).toBe(9);
    expect(estimateTokens('')).toBe(0);
  });
  it('paths: 앞머리 세 형태와 없음', () => {
    expect(parseRulePaths('---\npaths:\n  - "src/**"\n  - lib/**\n---\nx')).toEqual(['src/**', 'lib/**']);
    expect(parseRulePaths('---\npaths: "a/**"\n---\n')).toEqual(['a/**']);
    expect(parseRulePaths('---\npaths: [a/**, "b/**"]\n---\n')).toEqual(['a/**', 'b/**']);
    expect(parseRulePaths('---\ndescription: x\n---\n')).toBeNull();
    expect(parseRulePaths('no frontmatter')).toBeNull();
  });
  it('@import 는 코드 블록·인라인 코드·메일 주소를 무시하고 있는 파일만', () => {
    const f = path.join(CLAUDE, 'CLAUDE.md');
    expect(importTargets(f, '@extra.md\n`@extra.md`\n```\n@extra.md\n```\nmail a@b.com\n@nope.md', HOME)).toEqual([path.join(CLAUDE, 'extra.md')]);
  });
  it('같은 문장 정규화', () => {
    expect(normalizeSentence('- **Always** run `tests`!')).toBe(normalizeSentence('* Always run tests'));
  });
});

describe('forgen audit — 합성 픽스처', () => {
  it('심어 둔 문제를 찾는다(A·B·C)', () => {
    const { result: r } = runAudit({ folders: FOLDERS, claudeDir: CLAUDE });
    const c = r.checks;
    // 잘림: 230줄·27KB 넘음 → 잘린 색인 줄, 여유 0
    const t = c.truncation.find((x) => x.folder === Cdir || x.dir.includes(encodeProjectDir(Cdir)));
    expect(t).toBeDefined();
    expect(t?.overLines).toBe(true);
    expect(t?.overBytes).toBe(true);
    expect(t?.cutItems.length).toBeGreaterThan(29);
    expect(t?.spareItems).toBe(0);
    expect(t?.unindexedTopics).toContain('orphan_note.md');
    expect(r.summary.truncation.truncated).toBe(1);
    // 크기: 300줄 CLAUDE.md
    expect(c.claudeMdOver200.map((x) => x.path)).toContain(path.join(A, 'CLAUDE.md'));
    // 같은 문장: 사용자 CLAUDE.md · 프로젝트 A · AGENTS.md(B) · forgen 룰
    const g = c.sameSentence.find((x) => x.norm === normalizeSentence(SHARED));
    expect(g).toBeDefined();
    expect(new Set(g?.occurrences.map((o) => o.layer))).toEqual(new Set(['user', 'project', 'agents', 'forgen-rule']));
    // 낡음: 홈 경로·백틱 상대 경로·npm 스크립트·메모 링크
    const refs = c.stale.map((s) => `${s.kind}:${s.ref}`);
    expect(refs).toEqual(expect.arrayContaining(['file:~/missing-dir/notes.md', 'file:docs/missing-design.md', 'npm-script:npm run nonexistent-script', 'link:missing_topic.md']));
    expect(refs).not.toContain('link:general.md');
    // paths: 없는 룰: B 의 10개 + 사용자 룰 1개
    const unscoped = c.unscopedRules.map((u) => path.basename(u.path)).sort();
    expect(unscoped.filter((n) => /^r\d\d\.md$/.test(n))).toEqual(Array.from({ length: 10 }, (_, i) => `r${10 + i}.md`));
    expect(unscoped).toContain('style.md');
    // 섞임 후보: 사용자 CLAUDE.md · 홈 메모 색인 · forgen 전역 룰 — 모두 projc
    const mixLayers = c.mix.filter((m) => m.project === 'projc').map((m) => m.layer).sort();
    expect(mixLayers).toEqual(['forgen-rule', 'memory-index', 'user']);
    expect(c.mix.some((m) => m.text.includes('Scoped rule only'))).toBe(false);
    // 깨진 forgen 룰은 건너뛰고 보고
    expect(r.sources.brokenRules.map((b) => b.file)).toContain('broken.json');
  });

  it('폴더별 층: import(순환 방지)·로컬·AGENTS·조건부 룰·MEMORY.md 앞부분·forgen 렌더', () => {
    const { result: r } = runAudit({ folders: FOLDERS, claudeDir: CLAUDE });
    const fb = r.folders.find((f) => f.folder === B);
    expect(fb).toBeDefined();
    const layers = new Set(fb?.entries.map((e) => e.layer));
    for (const l of ['user', 'import', 'user-rules', 'project', 'project-local', 'agents', 'project-rules']) expect(layers.has(l as never)).toBe(true);
    expect(fb?.entries.filter((e) => e.layer === 'import')).toHaveLength(1);
    expect(fb?.entries.filter((e) => e.layer === 'project-rules' && !e.always)).toHaveLength(10);
    const always = fb?.entries.filter((e) => e.always).reduce((n, e) => n + e.tokens, 0) ?? 0;
    expect(fb?.totalTokens).toBe(always + (fb?.byLayer['forgen-render'] ?? 0));
    expect(fb?.byLayer['forgen-render']).toBeGreaterThan(0);
    // 프로젝트 전용 룰은 그 프로젝트에서만 실린다
    const fa = r.folders.find((f) => f.folder === A);
    expect((fa?.forgenRules ?? 0) - (fb?.forgenRules ?? 0)).toBe(1);
    // MEMORY.md 는 잘린 앞부분만 센다
    const fc = r.folders.find((f) => f.folder === Cdir);
    expect(fc?.byLayer['memory-index']).toBeLessThan(estimateTokens(fs.readFileSync(path.join(CLAUDE, 'projects', encodeProjectDir(Cdir), 'memory', 'MEMORY.md'), 'utf-8')));
    // 같은 문장 사본은 줄일 몫
    expect(fa?.reducible.duplicate).toBeGreaterThan(0);
    expect(topLines(r)).toHaveLength(4);
  });

  it('읽기 전용: 원천·~/.forgen 의 me·state 해시가 실행 전후 같고, 쓰는 곳은 audit/<회차>/ 뿐', () => {
    const audit = path.join(FH, 'audit');
    const before = hashTree(ROOT, [audit]);
    const meBefore = hashTree(path.join(FH, 'me'));
    const stBefore = hashTree(path.join(FH, 'state'));
    const run = runAudit({ folders: FOLDERS, claudeDir: CLAUDE });
    const out = writeRun(run, renderAuditHtml);
    expect(hashTree(ROOT, [audit])).toBe(before);
    expect(hashTree(path.join(FH, 'me'))).toBe(meBefore);
    expect(hashTree(path.join(FH, 'state'))).toBe(stBefore);
    expect(fs.readdirSync(out.dir).sort()).toEqual(['audit.html', 'manifest.json', 'result.json']);
    if (process.platform !== 'win32') {
      expect(fs.statSync(out.htmlPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(out.manifestPath).mode & 0o777).toBe(0o600);
    }
    const html = fs.readFileSync(out.htmlPath, 'utf-8');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<(?:script|link|img)[^>]+(?:src|href)=["']?https?:/i);
    const m = JSON.parse(fs.readFileSync(out.manifestPath, 'utf-8'));
    expect(m.runId).toBe(out.runId);
    expect(m.sources.find((s: { path: string }) => s.path === path.join(A, 'CLAUDE.md'))?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('결정성: 두 번 실행해도 같은 숫자(생성 시각 제외)·같은 원천 해시', () => {
    const a = runAudit({ folders: FOLDERS, claudeDir: CLAUDE, now: new Date('2026-11-25T00:00:00Z') });
    const b = runAudit({ folders: [...FOLDERS].reverse(), claudeDir: CLAUDE, now: new Date('2026-11-26T00:00:00Z') });
    expect(resultDigest(a.result)).toBe(resultDigest(b.result));
    expect(a.manifest.sourcesDigest).toBe(b.manifest.sourcesDigest);
    expect(JSON.stringify({ ...a.result, generatedAt: '' })).toBe(JSON.stringify({ ...b.result, generatedAt: '' }));
  });

  it('깨진 파일·권한 없음·없는 폴더에서 죽지 않는다', () => {
    const locked = path.join(B, '.claude', 'rules', 'zz-locked.md');
    W(locked, '- locked rule file content for the test\n');
    W(path.join(B, '.claude', 'rules', 'zz-badfm.md'), '---\npaths:\n  - "x/**"\n(no closing fence\n');
    W(path.join(CLAUDE, 'projects', encodeProjectDir(path.join(ROOT, 'gone')), 'memory', 'MEMORY.md'), '\u0000\u0001 binary junk');
    fs.chmodSync(locked, 0o000);
    try {
      const { result: r } = runAudit({ folders: [...FOLDERS, path.join(ROOT, 'does-not-exist')], claudeDir: CLAUDE });
      const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
      if (!asRoot) expect(r.sources.unreadable.map((u) => u.path)).toContain(locked);
      expect(r.folders.length).toBe(5);
    } finally {
      fs.chmodSync(locked, 0o644);
      fs.rmSync(locked); fs.rmSync(path.join(B, '.claude', 'rules', 'zz-badfm.md'));
      fs.rmSync(path.join(CLAUDE, 'projects', encodeProjectDir(path.join(ROOT, 'gone'))), { recursive: true });
    }
  });

  it('읽기 전용 렌더가 세션 시작 렌더(bootstrapV1Session)와 같은 블록을 만든다', async () => {
    const { renderSessionStartReadOnly, bootstrapV1Session } = await import('../src/core/v1-bootstrap.js');
    const ro = renderSessionStartReadOnly(A);
    // bootstrap 은 상태를 쓰므로 비교용 복사본에서 돌린다
    const copy = path.join(ROOT, 'fh-copy');
    fs.cpSync(FH, copy, { recursive: true });
    const prevCwd = process.env.FORGEN_CWD;
    process.env.FORGEN_CWD = A;
    try {
      const live = bootstrapV1Session(A, { trackInjection: false });
      expect(ro.text).toBe(live.renderedRules ?? '');
      expect([...ro.includedRuleIds].sort()).toEqual([...(live.includedRuleIds ?? [])].sort());
    } finally {
      if (prevCwd === undefined) delete process.env.FORGEN_CWD; else process.env.FORGEN_CWD = prevCwd;
      fs.rmSync(FH, { recursive: true, force: true });
      fs.cpSync(copy, FH, { recursive: true });
    }
  });
});

describe('스킬 목록 층 · manifest 입력 지문 (C1 비평 반영)', () => {
  it('사용자 스킬과 켜진 플러그인의 스킬·에이전트 앞머리를 세고, 꺼진 플러그인은 세지 않는다', async () => {
    const { readSkillCatalog, SourceReader } = await import('../src/audit/sources.js');
    const cd = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-skills-'));
    const w = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
    w(path.join(cd, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: does alpha things for tests\n---\nbody not counted '.repeat(1) + 'x'.repeat(5000));
    const on = path.join(cd, 'plugins', 'cache', 'on'); const off = path.join(cd, 'plugins', 'cache', 'off');
    w(path.join(on, 'skills', 'beta', 'SKILL.md'), '---\nname: beta\ndescription: beta\n---\n');
    w(path.join(on, 'agents', 'gamma.md'), '---\nname: gamma\ndescription: gamma agent\n---\n');
    w(path.join(off, 'skills', 'delta', 'SKILL.md'), '---\nname: delta\ndescription: delta\n---\n');
    w(path.join(cd, 'settings.json'), JSON.stringify({ enabledPlugins: { 'on@m': true, 'off@m': false } }));
    w(path.join(cd, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'on@m': [{ installPath: on }], 'off@m': [{ installPath: off }] } }));
    const s = readSkillCatalog(new SourceReader(), { claudeDir: cd, home: cd, managedPaths: [] });
    expect(s.map((e) => `${e.source}:${e.kind}:${e.name}`)).toEqual(['plugin:on:skill:beta', 'plugin:on:agent:gamma', 'user:skill:alpha']);
    expect(s.find((e) => e.name === 'alpha')!.tokens).toBeLessThan(30); // 본문은 세지 않는다
    fs.rmSync(cd, { recursive: true, force: true });
  });
  it('manifest 에 대화 기록·근거 파일 지문이 들어가고, 대화 기록이 바뀌면 inputsDigest 가 바뀐다', () => {
    const a = runAudit({ folders: FOLDERS, claudeDir: CLAUDE });
    const extra = path.join(CLAUDE, 'projects', 'p-digest', 's.jsonl');
    fs.mkdirSync(path.dirname(extra), { recursive: true });
    fs.writeFileSync(extra, '{}\n');
    try {
      const b = runAudit({ folders: FOLDERS, claudeDir: CLAUDE });
      expect(a.manifest.inputsDigest).not.toBe('none');
      expect(b.manifest.inputsDigest).not.toBe(a.manifest.inputsDigest);
      expect(b.manifest.sourcesDigest).toBe(a.manifest.sourcesDigest);
    } finally { fs.rmSync(path.dirname(extra), { recursive: true, force: true }); }
    expect(runAudit({ folders: FOLDERS, claudeDir: CLAUDE, sessionEvidence: false }).manifest.inputsDigest).toBe('none');
  });
});

describe('forgen audit CLI', () => {
  it('audit tokens 는 아무것도 쓰지 않고 폴더별 토큰을 낸다', async () => {
    const before = hashTree(ROOT);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handleAudit(['tokens', '--folder', A, '--folder', B, '--claude-dir', CLAUDE, '--json']);
      const out = JSON.parse(String(log.mock.calls[0][0]));
      expect(out.folders.map((f: { folder: string }) => f.folder)).toEqual([A, B]);
    } finally { log.mockRestore(); }
    expect(hashTree(ROOT)).toBe(before);
  });

  it('audit 은 회차 폴더를 만들고 요약 네 줄을 찍는다 · 모르는 하위 명령·옵션은 실패', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prevExit = process.exitCode;
    try {
      await handleAudit(['--folder', A, '--claude-dir', CLAUDE, '--no-open', '--timing', '--no-model']);
      const text = log.mock.calls.map((c) => String(c[0])).join('\n');
      expect(text).toContain('아직 재지 않음');
      expect(text).toContain('MEMORY.md 가 상한에 잘린 곳');
      expect(text).toMatch(/시간\(ms\): 원천 \d+/);
      await handleAudit(['nope']);
      expect(process.exitCode).toBe(1);
      process.exitCode = prevExit;
      await handleAudit(['--bogus']);
      expect(process.exitCode).toBe(1);
    } finally { log.mockRestore(); err.mockRestore(); process.exitCode = prevExit; }
  });
});
