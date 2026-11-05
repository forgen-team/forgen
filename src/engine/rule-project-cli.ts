/**
 * 룰 프로젝트 범위 관리와 팩 가져오기.
 *   forgen rule set-project <id|prefix> <프로젝트키> | --global
 *   forgen rule classify-projects --project <키> --keywords a,b,c [--apply]   기본은 미리보기
 *   forgen rule import-pack <팩이름> [--project <키>] [--apply]              기본은 미리보기
 */
import * as fs from 'node:fs';
import { mutateSolutionFile } from './solution-writer.js';
import * as path from 'node:path';
import { ME_SOLUTIONS, PACKS_DIR } from '../core/paths.js';
import { createRule, findRuleByRenderKey, loadAllRules, saveRule } from '../store/rule-store.js';
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

export function handleClassifyProjects(args: string[]): void {
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
