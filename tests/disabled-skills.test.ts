/**
 * 0.9.2 — 업그레이드에서 나온 결함 2개(docs/plans/2026-11-26-v0.9.2-upgrade-fixes.md).
 * 1. 사용자가 `forgen fix` 로 끈 forgen 스킬은 설치·업그레이드(같은 함수 installDevGuideSkillSet)가 다시 깔지 않는다.
 *    0.9.0·0.9.1 원장의 되돌리지 않은 plugin-off 스킬 적용은 처음 읽을 때 claude: 기록으로 옮긴다.
 * 2. 저장된 재생 결과의 판정 방식이 지금과 다르면 첫 화면이 옛 값이라고 밝힌다(forgen 버전만 다른 것은 경고 안 함).
 * 모든 파일은 임시 폴더 안.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { disabledSkillsPath, forgetDisabledSkillsByFix, keptOffNotice, readDisabledSkills, recordDisabledSkill } from '../src/host/disabled-skills.js';
import { installDevGuideSkillSet, listDevGuideSkillNames } from '../src/host/managed-marker.js';
import { planClaudeInstall } from '../src/host/install-claude.js';
import { judgeChanges, judgeInfo, recurrenceLine, STALE_JUDGE_NOTE, type RecurrenceResult } from '../src/audit/recurrence.js';
import { PAIR_PROMPT_LENIENT_VERSION } from '../src/audit/judge.js';

const PKG = process.cwd();
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fg-v092-')));
const NAMES = [...listDevGuideSkillNames(PKG)].sort();
let n = 0;
let home = '';
let fh = '';
const PREV_FH = process.env.FORGEN_HOME;

beforeEach(() => {
  home = path.join(ROOT, `h${n++}`);
  fh = path.join(home, '.forgen');
  fs.mkdirSync(home, { recursive: true });
  process.env.FORGEN_HOME = fh;
});
afterAll(() => {
  if (PREV_FH === undefined) delete process.env.FORGEN_HOME; else process.env.FORGEN_HOME = PREV_FH;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** 0.9.0·0.9.1 식 적용 흔적: 스킬 폴더를 백업으로 옮기고 원장에 apply 한 줄(기록 파일 없음). */
function oldApply(name: string, id: string, backupRoot = path.join(fh, 'backups', 'fix-20261126T000000Z')): void {
  const dir = path.join(backupRoot, id);
  const skill = path.join(home, '.claude', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(skill)) fs.renameSync(skill, path.join(dir, 'moved-away'));
  fs.writeFileSync(path.join(dir, 'backup.json'), JSON.stringify({ schema: 'forgen-fix-backup/1', id, kind: 'plugin-off', at: '2026-11-26T00:00:00.000Z', title: name, entries: [{ path: skill, before: 'dir:x', after: 'absent', existed: true, isDir: true, slot: '0' }], marks: 0 }));
  fs.mkdirSync(path.join(fh, 'audit', 'fix'), { recursive: true });
  fs.appendFileSync(path.join(fh, 'audit', 'fix', 'ledger.jsonl'), `${JSON.stringify({ at: '2026-11-26T00:00:00.000Z', event: 'apply', id, kind: 'plugin-off', backup: dir, equivalents: [] })}\n`);
}

describe('0.9.2 #1 끈 스킬은 업그레이드 뒤에도 꺼져 있다', () => {
  it('기록에 있는 스킬은 Claude·Codex 설치 모두 깔지 않고, 기록에 없는 스킬(새 스킬 포함)은 깐다', () => {
    expect(NAMES.length).toBeGreaterThan(3);
    const [a, b] = NAMES;
    recordDisabledSkill(fh, 'claude', a, 'plugin-off-aaaa1111', '2026-11-26T00:00:00.000Z');
    recordDisabledSkill(fh, 'codex', b, 'plugin-off-bbbb2222', '2026-11-26T00:00:00.000Z');
    const claudeDir = path.join(home, '.claude', 'skills');
    const codexDir = path.join(home, '.codex', 'skills');
    // 이전 버전이 깔아 둔 사본(업그레이드 상황) — 정리된 뒤 다시 깔리지 않아야 한다
    for (const d of [claudeDir, codexDir]) { fs.mkdirSync(path.join(d, a), { recursive: true }); fs.mkdirSync(path.join(d, b), { recursive: true }); }
    fs.symlinkSync(path.join(PKG, 'assets', 'dev-guide', 'x', 'SKILL.md'), path.join(claudeDir, a, 'SKILL.md'));
    fs.symlinkSync(path.join(PKG, 'assets', 'dev-guide', 'x', 'SKILL.md'), path.join(codexDir, b, 'SKILL.md'));
    const c = installDevGuideSkillSet({ pkgRoot: PKG, skillsDir: claudeDir, host: 'claude', forgenHome: fh });
    const x = installDevGuideSkillSet({ pkgRoot: PKG, skillsDir: codexDir, host: 'codex', forgenHome: fh });
    expect(fs.existsSync(path.join(claudeDir, a))).toBe(false);
    expect(fs.existsSync(path.join(claudeDir, b, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(codexDir, b))).toBe(false);
    expect(fs.existsSync(path.join(codexDir, a, 'SKILL.md'))).toBe(true);
    expect(c.keptOff).toEqual([{ name: a, fixId: 'plugin-off-aaaa1111' }]);
    expect(x.keptOff).toEqual([{ name: b, fixId: 'plugin-off-bbbb2222' }]);
    expect(c.installed).toBe(NAMES.length - 1);
    expect(keptOffNotice(c.keptOff)).toBe('끈 스킬 1개는 그대로 둠 — 다시 켜기: forgen fix --undo <id> (plugin-off-aaaa1111)');
    expect(keptOffNotice([])).toBeNull();
  });

  it('forgen install claude(planClaudeInstall) 경로도 기록을 존중하고 결과에 알린다', () => {
    recordDisabledSkill(fh, 'claude', NAMES[2], 'plugin-off-cccc3333', '2026-11-26T00:00:00.000Z');
    const r = planClaudeInstall({ pkgRoot: PKG, homeDir: home });
    expect(r.errors).toEqual([]);
    expect(r.skillsKeptOff).toEqual([{ name: NAMES[2], fixId: 'plugin-off-cccc3333' }]);
    expect(fs.existsSync(path.join(home, '.claude', 'skills', NAMES[2]))).toBe(false);
    expect(fs.existsSync(path.join(home, '.claude', 'skills', NAMES[3], 'SKILL.md'))).toBe(true);
  });

  it('0.9.0·0.9.1 원장 이전: 되돌리지 않은 plugin-off 스킬 적용 → claude: 기록(홈을 옮긴 백업 경로도 찾음), 되돌린 것·Codex 는 기록 안 함', () => {
    planClaudeInstall({ pkgRoot: PKG, homeDir: home });
    oldApply(NAMES[0], 'plugin-off-00000001');
    oldApply(NAMES[1], 'plugin-off-00000002');
    // 되돌린 적용
    fs.appendFileSync(path.join(fh, 'audit', 'fix', 'ledger.jsonl'), `${JSON.stringify({ at: '2026-11-26T00:01:00.000Z', event: 'undo', id: 'plugin-off-00000002', kind: 'plugin-off' })}\n`);
    // 다른 홈에서 옮겨 온 원장: backup 경로가 옛 절대경로
    const moved = path.join(fh, 'backups', 'fix-20261126T000500Z');
    oldApply(NAMES[2], 'plugin-off-00000003', moved);
    const led = path.join(fh, 'audit', 'fix', 'ledger.jsonl');
    fs.writeFileSync(led, fs.readFileSync(led, 'utf-8').replace(path.join(moved, 'plugin-off-00000003'), '/old/home/.forgen/backups/fix-20261126T000500Z/plugin-off-00000003'));
    expect(fs.existsSync(disabledSkillsPath(fh))).toBe(false);
    const d = readDisabledSkills(fh);
    expect(Object.keys(d.skills).sort()).toEqual([`claude:${NAMES[0]}`, `claude:${NAMES[2]}`].sort());
    expect(d.skills[`claude:${NAMES[0]}`].fixId).toBe('plugin-off-00000001');
    expect(JSON.parse(fs.readFileSync(disabledSkillsPath(fh), 'utf-8')).version).toBe(1);
    // 업그레이드(설치 경로)가 이전 기록을 존중
    const r = planClaudeInstall({ pkgRoot: PKG, homeDir: home });
    expect(r.skillsKeptOff.map((k) => k.name).sort()).toEqual([NAMES[0], NAMES[2]].sort());
    expect(fs.existsSync(path.join(home, '.claude', 'skills', NAMES[0]))).toBe(false);
    expect(fs.existsSync(path.join(home, '.claude', 'skills', NAMES[1], 'SKILL.md'))).toBe(true);
    // 되돌리기는 그 처방의 기록만 지운다
    expect(forgetDisabledSkillsByFix(fh, 'plugin-off-00000001')).toBe(1);
    expect(Object.keys(readDisabledSkills(fh).skills)).toEqual([`claude:${NAMES[2]}`]);
  });

  it('원장도 기록도 없으면 파일을 만들지 않는다', () => {
    expect(readDisabledSkills(fh).skills).toEqual({});
    expect(fs.existsSync(disabledSkillsPath(fh))).toBe(false);
  });
});

describe('0.9.2 #2 옛 판정 방식 재생 결과', () => {
  const now = judgeInfo();
  const base = (over: Partial<RecurrenceResult> = {}): RecurrenceResult => ({
    schema: 'forgen-audit-recurrence/2', forgenVersion: '0.9.1', generatedAt: '2026-11-26T04:19:26.000Z', claudeDir: '/x',
    window: { since: '2026-10-27', until: '2026-11-26', lookbackDays: 30, days: 30 }, judge: now, status: 'ok', statusNote: '',
    prompts: { window: 284, lookback: 0, sampled: 284, judged: 284, unjudged: 0, limit: null, per30d: 284 },
    corrections: { total: 94, taskSpecific: 0, lookback: 0, per1000: 0, per30d: 94, becameMemory: 0 },
    counts: { ignored: 5, notLoaded: 6, written: 11, unwrittenRepeat: 10, deletedRepeat: 0, total: 21 },
    per1000: { ignored: 0, notLoaded: 0, written: 0, unwrittenRepeat: 0, deletedRepeat: 0, total: 135 },
    per30d: { ignored: 5, notLoaded: 6, written: 11, unwrittenRepeat: 10, deletedRepeat: 0, total: 21 },
    ci95per1000: { total: [0, 0], written: [0, 0] }, unknown: 0, pairsJudged: 0,
    memory: { items: 0, byKind: {}, unknownTime: 0, deleted: 0 }, loadedVia: { renderLog: 0, replay: 0 }, notes: [], items: [],
    range: { strictVersion: now.pair.version, lenientVersion: PAIR_PROMPT_LENIENT_VERSION, lenient: { counts: {} as never, per1000: {} as never, per30d: {} as never } },
    ...over,
  } as RecurrenceResult);

  it('forgen 버전만 다르면 경고하지 않는다', () => {
    const r = base({ forgenVersion: '0.9.0' });
    expect(judgeChanges(r)).toEqual([]);
    expect(recurrenceLine(r)).not.toContain(STALE_JUDGE_NOTE);
  });

  it('쌍 판정 문안 번호·모델·후보 고르기가 다르면 옛 값이라고 밝히고 범위 대신 그때 값 하나만', () => {
    const old = base({ judge: { ...now, pair: { ...now.pair, version: 'n4-pair/3' } }, range: undefined });
    expect(judgeChanges(old)).toEqual([`pair.version: n4-pair/3 → ${now.pair.version}`]);
    const line = recurrenceLine(old);
    expect(line).toContain(STALE_JUDGE_NOTE);
    expect(line).toContain('옛 값 13.5%');
    expect(line).not.toMatch(/\d+~\d+/);
    expect(judgeChanges(base({ judge: { ...now, correction: { ...now.correction, model: 'other' } } }))).toHaveLength(1);
    expect(judgeChanges(base({ judge: { ...now, prefilterMin: 0.1 } }))).toHaveLength(1);
    expect(judgeChanges(base({ range: { ...base().range!, lenientVersion: 'n4-pair/0' } }))).toHaveLength(1);
  });
});
