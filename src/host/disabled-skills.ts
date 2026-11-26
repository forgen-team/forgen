/**
 * 사용자가 끈 forgen 스킬 기록 — `<FORGEN_HOME>/state/disabled-skills.json` (0.9.2).
 *
 * `forgen fix` 의 plugin-off 처방이 스킬을 백업 폴더로 옮겨 끄면 여기에 남기고, `forgen fix --undo` 가 지운다.
 * 스킬을 까는 모든 경로(postinstall Claude·Codex, `forgen install claude|codex`, `doctor --repair`, 세션 시작의 보완 설치)는
 * managed-marker 의 installDevGuideSkillSet 을 지나고, 그 함수가 이 기록에 있는 스킬은 깔지 않는다.
 * 형식: `{ "version": 1, "skills": { "<host>:<스킬 이름>": { "at": ISO, "fixId": "plugin-off-…" } } }` (host = claude | codex).
 *
 * 0.9.0·0.9.1 은 이 기록 없이 스킬을 껐다. 기록 파일이 없으면 처방 원장(audit/fix/ledger.jsonl)에서 되돌리지 않은
 * plugin-off 스킬 적용을 찾아 claude: 기록으로 옮긴다(처음 읽을 때 한 번). Codex 사본은 "30일 안 씀" 판정 근거(Claude 대화 기록)가
 * 없어 끄지 않는다 — codex: 기록은 형식만 받아 둔다.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type SkillHost = 'claude' | 'codex';
export interface DisabledSkills { version: 1; skills: Record<string, { at: string; fixId: string }> }

export function forgenHomeFor(homeDir: string): string {
  return process.env.FORGEN_HOME ? path.resolve(process.env.FORGEN_HOME) : path.join(homeDir, '.forgen');
}

export function disabledSkillsPath(forgenHome: string): string {
  return path.join(forgenHome, 'state', 'disabled-skills.json');
}

function readFile(forgenHome: string): DisabledSkills | null {
  try {
    const d = JSON.parse(fs.readFileSync(disabledSkillsPath(forgenHome), 'utf-8')) as Partial<DisabledSkills>;
    if (d && d.version === 1 && d.skills && typeof d.skills === 'object') return { version: 1, skills: d.skills };
  } catch { /* 없음·깨짐 */ }
  return null;
}

function writeFile(forgenHome: string, d: DisabledSkills): void {
  const p = disabledSkillsPath(forgenHome);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(d, null, 2)}\n`);
  fs.renameSync(tmp, p);
}

/** 0.9.0·0.9.1 원장에서 되돌리지 않은 plugin-off 스킬 적용 → claude: 기록. 같은 스킬은 나중 적용이 이긴다. */
export function migrateFromFixLedger(forgenHome: string): DisabledSkills['skills'] {
  const out: DisabledSkills['skills'] = {};
  let text = '';
  try { text = fs.readFileSync(path.join(forgenHome, 'audit', 'fix', 'ledger.jsonl'), 'utf-8'); } catch { return out; }
  const live = new Map<string, { at: string; backup: string }>();
  for (const line of text.split('\n')) {
    if (!line) continue;
    let e: { event?: string; id?: string; kind?: string; at?: string; backup?: string };
    try { e = JSON.parse(line); } catch { continue; }
    if (e.kind !== 'plugin-off' || typeof e.id !== 'string') continue;
    if (e.event === 'apply' && e.backup) { live.delete(e.id); live.set(e.id, { at: e.at ?? '', backup: e.backup }); }
    if (e.event === 'undo') live.delete(e.id);
  }
  for (const [id, a] of live) {
    // 백업 폴더 경로는 절대경로로 적혀 있다 — 홈을 옮긴 경우 <FORGEN_HOME>/backups/<회차>/<id> 로 다시 찾는다.
    const candidates = [a.backup, path.join(forgenHome, 'backups', path.basename(path.dirname(a.backup)), id)];
    let rec: { entries?: Array<{ path?: string; isDir?: boolean }> } | null = null;
    for (const c of candidates) {
      try { rec = JSON.parse(fs.readFileSync(path.join(c, 'backup.json'), 'utf-8')); break; } catch { /* 다음 */ }
    }
    for (const en of rec?.entries ?? []) {
      if (!en.isDir || typeof en.path !== 'string') continue;
      const name = path.basename(en.path);
      if (!name.startsWith('forgen-') || path.basename(path.dirname(en.path)) !== 'skills') continue;
      out[`claude:${name}`] = { at: a.at, fixId: id };
    }
  }
  return out;
}

/** 기록 읽기. 파일이 없으면 원장에서 옮겨 쓴다(옮길 것이 있을 때만 파일을 만든다 — persist=false 면 쓰지 않음, dry-run 용). */
export function readDisabledSkills(forgenHome: string, persist = true): DisabledSkills {
  const cur = readFile(forgenHome);
  if (cur) return cur;
  const skills = migrateFromFixLedger(forgenHome);
  const d: DisabledSkills = { version: 1, skills };
  if (persist && Object.keys(skills).length) {
    try { writeFile(forgenHome, d); } catch { /* 읽기 전용 등 — 이번 설치에서는 그대로 존중 */ }
  }
  return d;
}

export function recordDisabledSkill(forgenHome: string, host: SkillHost, name: string, fixId: string, at: string): void {
  const d = readDisabledSkills(forgenHome);
  d.skills[`${host}:${name}`] = { at, fixId };
  writeFile(forgenHome, d);
}

/** 그 처방으로 끈 기록을 지운다(forgen fix --undo). 지운 수. */
export function forgetDisabledSkillsByFix(forgenHome: string, fixId: string): number {
  const d = readDisabledSkills(forgenHome);
  const keys = Object.keys(d.skills).filter((k) => d.skills[k].fixId === fixId);
  if (!keys.length) return 0;
  for (const k of keys) delete d.skills[k];
  writeFile(forgenHome, d);
  return keys.length;
}

/** 설치 경로가 내는 한 줄 알림. */
export function keptOffNotice(keptOff: Array<{ name: string; fixId: string }>): string | null {
  if (!keptOff.length) return null;
  const ids = [...new Set(keptOff.map((k) => k.fixId))];
  const shown = ids.slice(0, 3).join(', ');
  return `끈 스킬 ${keptOff.length}개는 그대로 둠 — 다시 켜기: forgen fix --undo <id> (${shown}${ids.length > 3 ? ` 외 ${ids.length - 3}개` : ''})`;
}
