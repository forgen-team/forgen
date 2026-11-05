/**
 * Way 입출력 — 파일 쓰기 보호, json 가져오기, 호스트 메모리 수집.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { CLAUDE_DIR } from '../core/paths.js';
import { createRule, loadRule, saveRule } from '../store/rule-store.js';
import { projectKeyFor } from '../store/rule-scope.js';
import { withStatusChange } from '../store/rule-lifecycle.js';
import type { Rule, RuleCategory, RuleStatus, RuleStrength } from '../store/types.js';
import { enforceability } from '../engine/rule-detectability.js';
import { redactSecrets } from '../hooks/secret-filter.js';
import { STRENGTH_RANK } from '../renderer/rule-renderer.js';
import { isWayManaged } from './compile.js';
import { conflictingRule } from './conflict.js';
import { isDuplicate } from './similar.js';
import type { CompiledFile, WayItem } from './types.js';

// ── 파일 쓰기 ──

export interface WritePlanEntry {
  path: string; abs: string;
  action: 'create' | 'unchanged' | 'overwrite' | 'blocked-exists' | 'blocked-foreign' | 'blocked-escape';
  /** overwrite 일 때 쓰기 전에 옮겨 둘 백업 경로. */
  backup?: string;
}

/** 존재하는 가장 깊은 상위까지 realpath 로 풀고 나머지를 붙인다. 끊어진 심링크는 던진다. */
function realTarget(p: string): string {
  const abs = path.resolve(p);
  let exists = true;
  try { fs.lstatSync(abs); } catch { exists = false; }
  if (exists) return fs.realpathSync(abs); // 끊어진 심링크면 던진다
  const parent = path.dirname(abs);
  if (parent === abs) return abs;
  return path.join(realTarget(parent), path.basename(abs));
}

/** out 의 실경로 밖으로 나가면 null (상대 경로의 `..`, 심링크 상위 디렉터리, 심링크 파일 모두). */
function inside(outDir: string, rel: string): string | null {
  const abs = path.resolve(outDir, rel);
  const root = path.resolve(outDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    const realRoot = realTarget(root);
    const real = realTarget(abs);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  } catch { return null; }
  return abs;
}

const stamp = () => new Date().toISOString().replace(/\D/g, '').slice(0, 14);

export function planWrite(files: CompiledFile[], outDir: string, force: boolean): WritePlanEntry[] {
  return files.map((f) => {
    const abs = inside(outDir, f.path);
    if (abs === null) return { path: f.path, abs: path.resolve(outDir, f.path), action: 'blocked-escape' as const };
    let existing: string | null = null;
    try { existing = fs.readFileSync(abs, 'utf-8'); } catch { /* 없음 */ }
    let action: WritePlanEntry['action'];
    if (existing === null) action = 'create';
    else if (existing === f.content) action = 'unchanged';
    else if (!isWayManaged(existing)) action = 'blocked-foreign';
    else action = force ? 'overwrite' : 'blocked-exists';
    return { path: f.path, abs, action, ...(action === 'overwrite' ? { backup: `${abs}.forgen-bak-${stamp()}` } : {}) };
  });
}

/** 하나라도 막히면 아무것도 쓰지 않는다. 덮어쓰기 전에는 기존 파일을 백업한다. */
export function writeFiles(files: CompiledFile[], outDir: string, force: boolean): { plan: WritePlanEntry[]; written: number } {
  const plan = planWrite(files, outDir, force);
  if (plan.some((p) => p.action.startsWith('blocked'))) return { plan, written: 0 };
  let written = 0;
  files.forEach((f, i) => {
    if (plan[i].action === 'unchanged') return;
    fs.mkdirSync(path.dirname(plan[i].abs), { recursive: true });
    const backup = plan[i].backup;
    if (backup) fs.copyFileSync(plan[i].abs, backup);
    fs.writeFileSync(plan[i].abs, f.content, 'utf-8');
    written++;
  });
  return { plan, written };
}

// ── json 가져오기 ──

const STRENGTHS = ['soft', 'default', 'strong', 'hard'];
const KINDS = ['rule', 'solution', 'habit'];
const PROV = ['you-said', 'mined', 'imported'];
const STATUSES = ['active', 'suppressed', 'removed'];
const TOP_KEYS = new Set(['schema', 'generator', 'generated_at', 'project', 'items', 'stats', 'render']);
const ITEM_KEYS = new Set(['id', 'kind', 'statement', 'applies_when', 'why', 'projects', 'strength', 'provenance', 'enforceable', 'status', 'category', 'render_key', 'source', 'updated_at', 'conflicts_with']);
const PROV_KEYS = new Set(['kind', 'quote', 'date', 'from']);

export function parseWayJson(text: string): { ok: true; items: WayItem[] } | { ok: false; errors: string[] } {
  let data: unknown;
  try { data = JSON.parse(text); } catch (e) { return { ok: false, errors: [`JSON 파싱 실패: ${(e as Error).message}`] }; }
  const errors: string[] = [];
  const d = data as { schema?: unknown; items?: unknown };
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, errors: ['최상위가 객체가 아니다'] };
  if (d.schema !== 'forgen-way/1') errors.push(`schema 는 "forgen-way/1" 이어야 한다 (받은 값: ${JSON.stringify(d.schema)})`);
  for (const k of Object.keys(d)) if (!TOP_KEYS.has(k)) errors.push(`알 수 없는 최상위 필드: ${k}`);
  if (!Array.isArray(d.items)) return { ok: false, errors: [...errors, 'items 배열이 없다'] };
  const items: WayItem[] = [];
  const seenIds = new Set<string>();
  d.items.forEach((raw, n) => {
    const it = raw as Partial<WayItem> & { provenance?: { kind?: string; from?: string } };
    const where = `items[${n}]${typeof it?.id === 'string' ? ` (${it.id})` : ''}`;
    const bad = (m: string) => errors.push(`${where}: ${m}`);
    if (!it || typeof it !== 'object' || Array.isArray(it)) return bad('객체가 아니다');
    for (const k of Object.keys(it)) if (!ITEM_KEYS.has(k)) bad(`알 수 없는 필드: ${k}`);
    if (typeof it.id !== 'string' || !it.id) bad('id 가 없다');
    else if (seenIds.has(it.id)) bad('같은 파일에 id 가 중복된다');
    else seenIds.add(it.id);
    if (!KINDS.includes(it.kind as string)) bad(`kind 는 ${KINDS.join('|')}`);
    if (typeof it.statement !== 'string' || !it.statement.trim()) bad('statement 가 비어 있다');
    if (typeof it.applies_when !== 'string') bad('applies_when 은 문자열');
    if (!Array.isArray(it.projects) || it.projects.some((p) => typeof p !== 'string')) bad('projects 는 문자열 배열');
    if (!STRENGTHS.includes(it.strength as string)) bad(`strength 는 ${STRENGTHS.join('|')}`);
    if (!it.provenance || typeof it.provenance !== 'object' || !PROV.includes(it.provenance.kind as string)) bad(`provenance.kind 는 ${PROV.join('|')}`);
    else {
      for (const k of Object.keys(it.provenance)) if (!PROV_KEYS.has(k)) bad(`알 수 없는 provenance 필드: ${k}`);
      if (it.provenance.kind === 'imported' && typeof it.provenance.from !== 'string') bad('imported 는 from 이 필요하다');
    }
    if (typeof it.enforceable !== 'boolean') bad('enforceable 은 불리언');
    if (it.status !== undefined && !STATUSES.includes(it.status)) bad(`status 는 ${STATUSES.join('|')}`);
    if (!errors.some((e) => e.startsWith(where))) items.push({ ...(it as WayItem), why: (it as WayItem).why ?? '' });
  });
  return errors.length ? { ok: false, errors } : { ok: true, items };
}

export interface ImportChange { id: string; field: 'statement' | 'projects' | 'strength' | 'status' | 'new'; from?: string; to: string }
export interface ImportPlan { changes: ImportChange[]; ignored: Array<{ id: string; reason: string }>; errors: string[]; warnings: string[]; newRules: WayItem[] }
export interface ImportOptions { allowEnforcedEdit?: boolean }

const CATS: RuleCategory[] = ['quality', 'autonomy', 'communication', 'workflow', 'safety'];

export function planImport(items: WayItem[], existing: Rule[], opts: ImportOptions = {}): ImportPlan {
  const byId = new Map(existing.map((r) => [r.rule_id, r]));
  const plan: ImportPlan = { changes: [], ignored: [], errors: [], warnings: [], newRules: [] };
  // 중복 비교는 활성·억제·제거 룰 모두와 한다 (제거한 룰이 다시 들어오지 않게).
  const policies = existing.map((r) => r.policy);
  const guard = (id: string, msg: string) => {
    if (opts.allowEnforcedEdit) plan.warnings.push(`${id.slice(0, 8)}: ${msg} (--allow-enforced-edit 로 허용됨)`);
    else plan.errors.push(`${id.slice(0, 8)}: ${msg}. 의도한 변경이면 --allow-enforced-edit`);
  };
  for (const it of items) {
    if (it.kind !== 'rule') { plan.ignored.push({ id: it.id, reason: `${it.kind} 항목은 가져오기 대상이 아니다 (룰만 반영)` }); continue; }
    const r = byId.get(it.id);
    if (!r) {
      if (it.provenance.kind !== 'imported') { plan.errors.push(`${it.id}: 저장소에 없는 룰이다. 새 룰은 provenance.kind "imported" 로만 추가할 수 있다`); continue; }
      if (it.strength === 'hard') { plan.errors.push(`${it.id}: 새 룰에 hard 를 줄 수 없다 (hard 는 forgen 에서 직접 지정)`); continue; }
      if (it.status && it.status !== 'active') { plan.errors.push(`${it.id}: 새 룰은 active 로만 추가한다 (받은 status: ${it.status})`); continue; }
      if (redactSecrets(it.statement).hits.length) { plan.errors.push(`${it.id}: 비밀로 보이는 문자열이 있어 가져오지 않는다`); continue; }
      const dup = isDuplicate(it.statement, policies);
      if (dup) { plan.ignored.push({ id: it.id, reason: `기존·같은 파일 룰과 중복: "${dup.slice(0, 40)}"` }); continue; }
      const conf = conflictingRule(it.statement, existing);
      if (conf) { plan.ignored.push({ id: it.id, reason: `활성 룰 ${conf.rule_id.slice(0, 8)} 과 상반: "${conf.policy.slice(0, 40)}"` }); continue; }
      policies.push(it.statement);
      plan.newRules.push(it);
      plan.changes.push({ id: it.id, field: 'new', to: it.statement });
      continue;
    }
    if (it.statement.trim() !== r.policy.trim()) {
      plan.changes.push({ id: it.id, field: 'statement', from: r.policy, to: it.statement.trim() });
      if (enforceability(r) === 'detectable' || r.strength === 'hard') guard(it.id, `강제되는 룰의 문장을 바꾼다 (탐지기와 문장이 어긋날 수 있다)`);
    }
    const pr = (r.projects ?? []).join(',');
    const pi = it.projects.map((p) => p.toLowerCase()).join(',');
    if (pr !== pi) plan.changes.push({ id: it.id, field: 'projects', from: pr || '(전역)', to: pi || '(전역)' });
    if (it.strength !== r.strength) {
      plan.changes.push({ id: it.id, field: 'strength', from: r.strength, to: it.strength });
      if (it.strength === 'hard') plan.errors.push(`${it.id.slice(0, 8)}: hard 를 새로 줄 수 없다 (${r.strength} → hard)`);
      else if (STRENGTH_RANK[it.strength] > STRENGTH_RANK[r.strength]) guard(it.id, `강도를 낮춘다 (${r.strength} → ${it.strength})`);
    }
    if (it.status && it.status !== r.status) plan.changes.push({ id: it.id, field: 'status', from: r.status, to: it.status });
  }
  return plan;
}

export function applyImport(items: WayItem[], plan: ImportPlan, now: string = new Date().toISOString()): { applied: number; created: string[] } {
  let applied = 0;
  const created: string[] = [];
  const touched = new Set(plan.changes.filter((c) => c.field !== 'new').map((c) => c.id));
  for (const id of touched) {
    const it = items.find((x) => x.id === id);
    const rule = loadRule(id);
    if (!it || !rule) continue;
    let next: Rule = { ...rule, policy: it.statement.trim(), strength: it.strength as RuleStrength };
    const projects = it.projects.map((p) => p.toLowerCase()).filter(Boolean);
    if (projects.length) next.projects = projects; else delete next.projects;
    if (it.status && it.status !== rule.status) next = withStatusChange(next, it.status as RuleStatus, `way import: ${it.status} (json 편집)`, 'way-import', now);
    saveRule(next);
    applied++;
  }
  for (const it of plan.newRules) {
    const from = it.provenance.kind === 'imported' ? it.provenance.from : 'way-import';
    const cat = (CATS as string[]).includes(it.category ?? '') ? (it.category as RuleCategory) : 'workflow';
    const rule = createRule({
      category: cat, scope: 'me', trigger: it.applies_when || it.statement.slice(0, 40), policy: it.statement.trim(),
      strength: it.strength as RuleStrength, source: 'imported', render_key: `imported:${cat}.${shortHash(it.statement)}`,
      projects: it.projects.map((p) => p.toLowerCase()).filter(Boolean),
    });
    rule.imported_from = from;
    saveRule(rule);
    created.push(rule.rule_id);
    applied++;
  }
  return { applied, created };
}

const shortHash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 10);

// ── 호스트 메모리 수집 ──

export type ExcludeReason = 'duplicate' | 'conflict' | 'secret' | 'truncated' | 'log' | 'duplicate-in-batch';

export interface MemoryCandidate {
  /** 내용 해시 기반의 안정 id. */
  id: string;
  /** 절대 경로가 아니라 `<프로젝트 슬러그>/<파일명>`. 룰의 imported_from 에도 이것만 남긴다. */
  source: string;
  statement: string;
  applies_when: string;
  why: string;
  /** 추정한 프로젝트 키. null = 전역. 틀리면 사용자가 고친다. */
  project: string | null;
  projectGuess: string;
  /** 기본 제외된 사유. 있으면 가져오지 않는다. */
  excluded?: { reason: ExcludeReason; detail: string };
}

/** 인코딩된 프로젝트 디렉터리 이름(`-home-me-work-repo`)을 실제 경로로 복원한다. 복원 못 하면 null. */
export function decodeProjectDir(name: string): string | null {
  const parts = name.replace(/^-/, '').split('-');
  let cur: string = path.sep;
  let i = 0;
  while (i < parts.length) {
    let found = false;
    for (let j = parts.length; j > i; j--) {
      const seg = parts.slice(i, j).join('-');
      const cand = path.join(cur, seg);
      if (fs.existsSync(cand)) { cur = cand; i = j; found = true; break; }
    }
    if (!found) return null;
  }
  return cur;
}

function isHomeDir(abs: string): boolean {
  let home = os.homedir();
  try { home = fs.realpathSync(home); } catch { /* 그대로 */ }
  // 메모리가 만들어진 기계의 홈일 수 있으므로(복사본 포함) /home/<user> 형태도 홈으로 본다.
  return path.resolve(abs) === path.resolve(home) || ['/home', '/Users'].includes(path.dirname(abs));
}

interface ProjectGuess { key: string | null; note: string; slug: string; home: boolean }

function guessProject(dirName: string): ProjectGuess {
  const abs = decodeProjectDir(dirName);
  const raw = dirName.replace(/^-+/, '');
  if (!abs) return { key: null, note: '경로 복원 실패 → 전역(확인 필요)', slug: raw, home: false };
  if (isHomeDir(abs)) return { key: null, note: '홈에 저장된 메모리 → 전역(확인 필요)', slug: 'home', home: true };
  const key = projectKeyFor(abs) ?? path.basename(abs).toLowerCase();
  return { key, note: `프로젝트 폴더 ${key}`, slug: key, home: false };
}

function section(body: string, label: string): string {
  const m = new RegExp(`\\*\\*${label}:?\\*\\*:?\\s*([\\s\\S]*?)(?=\\n\\s*\\*\\*[A-Za-z ]+:?\\*\\*|$)`, 'i').exec(body);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

/** 사건 기록(커밋 해시, 푸시·머지 완료 보고, 날짜로 시작하는 경과)은 작업 방식이 아니다. */
const LOG_LIKE = /(?:커밋|commit)\s*[0-9a-f]{7,40}|[0-9a-f]{7}[·,]\s*[0-9a-f]{7}|(?:푸시|머지|배포|완료)(?:됨|했다|했음)\b|^\d{4}-\d{2}-\d{2}\s+(?:세션|커밋|완료)|\bPR\s*#\d+/i;

export function parseMemoryFile(raw: string, source: string, g: ProjectGuess, repoNames: string[] = []): MemoryCandidate | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const fm = m[1];
  const body = m[2].trim();
  let desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
  desc = desc.replace(/^\d{4}-\d{2}-\d{2}\s*/, '').replace(/^오너\s*[—-]\s*/, '');
  desc = desc.replace(/\\"/g, '"');
  const statement = desc || body.split('\n').find((l) => l.trim())?.trim() || '';
  if (statement.length < 8) return null;
  let project = g.key;
  let note = g.note;
  if (g.home) {
    // 홈에 저장된 메모리: 본문에 프로젝트 저장소 이름이 나올 때만 후보를 제안한다.
    const text = `${statement} ${body}`.toLowerCase();
    const hits = [...new Set(repoNames.filter((n) => n.length >= 4 && text.includes(n)))];
    if (hits.length === 1) { project = hits[0]; note = `본문에 저장소 이름 "${hits[0]}" → 후보(확인 필요)`; }
    else if (hits.length > 1) note = `본문에 저장소 이름 여러 개(${hits.join(', ')}) → 전역(확인 필요)`;
  }
  const c: MemoryCandidate = {
    id: `mem-${shortHash(source + raw)}`, source, statement,
    applies_when: section(body, 'How to apply').slice(0, 200),
    why: section(body, 'Why'),
    project, projectGuess: note,
  };
  if (/…|\.\.\.\s*$/.test(statement)) c.excluded = { reason: 'truncated', detail: '문장이 잘려 있다' };
  else if (LOG_LIKE.test(statement)) c.excluded = { reason: 'log', detail: '사건 기록처럼 보인다' };
  else if (redactSecrets(`${statement}\n${c.applies_when}\n${c.why}`).hits.length) c.excluded = { reason: 'secret', detail: '비밀로 보이는 문자열' };
  return c;
}

export function readMemoryCandidates(dir: string | undefined, rules: Rule[]): { candidates: MemoryCandidate[]; scanned: string[] } {
  const root = dir ? path.resolve(dir) : path.join(CLAUDE_DIR, 'projects');
  const targets: Array<{ dir: string; project: string }> = [];
  const add = (d: string, project: string) => { if (fs.existsSync(d)) targets.push({ dir: d, project }); };
  let subs: string[] = [];
  try { subs = fs.readdirSync(root); } catch { /* 없음 */ }
  for (const s of subs) add(path.join(root, s, 'memory'), s);
  if (!targets.length) { add(path.join(root, 'memory'), path.basename(path.dirname(root))); add(root, path.basename(root)); }
  // 홈 메모리의 프로젝트 후보로 쓸 저장소 이름: 다른 프로젝트 메모리 폴더가 가리키는 저장소 + 룰에 이미 쓰인 프로젝트 키
  const repoNames = new Set<string>(rules.flatMap((r) => r.projects ?? []));
  for (const t of targets) { const g = guessProject(t.project); if (g.key) repoNames.add(g.key); }

  const candidates: MemoryCandidate[] = [];
  const scanned: string[] = [];
  const seen = rules.map((r) => ({ text: r.policy, label: `${r.status} 룰` }));
  const batch: string[] = [];
  for (const t of targets) {
    let files: string[] = [];
    try { files = fs.readdirSync(t.dir).filter((f) => /^feedback_.*\.md$/.test(f)).sort(); } catch { continue; }
    const g = guessProject(t.project);
    for (const f of files) {
      const full = path.join(t.dir, f);
      scanned.push(`${g.slug}/${f}`);
      const c = parseMemoryFile(fs.readFileSync(full, 'utf-8'), `${g.slug}/${f}`, g, [...repoNames]);
      if (!c) continue;
      if (!c.excluded) {
        const dup = seen.find((o) => isDuplicate(c.statement, [o.text], 0.5));
        if (dup) c.excluded = { reason: 'duplicate', detail: `${dup.label}: "${dup.text.slice(0, 40)}"` };
        else if (isDuplicate(c.statement, batch, 0.5)) c.excluded = { reason: 'duplicate-in-batch', detail: '같은 수집 안의 다른 메모리와 중복' };
        else {
          const conf = conflictingRule(c.statement, rules);
          if (conf) c.excluded = { reason: 'conflict', detail: `활성 룰 ${conf.rule_id.slice(0, 8)} 과 상반: "${conf.policy.slice(0, 40)}"` };
        }
      }
      if (!c.excluded) batch.push(c.statement);
      candidates.push(c);
    }
  }
  return { candidates, scanned };
}

export function candidateToItem(c: MemoryCandidate, projectOverride?: string | null): WayItem {
  const project = projectOverride === undefined ? c.project : projectOverride;
  return {
    id: c.id, kind: 'rule', statement: c.statement, applies_when: c.applies_when, why: c.why,
    projects: project ? [project] : [], strength: 'default', provenance: { kind: 'imported', from: c.source }, enforceable: false, status: 'active', category: 'workflow',
  };
}
