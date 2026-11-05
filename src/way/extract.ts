/**
 * Way 추출 — 기존 저장소를 Way 항목으로 읽는다 (새 저장소 없음).
 *  - 룰(~/.forgen/me/rules) : active 만. 출처는 evidence 의 user_quote 로 확인한다.
 *  - 솔루션(~/.forgen/me/solutions) : verified·mature 만 항목. 나머지는 개수만 센다.
 *  - 습관 : behavior md 의 `- [분류] 문장` 줄과 프로필 팩. 모델이 쓴 잡음이 많아 기본 내보내기에서 빠진다.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ME_BEHAVIOR, ME_SOLUTIONS } from '../core/paths.js';
import { ruleEnforced } from '../engine/rule-detectability.js';
import { isHabitLog } from '../engine/solution-habit.js';
import { parseSolutionV3 } from '../engine/solution-format.js';
import { ruleOrigin } from '../store/rule-origin.js';
import { loadProfile } from '../store/profile-store.js';
import { loadAllRules } from '../store/rule-store.js';
import type { Profile, Rule } from '../store/types.js';
import { conflictingRule } from './conflict.js';
import { isDuplicate } from './similar.js';
import type { Provenance, Way, WayItem, WayStats } from './types.js';
import { WAY_SCHEMA } from './types.js';

export function ruleToItem(rule: Rule): WayItem {
  let provenance: Provenance;
  let why = '';
  if (rule.source === 'explicit_correction' || rule.source === 'onboarding') {
    const o = ruleOrigin(rule);
    const quote = o?.quoteSource === 'user' ? o.quote : undefined;
    provenance = { kind: 'you-said', ...(quote ? { quote } : {}), ...(o?.date ? { date: o.date } : { date: rule.created_at.slice(0, 10) }) };
    if (quote) why = `사용자 발언: "${quote}"`;
  } else if (rule.source === 'imported') {
    provenance = { kind: 'imported', from: rule.imported_from ?? 'unknown', date: rule.created_at.slice(0, 10) };
  } else {
    provenance = { kind: 'mined', date: rule.created_at.slice(0, 10) };
  }
  return {
    id: rule.rule_id,
    kind: 'rule',
    statement: rule.policy,
    applies_when: rule.trigger,
    why,
    projects: rule.projects ?? [],
    strength: rule.strength,
    provenance,
    enforceable: ruleEnforced(rule),
    status: rule.status === 'active' || rule.status === 'suppressed' || rule.status === 'removed' ? rule.status : undefined,
    category: rule.category,
    render_key: rule.render_key,
    source: rule.source,
    updated_at: rule.updated_at,
  };
}

export interface SolutionCounts { verified: number; unverified: number; skipped: number }

export function readSolutions(dir: string = ME_SOLUTIONS): { items: WayItem[]; counts: SolutionCounts } {
  const items: WayItem[] = [];
  const counts: SolutionCounts = { verified: 0, unverified: 0, skipped: 0 };
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { return { items, counts }; }
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
    const parsed = parseSolutionV3(raw);
    const name = f.replace(/\.md$/, '');
    if (!parsed || parsed.frontmatter.status === 'retired' || isHabitLog(name, raw)) { counts.skipped++; continue; }
    const fm = parsed.frontmatter;
    if (fm.status !== 'verified' && fm.status !== 'mature') { counts.unverified++; continue; }
    if (!parsed.content.trim()) { counts.skipped++; continue; }
    counts.verified++;
    items.push({
      id: `solution:${name}`,
      kind: 'solution',
      statement: parsed.content.trim(),
      applies_when: parsed.context.trim(),
      why: '',
      projects: fm.projects ?? [],
      strength: fm.status === 'mature' ? 'strong' : 'default',
      provenance: fm.extractedBy === 'manual' ? { kind: 'you-said', date: fm.created } : { kind: 'mined', date: fm.created },
      enforceable: false,
      category: fm.type,
      source: fm.extractedBy === 'manual' ? 'explicit_correction' : 'behavior_inference',
      updated_at: fm.updated,
    });
  }
  return { items, counts };
}

const HABIT_LINE = /^\s*[-*]\s*\[([^\]]{1,20})\]\s+(.{12,300})$/;
/** behavior md 템플릿이 그대로 남은 줄(예: "패턴 설명 (관찰 근거)")이나 꺾쇠 자리표시. */
const TEMPLATE_RESIDUE = /^패턴 설명|\(관찰 근거\)\s*$|^<[^>]{2,40}>$|^(?:설명|예시|내용)\s*(?:\(|:)\s*$/;

export function readHabits(existing: string[], dir: string = ME_BEHAVIOR): WayItem[] {
  const out: WayItem[] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { return out; }
  const seen = [...existing];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f), 'utf-8');
    const created = raw.match(/^created:\s*"?([\d-]+)"?/m)?.[1];
    let n = 0;
    for (const line of raw.split('\n')) {
      const m = HABIT_LINE.exec(line);
      if (!m) continue;
      const text = m[2].replace(/\*\*/g, '').trim();
      if (TEMPLATE_RESIDUE.test(text) || isDuplicate(text, seen)) continue;
      seen.push(text);
      out.push({
        id: `habit:${f.replace(/\.md$/, '')}:${n++}`,
        kind: 'habit', statement: text, applies_when: m[1], why: '', projects: [], strength: 'soft',
        provenance: { kind: 'mined', date: created }, enforceable: false, category: 'habit',
      });
    }
  }
  return out;
}

export function profileHabits(p: Profile | null): WayItem[] {
  if (!p) return [];
  const date = p.metadata?.updated_at?.slice(0, 10);
  const packs: Array<[string, string, string]> = [
    ['quality', '품질·안전', p.base_packs.quality_pack],
    ['autonomy', '자율성', p.base_packs.autonomy_pack],
    ['judgment', '판단 방식', p.base_packs.judgment_pack],
    ['communication', '소통', p.base_packs.communication_pack],
  ];
  return packs.map(([k, label, pack]) => ({
    id: `profile:${k}`, kind: 'habit' as const, statement: `${label} 성향: ${pack}`, applies_when: 'profile',
    why: '', projects: [], strength: 'soft' as const, provenance: { kind: 'mined' as const, date }, enforceable: false, category: 'profile',
  }));
}

export function computeStats(items: WayItem[], sol: SolutionCounts): WayStats {
  const rules = items.filter((i) => i.kind === 'rule' && i.status === 'active');
  return {
    rules_active: rules.length,
    rules_you_said: rules.filter((i) => i.provenance.kind === 'you-said').length,
    rules_mined: rules.filter((i) => i.provenance.kind === 'mined').length,
    rules_imported: rules.filter((i) => i.provenance.kind === 'imported').length,
    rules_enforceable: rules.filter((i) => i.enforceable).length,
    solutions_verified: sol.verified,
    solutions_unverified: sol.unverified,
    habits: items.filter((i) => i.kind === 'habit').length,
  };
}

/** 현재 저장소에서 Way 를 만든다. 룰은 활성만. 습관은 항상 계산하지만 컴파일러가 기본 제외한다. */
export function buildWay(now: Date = new Date()): Way {
  const rules = loadAllRules().filter((r) => r.status === 'active' && r.scope === 'me');
  const ruleItems = rules.map(ruleToItem).sort((a, b) => a.id.localeCompare(b.id));
  const sol = readSolutions();
  const habits = [...readHabits(ruleItems.map((r) => r.statement)), ...profileHabits(loadProfile())].map((h) => {
    if (h.category === 'profile') return h;
    const c = conflictingRule(h.statement, rules);
    return c ? { ...h, conflicts_with: c.rule_id } : h;
  });
  const items = [...ruleItems, ...sol.items, ...habits];
  return { schema: WAY_SCHEMA, generator: 'forgen-way', generated_at: now.toISOString(), items, stats: computeStats(items, sol.counts) };
}
