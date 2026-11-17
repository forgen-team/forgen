/**
 * 룰 프로젝트 범위 관리와 팩 가져오기.
 *   forgen rule set-project <id|prefix> <프로젝트키> | --global
 *   forgen rule classify-projects --project <키> --keywords a,b,c [--apply]   기본은 미리보기
 *   forgen rule classify-projects --from-sessions [--apply [id...]]        교정이 나온 세션의 폴더로 범위 제안 (D6-3)
 *   forgen rule import-pack <팩이름> [--project <키>] [--apply]              기본은 미리보기
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import { mutateSolutionFile } from './solution-writer.js';
import * as path from 'node:path';
import { ME_SOLUTIONS, PACKS_DIR } from '../core/paths.js';
import { createRule, findRuleByRenderKey, loadAllRules, loadRule, rulePath, saveRule } from '../store/rule-store.js';
import { loadEvidence } from '../store/evidence-store.js';
import { projectKeyFor } from '../store/rule-scope.js';
import { withFileLockSync } from '../hooks/shared/file-lock.js';
import { createSnapshot } from './rule-recovery-cli.js';
import type { Rule } from '../store/types.js';

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function fail(message: string): never {
  console.error(`✗ [forgen] ${message}`);
  process.exit(1);
}

export function setRuleProject(prefix: string, projects: string[] | null): Rule {
  const matches = loadAllRules().filter((r) => r.rule_id.startsWith(prefix));
  if (matches.length !== 1) throw new Error(matches.length ? `ambiguous prefix "${prefix}"` : `no rule matching "${prefix}"`);
  // hard 룰은 안전장치다. 프로젝트로 좁히면 다른 곳에서 차단이 꺼진다.
  if (projects && matches[0].strength === 'hard') throw new Error(`hard rule ${matches[0].rule_id} must stay global`);
  const next: Rule = { ...matches[0] };
  if (projects) next.projects = projects;
  else delete next.projects;
  saveRule(next);
  return next;
}

export function planProjectClassification(project: string, keywords: string[]): Rule[] {
  const lower = keywords.map((k) => k.toLowerCase());
  return loadAllRules().filter((r) =>
    r.status === 'active' && r.strength !== 'hard' && !r.projects?.length
    && lower.some((k) => r.policy.toLowerCase().includes(k)));
}

export function handleSetProject(args: string[]): void {
  const prefix = args[0];
  const target = args[1];
  if (!prefix || !target) fail('usage: forgen rule set-project <id|prefix> <프로젝트키> | --global');
  try {
    const rule = setRuleProject(prefix, target === '--global' ? null : [target.toLowerCase()]);
    console.log(`✓ [forgen] ${rule.rule_id.slice(0, 8)} → ${rule.projects?.join(',') ?? '전역'}`);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

/** Claude Code 대화 기록에서 세션의 작업 폴더(cwd). 기록을 못 찾으면 null. */
export function sessionCwd(sessionId: string, projectsDir: string = path.join(os.homedir(), '.claude', 'projects')): string | null {
  if (!sessionId || sessionId !== path.basename(sessionId)) return null;
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(projectsDir); } catch { return null; }
  for (const d of dirs) {
    const file = path.join(projectsDir, d, `${sessionId}.jsonl`);
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const m = /"cwd":"((?:[^"\\]|\\.)+)"/.exec(buf.subarray(0, n).toString('utf-8'));
      if (m) return JSON.parse(`"${m[1]}"`) as string;
    } catch { /* 이 폴더엔 없음 */ } finally { if (fd !== null) fs.closeSync(fd); }
  }
  return null;
}

export interface SessionScopeProposal { rule: Rule; projects: string[]; sessions: number }

/**
 * D6-3: 범위 없는 학습 룰(직접 교정·추론)의 근거 세션이 **모두** 프로젝트 안에서 나왔으면 그 프로젝트(들)를 제안한다.
 * 근거 세션 하나라도 프로젝트 밖(홈 등)이거나 기록을 못 찾으면 제안하지 않는다(전역 유지). hard 룰은 대상 아님.
 */
export function planSessionScopes(opts: { cwdOf?: (sid: string) => string | null; keyOf?: (cwd: string) => string | null } = {}): SessionScopeProposal[] {
  const cwdOf = opts.cwdOf ?? ((sid: string) => sessionCwd(sid));
  const keyOf = opts.keyOf ?? projectKeyFor;
  const cache = new Map<string, string | null>();
  const keyForSession = (sid: string): string | null => {
    if (!cache.has(sid)) { const c = cwdOf(sid); cache.set(sid, c ? keyOf(c) : null); }
    return cache.get(sid) ?? null;
  };
  const out: SessionScopeProposal[] = [];
  for (const r of loadAllRules()) {
    if (r.status !== 'active' && r.status !== 'candidate') continue;
    if (r.scope !== 'me' || r.strength === 'hard' || r.projects?.length) continue;
    if (r.source !== 'explicit_correction' && r.source !== 'behavior_inference') continue;
    const sessions = [...new Set((r.evidence_refs ?? []).map((id) => loadEvidence(id)?.session_id).filter((s): s is string => !!s))];
    if (sessions.length === 0) continue;
    const keys = sessions.map(keyForSession);
    if (keys.some((k) => k === null)) continue;
    out.push({ rule: r, projects: [...new Set(keys as string[])].sort(), sessions: sessions.length });
  }
  return out;
}

function handleClassifyFromSessions(args: string[]): void {
  const plan = planSessionScopes();
  const applyIdx = args.indexOf('--apply');
  if (applyIdx === -1) {
    console.log(`근거 세션이 모두 프로젝트 안에서 나온 전역 룰: ${plan.length}개`);
    for (const p of plan.slice(0, 40)) console.log(`  ${p.rule.rule_id.slice(0, 8)} → ${p.projects.join(',')}  (세션 ${p.sessions})  ${p.rule.policy.replace(/\s+/g, ' ').slice(0, 60)}`);
    if (plan.length) console.log('적용: forgen rule classify-projects --from-sessions --apply [id...]  (id 를 주면 그 룰만, 적용 전 스냅샷)');
    return;
  }
  const only = args.slice(applyIdx + 1).filter((a) => !a.startsWith('--'));
  const chosen = only.length ? plan.filter((p) => only.some((id) => p.rule.rule_id.startsWith(id))) : plan;
  if (chosen.length === 0) { console.log('바꿀 룰이 없습니다.'); return; }
  const snapshot = createSnapshot('pre-classify-sessions');
  let n = 0;
  for (const p of chosen) {
    try {
      withFileLockSync(rulePath(p.rule.rule_id), () => {
        const fresh = loadRule(p.rule.rule_id);
        if (!fresh || fresh.projects?.length) return;
        saveRule({ ...fresh, projects: p.projects });
        n++;
      });
    } catch { /* 잠금 실패 — 다시 실행 */ }
  }
  console.log(`✓ [forgen] ${n}개 룰에 프로젝트 범위를 넣었습니다. 되돌리기: forgen rule restore ${snapshot} --yes`);
}

export function handleClassifyProjects(args: string[]): void {
  if (args.includes('--from-sessions')) { handleClassifyFromSessions(args); return; }
  const project = option(args, '--project')?.toLowerCase();
  const keywords = option(args, '--keywords')?.split(',').map((k) => k.trim()).filter(Boolean);
  if (!project || !keywords?.length) fail('usage: forgen rule classify-projects --project <키> --keywords a,b [--apply]');
  const plan = planProjectClassification(project, keywords);
  for (const r of plan) console.log(`  ${r.rule_id.slice(0, 8)} [${r.strength}] ${r.policy.slice(0, 70)}`);
  if (!args.includes('--apply')) {
    console.log(`미리보기: ${plan.length}개를 ${project} 전용으로 바꿉니다. --apply 로 적용`);
    return;
  }
  for (const r of plan) saveRule({ ...r, projects: [project] });
  console.log(`✓ [forgen] ${plan.length}개를 ${project} 전용으로 변경`);
}

export interface PackImportPlan {
  rules: Array<{ file: string; policy: string; renderKey: string; exists: boolean }>;
  solutions: Array<{ file: string; exists: boolean; valid: boolean }>;
  notImported: string[];
}

function packRulePolicy(raw: string): string {
  return raw
    .split('\n')
    .filter((l) => !/^#\s/.test(l) && !/^>\s*(Type|Scope|Classification|Created):/.test(l))
    .join('\n')
    .trim();
}

export function planPackImport(pack: string): PackImportPlan {
  const root = path.join(PACKS_DIR, pack);
  if (pack !== path.basename(pack) || !fs.existsSync(root)) throw new Error(`pack not found: ${pack}`);
  const list = (d: string) => {
    const dir = path.join(root, d);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.md')) : [];
  };
  const rules = list('rules').map((file) => {
    const policy = packRulePolicy(fs.readFileSync(path.join(root, 'rules', file), 'utf-8'));
    const renderKey = `pack.${pack}.${file.replace(/\.md$/, '')}`;
    return { file, policy, renderKey, exists: findRuleByRenderKey(renderKey) !== null };
  }).filter((r) => r.policy.length > 0);
  const solutions = list('solutions').map((file) => ({
    file,
    exists: fs.existsSync(path.join(ME_SOLUTIONS, file)),
    valid: fs.readFileSync(path.join(root, 'solutions', file), 'utf-8').trimStart().startsWith('---'),
  }));
  const notImported = ['skills', 'agents', 'workflows', 'manuals', 'atoms']
    .flatMap((d) => list(d).map((f) => `${d}/${f}`));
  return { rules, solutions, notImported };
}

export function applyPackImport(pack: string, project: string): { rules: number; solutions: number } {
  const plan = planPackImport(pack);
  let rules = 0;
  for (const r of plan.rules) {
    if (r.exists) continue;
    saveRule(createRule({
      category: 'workflow', scope: 'me', trigger: r.file.replace(/\.md$/, ''), policy: r.policy,
      strength: 'default', source: 'onboarding', render_key: r.renderKey, projects: [project],
    }));
    rules++;
  }
  let solutions = 0;
  fs.mkdirSync(ME_SOLUTIONS, { recursive: true });
  for (const s of plan.solutions) {
    if (s.exists || !s.valid) continue;
    const dest = path.join(ME_SOLUTIONS, s.file);
    fs.copyFileSync(path.join(PACKS_DIR, pack, 'solutions', s.file), dest);
    // 룰과 같은 프로젝트 키를 솔루션에도 남긴다 — 다른 프로젝트 안에서는 매칭되지 않고, 밖에서는 가중치만 낮다.
    mutateSolutionFile(dest, (sol) => { sol.frontmatter.projects = [project]; return true; });
    solutions++;
  }
  return { rules, solutions };
}

export function handleImportPack(args: string[]): void {
  const pack = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--project');
  if (!pack) fail('usage: forgen rule import-pack <팩이름> [--project <키>] [--apply]');
  const project = (option(args, '--project') ?? pack).toLowerCase();
  try {
    const plan = planPackImport(pack);
    const newRules = plan.rules.filter((r) => !r.exists).length;
    const newSolutions = plan.solutions.filter((s) => !s.exists && s.valid).length;
    const broken = plan.solutions.filter((s) => !s.valid).map((s) => s.file);
    console.log(`룰 ${newRules}개(프로젝트 ${project}), 솔루션 ${newSolutions}개`);
    if (broken.length) console.log(`형식 오류로 건너뜀(맨 앞에 YAML frontmatter 필요): ${broken.join(', ')}`);
    if (plan.notImported.length) console.log(`룰·솔루션이 아니라 가져오지 않음 ${plan.notImported.length}개: ${plan.notImported.slice(0, 8).join(', ')}`);
    if (!args.includes('--apply')) {
      console.log('미리보기입니다. --apply 로 적용');
      return;
    }
    const done = applyPackImport(pack, project);
    console.log(`✓ [forgen] 가져옴: 룰 ${done.rules}개, 솔루션 ${done.solutions}개`);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}
