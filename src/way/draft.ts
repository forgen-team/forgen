/**
 * Way 초안 — 주제 하나에 대해 룰·솔루션·교정 원문을 모아 SKILL.md 또는 호스트 중립 워크플로우 초안을 쓴다.
 *   forgen way draft skill "<주제>" [--project k] [--out dir]
 *   forgen way draft workflow "<주제>" [--project k] [--out dir]
 *
 * 룰 하나를 옮긴 스킬은 제목과 절차가 같은 문장이라 쓸모가 없다. 여기서는 주제와 관련된 항목을 모아 격리된 Haiku 중첩 호출로
 * 절차·판단 기준·실패 대응을 정리한다. 원문에 없는 절차를 지어내지 않도록 프롬프트가 못 박고, 근거 항목 id 는 초안 옆 파일에 남긴다.
 * Haiku 를 쓸 수 없으면 모은 항목 묶음을 그대로(결정론) 출력하고 사유를 보여 준다.
 *
 * 전송 전: 비밀 마스킹(redactSecrets) + <private> 제거(stripPrivate). 통째로 private 인 항목은 보내지 않는다.
 */
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { callHaiku, probeClaudeAvailability } from '../core/extraction-haiku.js';
import { resolveScope } from '../core/scope-resolver.js';
import { isFullyPrivate, stripPrivate } from '../engine/private-filter.js';
import { relevantRules } from '../engine/rule-relevance.js';
import { parseSolutionV3 } from '../engine/solution-format.js';
import { isHabitLog } from '../engine/solution-habit.js';
import { defaultSolutionDirs } from '../engine/solution-index.js';
import { defaultNormalizer } from '../engine/term-normalizer.js';
import { matchSolutions } from '../engine/solution-matcher.js';
import { redactSecrets } from '../hooks/secret-filter.js';
import { loadAllEvidence } from '../store/evidence-store.js';
import { ruleOrigin } from '../store/rule-origin.js';
import { loadAllRules } from '../store/rule-store.js';
import type { Rule } from '../store/types.js';
import type { CompiledFile } from './types.js';

export type DraftKind = 'skill' | 'workflow';

export interface DraftSource {
  /** `rule:<id>` · `solution:<name>` · `correction:<evidence_id>` */
  id: string;
  kind: 'rule' | 'solution' | 'correction';
  /** 보내도 되는 텍스트 (비밀 마스킹·private 제거 후) */
  text: string;
  /** 룰: 발화 원문 (있을 때) */
  quote?: string;
  score: number;
}

export interface GatherResult { sources: DraftSource[]; excludedPrivate: number }

const MAX_RULES = 8;
const MAX_SOLUTIONS = 6;
const MAX_CORRECTIONS = 6;
const CLIP_SOLUTION = 700;
const CLIP_RULE = 400;
const CLIP_CORRECTION = 300;
/** rule-relevance 점수만으로 채택하려면 이 점수 이상(일반 용어 4개 / 식별자급 2개). 그보다 낮으면 주제어가 본문에 실제로 있어야 한다. */
const RELEVANCE_ALONE = 2.0;
/** 같은 종류에서 최고 점수의 이 비율 미만은 버린다 (관련 없는 항목이 꼬리로 따라붙는 것 방지). */
const RELATIVE_CUT = 0.6;

function relativeCut<T>(entries: Array<[T, number]>): Array<[T, number]> {
  const top = Math.max(0, ...entries.map((e) => e[1]));
  return entries.filter((e) => e[1] >= top * RELATIVE_CUT);
}

function clean(text: string, max: number): string | null {
  if (isFullyPrivate(text)) return null;
  const t = redactSecrets(stripPrivate(text).cleaned).redacted.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function inProject(projects: readonly string[] | undefined, project?: string): boolean {
  if (!project) return true;
  return !projects || projects.length === 0 || projects.includes(project);
}

/**
 * 주제어 기반 보조 매칭. rule-relevance·매처는 긴 프롬프트용이라 "격리 검증" 같은 짧은 주제를 놓친다(한글 어미 `검증하라` 등).
 * 주제의 낱말마다 동의어 계열(term-normalizer)까지 펴서 본문에 있는지 보고, 낱말 대부분(둘이면 둘 다)이 있어야 관련으로 본다.
 */
function topicWords(topic: string): string[] {
  return [...new Set(topic.toLowerCase().split(/[\s,/·]+/).map((w) => w.replace(/[^\p{L}\p{N}-]/gu, '')).filter((w) => w.length >= 2))];
}

function termIn(term: string, lower: string): boolean {
  const t = term.toLowerCase();
  if (/^[a-z0-9._-]+$/.test(t)) return new RegExp(`(^|[^a-z0-9])${t.replace(/[.]/g, '\\.')}`).test(lower);
  return lower.includes(t);
}

export function topicScore(topic: string, text: string): number {
  const words = topicWords(topic);
  if (words.length === 0) return 0;
  const lower = text.toLowerCase();
  let hit = 0;
  for (const w of words) if (defaultNormalizer.normalizeTerms([w]).some((t) => termIn(t, lower))) hit++;
  const need = words.length <= 1 ? 1 : Math.ceil(words.length * 0.6);
  return hit >= need ? Math.round((hit / words.length) * 100) / 100 : 0;
}

/** 주제와 관련된 룰(rule-relevance + 주제어), 솔루션(매처 + 주제어), 교정 원문(같은 기준)을 모은다. */
export function gatherSources(topic: string, opts: { project?: string; cwd?: string } = {}): GatherResult {
  const cwd = opts.cwd ?? process.cwd();
  const project = opts.project?.toLowerCase();
  const sources: DraftSource[] = [];
  const have = new Set<string>();
  let excludedPrivate = 0;
  const add = (s: DraftSource) => { if (!have.has(s.id)) { have.add(s.id); sources.push(s); } };

  // 1) 룰
  const rules = loadAllRules().filter((r) => r.status === 'active' && inProject(r.projects, project));
  const rank = new Map<string, number>();
  const topical = new Map<string, number>();
  for (const r of rules) {
    const sc = topicScore(topic, `${r.trigger ?? ''} ${r.policy}`);
    if (sc > 0) topical.set(r.rule_id, sc);
  }
  for (const hit of relevantRules(topic, rules)) if (topical.has(hit.rule_id) || hit.score >= RELEVANCE_ALONE) rank.set(hit.rule_id, hit.score + (topical.get(hit.rule_id) ?? 0));
  for (const [id, sc] of topical) rank.set(id, Math.max(rank.get(id) ?? 0, sc));
  const byId = new Map(rules.map((r) => [r.rule_id, r]));
  for (const [id, score] of relativeCut([...rank].sort((a, b) => b[1] - a[1]).slice(0, MAX_RULES))) {
    const rule = byId.get(id);
    if (!rule) continue;
    const text = clean(`${rule.trigger ? `[${rule.trigger}] ` : ''}${rule.policy}`, CLIP_RULE);
    if (!text) { excludedPrivate++; continue; }
    const q = ruleOrigin(rule);
    const quote = q?.quoteSource === 'user' ? clean(q.quote, CLIP_CORRECTION) ?? undefined : undefined;
    add({ id: `rule:${rule.rule_id}`, kind: 'rule', text, quote, score });
  }

  // 2) 솔루션: 매처(주입과 같은 경로) + 주제어
  const solCand = new Map<string, { path: string; score: number }>();
  try {
    // 매처 후보는 태그 2개 이상 겹칠 때만 (짧은 주제에서 낱말 하나로 걸린 무관한 솔루션 방지)
    for (const m of matchSolutions(topic, resolveScope(cwd), cwd)) if (m.status !== 'retired' && m.matchedTags.length >= 2) solCand.set(m.name, { path: m.path, score: m.relevance });
  } catch { /* 매처 실패는 주제어 매칭만으로 진행 */ }
  for (const { dir } of defaultSolutionDirs(cwd)) {
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      const fp = path.join(dir, f);
      let raw = '';
      try { raw = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
      const parsed = parseSolutionV3(raw);
      if (!parsed || parsed.frontmatter.status === 'retired' || isHabitLog(parsed.frontmatter.name, raw)) continue;
      const sc = topicScore(topic, `${parsed.frontmatter.name.replace(/-/g, ' ')} ${parsed.frontmatter.tags.join(' ')} ${parsed.context} ${parsed.content}`);
      if (sc > 0) solCand.set(parsed.frontmatter.name, { path: fp, score: Math.max(sc, solCand.get(parsed.frontmatter.name)?.score ?? 0) });
    }
  }
  let taken = 0;
  const solTop = Math.max(0, ...[...solCand.values()].map((c) => c.score));
  for (const [name, c] of [...solCand].sort((a, b) => b[1].score - a[1].score)) {
    if (taken >= MAX_SOLUTIONS) break;
    if (c.score < solTop * RELATIVE_CUT) break;
    let raw = '';
    try { raw = fs.readFileSync(c.path, 'utf-8'); } catch { continue; }
    const parsed = parseSolutionV3(raw);
    if (!parsed || !inProject(parsed.frontmatter.projects, project)) continue;
    const text = clean(`${name.replace(/-/g, ' ')}: ${parsed.content}`, CLIP_SOLUTION);
    if (!text) { excludedPrivate++; continue; }
    add({ id: `solution:${name}`, kind: 'solution', text, score: c.score });
    taken++;
  }

  // 3) 교정 원문: 룰이 되지 않은 것까지 포함해 같은 기준으로 고른다
  try {
    const quotes: Array<{ id: string; q: string; score: number }> = [];
    const pseudo: Rule[] = [];
    for (const e of loadAllEvidence()) {
      if (e.type !== 'explicit_correction') continue;
      const q = typeof e.raw_payload?.user_quote === 'string' ? e.raw_payload.user_quote : '';
      if (!q) continue;
      pseudo.push({ rule_id: e.evidence_id, trigger: '', policy: q } as Rule);
      quotes.push({ id: e.evidence_id, q, score: topicScore(topic, q) });
    }
    for (const hit of relevantRules(topic, pseudo)) { const x = quotes.find((k) => k.id === hit.rule_id); if (x && (x.score > 0 || hit.score >= RELEVANCE_ALONE)) x.score = Math.max(x.score, hit.score); }
    const qTop = Math.max(0, ...quotes.map((k) => k.score));
    for (const k of quotes) if (k.score < qTop * RELATIVE_CUT) k.score = 0;
    const seenQuotes = new Set(sources.map((x) => x.quote).filter(Boolean));
    let n = 0;
    for (const x of quotes.filter((k) => k.score > 0).sort((a, b) => b.score - a.score)) {
      if (n >= MAX_CORRECTIONS) break;
      const text = clean(x.q, CLIP_CORRECTION);
      if (!text) { excludedPrivate++; continue; }
      if (seenQuotes.has(text)) continue;
      add({ id: `correction:${x.id}`, kind: 'correction', text, score: x.score });
      n++;
    }
  } catch { /* 교정 읽기 실패는 무시 */ }

  return { sources, excludedPrivate };
}

const KIND_LABEL: Record<DraftSource['kind'], string> = { rule: '룰', solution: '솔루션', correction: '교정 원문' };

function renderSources(sources: DraftSource[]): string {
  return sources.map((s, i) => `[${i + 1}] (${KIND_LABEL[s.kind]}) ${s.text}${s.quote ? `\n    사용자 발언: "${s.quote}"` : ''}`).join('\n');
}

export function buildDraftPrompt(kind: DraftKind, topic: string, sources: DraftSource[]): string {
  const common = [
    '아래 [근거] 항목만 바탕으로 초안을 쓴다.',
    '- 근거에 없는 절차·명령·파일 경로·도구 이름을 지어내지 않는다. 근거가 얇으면 그만큼만 쓰고 짧게 끝낸다.',
    '- 일회성 내용(특정 날짜, 특정 파일·커밋, 한 번 있었던 사건의 경위)은 뺀다. 다음에도 통하는 판단 기준만 남긴다.',
    '- 주제와 직접 관련 없는 근거(다른 주제의 규칙·솔루션이 섞여 들어올 수 있다)는 무시한다.',
    '- 특정 프로젝트·제품 이름이 붙은 조건은 그 조건이 근거에 명시된 경우에만 "판단 기준"에 조건으로 쓰고, 그렇지 않으면 일반화하지 않는다.',
    '- 비슷한 근거는 하나로 합친다. 근거를 그대로 나열하지 않는다.',
    '- 근거끼리 충돌하면 충돌을 숨기지 말고 "판단 기준"에 어느 쪽을 언제 따르는지 적는다. 정할 수 없으면 그렇게 쓴다.',
    '- 한국어로 쓴다. 파일 내용만 출력한다. 앞뒤 설명이나 코드펜스로 감싸지 않는다.',
  ];
  const format = kind === 'skill'
    ? [
        '출력 형식은 표준 SKILL.md 다.',
        '---',
        'name: <소문자 영문·숫자·하이픈, 3~40자>',
        'description: <언제 쓰는지 트리거 문장. "~할 때 사용" 형태로, 사용자가 실제로 할 법한 요청 표현을 2~3개 넣는다. 스킬 내용 요약이 아니라 호출 조건이다. 한두 문장>',
        '---',
        '# <제목: 주제를 한 줄로>',
        '## 절차 — 번호 목록. 각 단계는 무엇을 하고 어떻게 확인하는지 포함한다.',
        '## 판단 기준 — 언제 이 방식을 쓰고 언제 쓰지 않는지, 갈림길마다 기준.',
        '## 실패했을 때 — 단계가 실패하거나 확인이 안 될 때의 대응.',
      ]
    : [
        '출력 형식은 호스트 중립 워크플로우 단계 체크리스트(Markdown)다. 특정 AI 도구·CLI 의 명령이나 기능 이름을 쓰지 않는다.',
        '# <제목>',
        '한 줄: 언제 이 워크플로우를 돌리는지.',
        '## 단계 — `- [ ]` 체크리스트. 각 단계는 한 문장 행동 + 들여쓴 줄에 "확인:" (무엇을 보면 끝난 것인지).',
        '## 갈림길 — 조건 → 어느 단계로/무엇을 할지.',
        '## 실패 시 — 단계별 막혔을 때의 대응.',
      ];
  return [`주제: ${topic}`, '', ...common, '', ...format, '', '[근거]', renderSources(sources)].join('\n');
}

export interface DraftOutcome {
  mode: 'haiku' | 'deterministic';
  text: string;
  /** 결정론 출력일 때 Haiku 를 쓰지 못한 사유 */
  reason?: string;
  ms?: number;
}

/** 모델이 감싼 코드펜스·앞말을 걷어낸다. */
export function stripWrapper(out: string): string {
  let t = out.trim();
  const fence = t.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (fence) t = fence[1].trim();
  const fm = t.indexOf('\n---\n');
  if (!t.startsWith('---') && fm >= 0 && /^name:/m.test(t.slice(fm))) t = t.slice(fm + 1);
  return t;
}

/** 결정론 출력: 관련 항목 묶음. 초안이 아니라 재료다. */
export function deterministicBundle(kind: DraftKind, topic: string, sources: DraftSource[], reason: string): string {
  const out = [`# ${topic} — 관련 항목 묶음 (${kind === 'skill' ? '스킬' : '워크플로우'} 초안 아님)`, '', `> 초안을 쓰지 못했다: ${reason}`, '> 아래는 주제와 관련된 항목을 그대로 모은 것이다. 직접 정리하거나, Haiku 가 가능할 때 다시 실행한다.', ''];
  for (const k of ['rule', 'correction', 'solution'] as const) {
    const list = sources.filter((s) => s.kind === k);
    if (!list.length) continue;
    out.push(`## ${KIND_LABEL[k]}`, ...list.map((s) => `- ${s.text}${s.quote ? `\n  - 사용자 발언: "${s.quote}"` : ''}`), '');
  }
  return `${out.join('\n')}\n`;
}

export function writeDraft(kind: DraftKind, topic: string, sources: DraftSource[], opts: { cwd?: string; noLlm?: boolean } = {}): DraftOutcome {
  if (sources.length === 0) return { mode: 'deterministic', text: deterministicBundle(kind, topic, sources, '주제와 관련된 룰·솔루션·교정을 찾지 못함'), reason: '관련 항목 없음' };
  if (opts.noLlm) return { mode: 'deterministic', text: deterministicBundle(kind, topic, sources, '--no-llm'), reason: '--no-llm' };
  const probe = probeClaudeAvailability();
  if (!probe.available) return { mode: 'deterministic', text: deterministicBundle(kind, topic, sources, probe.reason ?? 'claude 사용 불가'), reason: probe.reason };
  const r = callHaiku('way-draft', buildDraftPrompt(kind, topic, sources), { cwd: opts.cwd ?? process.cwd() });
  if (!r.ok) return { mode: 'deterministic', text: deterministicBundle(kind, topic, sources, r.reason ?? r.outcome), reason: r.reason ?? r.outcome, ms: r.ms };
  const text = redactSecrets(stripWrapper(r.output)).redacted;
  return { mode: 'haiku', text: `${text.trimEnd()}\n`, ms: r.ms };
}

const MARK = '<!-- forgen-way: draft generated by `forgen way draft`. Edits are overwritten on regenerate. -->';

/** 초안 텍스트에서 SKILL.md 이름을 안전한 ASCII 로 뽑는다 (없거나 이상하면 주제에서 만든다). */
export function skillNameFor(text: string, topic: string): string {
  const m = text.match(/^name:\s*["']?([a-z0-9][a-z0-9-]{1,62})["']?\s*$/m);
  if (m) return m[1].replace(/-+$/g, '');
  const ascii = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return ascii.length >= 3 ? ascii : `way-draft-${crypto.createHash('sha1').update(topic).digest('hex').slice(0, 8)}`;
}

function sourcesFile(topic: string, kind: DraftKind, outcome: DraftOutcome, sources: DraftSource[], excludedPrivate: number): string {
  return [
    MARK, `# 근거 항목 — ${topic}`, '',
    `종류: ${kind}, 방식: ${outcome.mode}${outcome.reason ? ` (${outcome.reason})` : ''}, 항목 ${sources.length}개${excludedPrivate ? `, private 제외 ${excludedPrivate}` : ''}`, '',
    ...sources.map((s) => `- \`${s.id}\` (${KIND_LABEL[s.kind]}, 관련도 ${s.score}) ${s.text.slice(0, 120)}${s.text.length > 120 ? '…' : ''}`), '',
  ].join('\n');
}

/** 초안을 파일 묶음으로 만든다. 스킬은 `.claude/skills/<name>/`, 워크플로우는 `workflows/<slug>.md`. 근거는 옆 파일. */
export function draftFiles(kind: DraftKind, topic: string, outcome: DraftOutcome, sources: DraftSource[], excludedPrivate: number): CompiledFile[] {
  const side = sourcesFile(topic, kind, outcome, sources, excludedPrivate);
  if (kind === 'skill') {
    const name = skillNameFor(outcome.text, topic);
    // 결정론 묶음은 SKILL.md 형식이 아니므로 스킬로 설치되지 않도록 별도 파일 이름을 쓴다.
    if (outcome.mode !== 'haiku') return [{ path: `.claude/skills/${name}/DRAFT-BUNDLE.md`, content: `${MARK}\n${outcome.text}` }, { path: `.claude/skills/${name}/SOURCES.md`, content: side }];
    const body = outcome.text.replace(/^(---\n[\s\S]*?\n---\n)/, `$1${MARK}\n`);
    return [{ path: `.claude/skills/${name}/SKILL.md`, content: body.includes(MARK) ? body : `${MARK}\n${body}` }, { path: `.claude/skills/${name}/SOURCES.md`, content: side }];
  }
  const slug = topic.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || skillNameFor('', topic);
  return [{ path: `workflows/${slug}.md`, content: `${MARK}\n${outcome.text}` }, { path: `workflows/${slug}.sources.md`, content: side }];
}

export function readTopic(args: string[]): string | undefined {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' || args[i] === '--out') { i++; continue; }
    if (args[i].startsWith('--')) continue;
    rest.push(args[i]);
  }
  const t = rest.join(' ').trim();
  return t || undefined;
}
