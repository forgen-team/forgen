/**
 * 기억의 "그때 모습" (docs/plans/2026-11-25-v1.0-plan.md §2.2) — 비교 단위와 그 기억이 언제부터 있었는지.
 *
 *   forgen 룰          created_at (보관·삭제된 룰은 updated_at 까지 있었던 것으로)
 *   자동 메모 주제 파일 대화 기록 안 그 파일에 대한 첫 Write/Edit 시각
 *   MEMORY.md 색인 줄   그 줄 문장이 처음 들어간 Write/Edit 시각
 *   CLAUDE.md·.claude/rules·AGENTS.md 줄   git blame 의 줄별 작성 시각(커밋 안 된 줄·git 밖 파일은 수정 시각 — 늦게 잡혀 보수적)
 *   지운 기억(§4.3)    <FORGEN_HOME>/audit/deleted.jsonl — 처방(forgen fix, src/audit/fix.ts)이 남기는 지움 표시 + 지문(fp)
 * 시점을 모르는 기억(since = null)은 "적혀 있던 것"으로 세지 않는다. 읽기만 한다(git 은 blame 만 부름).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FORGEN_HOME, ME_RULES, ME_RULES_ARCHIVE } from '../core/paths.js';
import type { Rule } from '../store/types.js';
import { markdownUnits, normalizeSentence } from './checks.js';
import { bigrams } from './lexical.js';
import { frontmatterField, gitRootOf, splitFrontmatter, type AuditEnv, type Layer, type MemoryDir, type SourceReader } from './sources.js';
import type { MemoryWrite } from './transcripts.js';

export type MemoryKind = 'forgen-rule' | 'memory-topic' | 'memory-index' | 'host-md' | 'deleted';
export type SinceVia = 'created_at' | 'transcript-write' | 'git-blame' | 'mtime' | 'mark' | null;

export interface MemoryItem {
  key: string;
  kind: MemoryKind;
  /** 호스트 파일이면 그 층 */
  layer?: Layer;
  text: string;
  grams: Set<string>;
  since: string | null;
  sinceVia: SinceVia;
  /** 이 시각 뒤로는 없었음(보관·삭제된 룰, 지움 표시) */
  until?: string;
  path?: string;
  line?: number;
  ruleId?: string;
  /** 메모 항목의 메모 폴더 */
  memoryDir?: string;
  /**
   * 그때 모습(비평 반영): 지금 내용과 다른 시점의 내용을 복원하는 재료. 없으면 since 이후로는 지금 내용과 같다고 본다.
   *   메모 주제 파일 — 대화 기록의 Write/Edit 이력(raw: 지금 파일 전문)
   *   forgen 룰 — forgen fix 백업의 처방 전 policy(그 처방 시각 앞에는 그 문장)
   */
  history?: { raw?: string; writes?: MemoryWrite[]; policies?: Array<{ at: string; before: string }> };
}

/** 주제 파일 항목의 비교 문장(설명 + 본문 앞부분). */
const topicText = (raw: string) => `${frontmatterField(raw, 'description') ?? ''} / ${splitFrontmatter(raw).body.trim()}`.slice(0, ITEM_TEXT_MAX);

const replaceOnce = (s: string, a: string, b: string, all = false): string | null => {
  if (!a || !s.includes(a)) return null;
  return all ? s.split(a).join(b) : s.replace(a, () => b);
};

/** 메모 파일의 ts 직전 전문을 대화 기록 쓰기 이력으로 복원한다. 복원 못 하면 null(시점 모름). */
/** 알려진 쓰기 이력을 앞으로 끝까지 풀어 본 전문(Write 가 하나도 없으면 null). */
function forwardAll(writes: MemoryWrite[], until?: string): string | null {
  let s: string | null = null;
  for (const w of writes) {
    if (until && w.at >= until) break;
    if (w.full !== undefined) { s = w.full; continue; }
    if (s === null) continue;
    if (!w.edits) return null;
    for (const e of w.edits) { s = s === null ? null : replaceOnce(s, e.old, e.new, e.all); }
    if (s === null) return null;
  }
  return s;
}

/** 두 전문에 다 있는 줄만(앞 전문의 순서) — 기록 밖에서 바뀐 파일의 보수적인 그때 모습. */
function commonLines(a: string, b: string): string {
  const keep = new Set(b.split('\n').map((l) => l.trim()).filter(Boolean));
  return a.split('\n').filter((l) => !l.trim() || keep.has(l.trim())).join('\n');
}

export function reconstructAt(current: string, writes: MemoryWrite[], ts: string): string | null {
  const ws = [...writes].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  // 대화 기록 밖에서 바뀐 흔적(알려진 이력을 끝까지 풀어도 지금 전문과 다름 — 그 기록이 지워졌거나 손으로 고침): 언제 바뀌었는지 모르므로
  // 그때 모습 = (ts 앞 알려진 전문) ∩ (지금 전문) 의 줄만. 교정 뒤에 덧붙인 줄은 앞 전문에 없어서 빠진다.
  const end = forwardAll(ws);
  if (end !== null && end !== current) {
    const atTs = forwardAll(ws, ts);
    return atTs === null ? null : commonLines(atTs, current);
  }
  const after = ws.filter((w) => w.at >= ts);
  if (!after.length) return current;
  const before = ws.filter((w) => w.at < ts);
  // 1) 앞으로: ts 앞 마지막 Write 전문에 그 뒤 ts 앞 Edit 들을 차례로
  const lastWrite = [...before].reverse().findIndex((w) => w.full !== undefined);
  if (lastWrite >= 0) {
    const i = before.length - 1 - lastWrite;
    let s: string | null = before[i].full as string;
    for (const w of before.slice(i + 1)) {
      if (w.full !== undefined) { s = w.full; continue; }
      for (const e of w.edits ?? []) { s = s === null ? null : replaceOnce(s, e.old, e.new, e.all); }
      if (!w.edits) s = null;
      if (s === null) break;
    }
    if (s !== null) return s;
  }
  // 2) 뒤로: 지금 전문에서 ts 뒤 Edit 들을 거꾸로 되돌린다(ts 뒤에 통째 Write 가 있으면 되돌릴 수 없음)
  let s: string | null = current;
  for (const w of [...after].reverse()) {
    if (w.full !== undefined || !w.edits) return null;
    for (const e of [...w.edits].reverse()) { s = s === null ? null : replaceOnce(s, e.new, e.old, e.all); }
    if (s === null) return null;
  }
  return s;
}

/**
 * 그 시점(ts)의 기억 항목: 시점 모습을 복원할 수 있으면 그 문장으로, 그 시점에 있었는지 모르거나 복원 못 하면 null(세지 않음 — 보수적).
 * 메모 파일은 대화 기록 쓰기 이력, forgen 룰은 forgen fix 백업의 처방 전 문장. CLAUDE.md 류는 git blame 줄 시각이 이미 그 줄의 시점이다.
 */
export function itemAt(m: MemoryItem, ts: string): MemoryItem | null {
  if (!m.since || m.since >= ts || (m.until && m.until <= ts)) return null;
  const h = m.history;
  if (!h) return m;
  if (h.writes && h.raw !== undefined) {
    const raw = reconstructAt(h.raw, h.writes, ts);
    if (raw === null) return null;
    if (raw === h.raw) return m;
    const text = topicText(raw);
    return { ...m, text, grams: bigrams(text) };
  }
  if (h.policies?.length) {
    const next = [...h.policies].sort((a, b) => (a.at < b.at ? -1 : 1)).find((p) => p.at >= ts);
    if (!next) return m;
    const text = next.before.slice(0, ITEM_TEXT_MAX);
    return { ...m, text, grams: bigrams(text) };
  }
  return m;
}

/** forgen fix 백업에서 룰마다 처방 전 policy 와 그 시각(policy 가 바뀐 처방만). */
export function rulePolicyHistory(): Map<string, Array<{ at: string; before: string }>> {
  const out = new Map<string, Array<{ at: string; before: string }>>();
  const base = path.join(FORGEN_HOME, 'backups');
  let roots: string[] = [];
  try { roots = fs.readdirSync(base).filter((n) => n.startsWith('fix-')); } catch { return out; }
  for (const r of roots) {
    let ids: string[] = [];
    try { ids = fs.readdirSync(path.join(base, r)); } catch { continue; }
    for (const id of ids) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(base, r, id, 'backup.json'), 'utf-8')) as { at: string; entries: Array<{ path: string; slot: string; existed: boolean }> };
        for (const e of rec.entries) {
          if (!e.existed || !/[\\/]me[\\/]rules[\\/][^\\/]+\.json$/.test(e.path)) continue;
          const before = JSON.parse(fs.readFileSync(path.join(base, r, id, 'before', e.slot), 'utf-8')) as Rule;
          let after: Rule | null = null;
          try { after = JSON.parse(fs.readFileSync(path.join(base, r, id, 'after', e.slot), 'utf-8')) as Rule; } catch { /* 없음 */ }
          if (!before?.rule_id || (after && after.policy === before.policy)) continue;
          out.set(before.rule_id, [...(out.get(before.rule_id) ?? []), { at: rec.at, before: before.policy }]);
        }
      } catch { /* 깨진 백업 */ }
    }
  }
  return out;
}

const ITEM_TEXT_MAX = 500;
const iso = (ms: number) => new Date(ms).toISOString();

function readRuleDir(dir: string): Rule[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
  const out: Rule[] = [];
  for (const n of names) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf-8')) as Rule;
      if (r && typeof r.rule_id === 'string' && typeof r.policy === 'string') out.push(r);
    } catch { /* 깨진 룰은 C1 감사가 따로 보고 */ }
  }
  return out;
}

/** forgen 룰(활성 폴더 + 보관소). 세션 임시 룰·후보는 빼고, 보관·삭제·억제된 룰은 updated_at 까지 있던 것으로 본다. */
export function forgenRuleItems(): { items: MemoryItem[]; rules: Map<string, Rule> } {
  const rules = new Map<string, Rule>();
  for (const r of [...readRuleDir(ME_RULES), ...readRuleDir(ME_RULES_ARCHIVE)]) if (!rules.has(r.rule_id)) rules.set(r.rule_id, r);
  const items: MemoryItem[] = [];
  const policies = rulePolicyHistory();
  for (const r of [...rules.values()].sort((a, b) => (a.rule_id < b.rule_id ? -1 : 1))) {
    if (r.scope === 'session' || r.status === 'candidate') continue;
    const text = r.policy.slice(0, ITEM_TEXT_MAX);
    const gone = r.status !== 'active';
    items.push({
      key: `rule:${r.rule_id}`, kind: 'forgen-rule', text, grams: bigrams(text), ruleId: r.rule_id, path: path.join(ME_RULES, `${r.rule_id}.json`),
      since: r.created_at || null, sinceVia: r.created_at ? 'created_at' : null, ...(gone && r.updated_at ? { until: r.updated_at } : {}),
      ...(policies.get(r.rule_id)?.length ? { history: { policies: policies.get(r.rule_id) } } : {}),
    });
  }
  return { items, rules };
}

/** projects 기준 상대 경로(<폴더>/memory/<파일>) — 대화 기록 경로와 --claude-dir 복사본 경로를 맞춘다. */
export function memoryRel(claudeDir: string, abs: string): string {
  return path.relative(path.join(claudeDir, 'projects'), abs).split(path.sep).join('/');
}

/** 자동 메모: 주제 파일 하나 = 한 항목(설명 + 본문 앞부분), MEMORY.md 색인 줄 하나 = 한 항목. */
export function memoryItems(claudeDir: string, dirs: MemoryDir[], writes: MemoryWrite[]): MemoryItem[] {
  const firstWrite = new Map<string, string>();
  const byRel = new Map<string, MemoryWrite[]>();
  for (const w of writes) {
    if (!firstWrite.has(w.rel)) firstWrite.set(w.rel, w.at);
    const l = byRel.get(w.rel) ?? [];
    l.push(w);
    byRel.set(w.rel, l);
  }
  const out: MemoryItem[] = [];
  for (const m of [...dirs].sort((a, b) => (a.dir < b.dir ? -1 : 1))) {
    for (const t of m.topics) {
      if (t.error) continue;
      const rel = memoryRel(claudeDir, t.path);
      const text = topicText(t.text);
      const since = firstWrite.get(rel) ?? null;
      const ws = byRel.get(rel) ?? [];
      out.push({ key: `topic:${rel}`, kind: 'memory-topic', text, grams: bigrams(text), path: t.path, memoryDir: m.dir, since, sinceVia: since ? 'transcript-write' : null, ...(ws.length ? { history: { raw: t.text, writes: ws } } : {}) });
    }
    if (!m.index || m.index.error) continue;
    const rel = memoryRel(claudeDir, m.index.path);
    const ws = byRel.get(rel) ?? [];
    for (const u of markdownUnits(m.index, 'memory-index')) {
      if (u.norm.length < 8) continue;
      const needle = normalizeSentence(u.text);
      const w = ws.find((x) => normalizeSentence(x.content).includes(needle) || x.content.includes(u.text));
      out.push({
        key: `index:${rel}:${u.line}`, kind: 'memory-index', text: u.text.slice(0, ITEM_TEXT_MAX), grams: bigrams(u.text), path: m.index.path, line: u.line, memoryDir: m.dir,
        since: w?.at ?? null, sinceVia: w ? 'transcript-write' : null,
      });
    }
  }
  return out;
}

/** git blame 줄별 작성 시각(초). 커밋 안 된 줄은 0. 저장소 밖이거나 실패하면 null. */
export function blameTimes(file: string, home: string): number[] | null {
  const root = gitRootOf(path.dirname(file), home);
  if (!root) return null;
  let out = '';
  try {
    out = execFileSync('git', ['-C', path.dirname(file), 'blame', '--line-porcelain', '--', path.basename(file)], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000, maxBuffer: 64 * 1024 * 1024 });
  } catch { return null; }
  const times: number[] = [];
  let cur = 0;
  let uncommitted = false;
  for (const l of out.split('\n')) {
    if (/^[0-9a-f]{40} \d+ \d+/.test(l)) { uncommitted = l.startsWith('0000000000000000000000000000000000000000'); continue; }
    if (l.startsWith('author-time ')) cur = Number(l.slice(12));
    else if (l.startsWith('\t')) times.push(uncommitted ? 0 : cur);
  }
  return times;
}

/** CLAUDE.md 층·.claude/rules·AGENTS.md 의 지시 줄. */
export function hostFileItems(reader: SourceReader, env: AuditEnv, files: Array<{ path: string; layer: Layer }>): MemoryItem[] {
  const out: MemoryItem[] = [];
  const seen = new Set<string>();
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    const sf = reader.read(f.path);
    if (!sf || sf.error) continue;
    let mtime: number | null = null;
    try { mtime = fs.statSync(sf.path).mtimeMs; } catch { /* 없음 */ }
    const blame = blameTimes(sf.path, env.home);
    for (const u of markdownUnits(sf, f.layer)) {
      if (u.norm.length < 8) continue;
      const bt = blame?.[u.line - 1];
      const since = bt ? iso(bt * 1000) : mtime !== null ? iso(mtime) : null;
      out.push({
        key: `md:${sf.path}:${u.line}`, kind: 'host-md', layer: f.layer, text: u.text.slice(0, ITEM_TEXT_MAX), grams: bigrams(u.text), path: sf.path, line: u.line,
        since, sinceVia: bt ? 'git-blame' : since ? 'mtime' : null,
      });
    }
  }
  return out;
}

/** §4.3 지움 표시: {at, text, kind?, path?, line?, ruleId?, since?, fp, fix} 한 줄씩. 처방(forgen fix)이 남기고, 되돌리면 그 줄을 거둔다. */
export function deletedItems(file = path.join(FORGEN_HOME, 'audit', 'deleted.jsonl')): MemoryItem[] {
  let text = '';
  try { text = fs.readFileSync(file, 'utf-8'); } catch { return []; }
  const out: MemoryItem[] = [];
  text.split('\n').forEach((line, i) => {
    if (!line) return;
    try {
      const d = JSON.parse(line) as { at?: string; text?: string; path?: string; line?: number; ruleId?: string; since?: string };
      if (!d.at || !d.text) return;
      const t = d.text.slice(0, ITEM_TEXT_MAX);
      out.push({ key: `deleted:${i}`, kind: 'deleted', text: t, grams: bigrams(t), since: d.since ?? null, sinceVia: d.since ? 'mark' : null, until: d.at, ...(d.path ? { path: d.path } : {}), ...(d.line ? { line: d.line } : {}), ...(d.ruleId ? { ruleId: d.ruleId } : {}) });
    } catch { /* 깨진 줄 */ }
  });
  return out;
}
