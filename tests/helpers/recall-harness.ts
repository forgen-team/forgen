/**
 * 회수 골든 세트 하네스: 픽스처 솔루션으로 격리 FORGEN_HOME 을 만들고, 빌드된 solution-injector hook 을
 * 프롬프트마다 프로세스로 실행해 실제로 주입된 솔루션 이름을 모은다. mock 없음.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GoldenSolution {
  name: string; where: 'me' | 'pack'; kind: string; title: string; content: string;
  legacyTags: string[]; habit?: boolean; context?: string; evidence?: { injected: number; reflected: number };
}
export interface GoldenCase { id: number; prompt: string; expect: string[]; note?: string }
export interface Golden { solutions: GoldenSolution[]; cases: GoldenCase[] }

export const DIST = process.env.RECALL_DIST ?? path.resolve(__dirname, '..', '..', 'dist');

export function loadGolden(): Golden {
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', 'recall-golden.json'), 'utf-8'));
}

/** 수정 전 파이프라인이 만든 형태(legacyTags, 습관 로그는 type decision)로 솔루션 파일을 쓴다. */
export function buildHome(root: string, g: Golden): string {
  const home = path.join(root, 'home');
  const fg = path.join(home, '.forgen');
  fs.mkdirSync(path.join(fg, 'me', 'solutions'), { recursive: true });
  fs.mkdirSync(path.join(fg, 'packs', 'starter', 'solutions'), { recursive: true });
  fs.writeFileSync(path.join(fg, 'forge-profile.json'), '{}');
  for (const s of g.solutions) {
    const dir = s.where === 'pack' ? path.join(fg, 'packs', 'starter', 'solutions') : path.join(fg, 'me', 'solutions');
    const ev = s.evidence ?? { injected: 0, reflected: 0 };
    const md = [
      '---', `name: ${s.name}`, 'version: 1', 'status: candidate', 'confidence: 0.5', `type: ${s.kind}`, `scope: ${s.where === 'pack' ? 'team' : 'me'}`,
      'tags:', ...s.legacyTags.map((t) => `  - ${JSON.stringify(t)}`), 'identifiers: []',
      'evidence:', `  injected: ${ev.injected}`, `  reflected: ${ev.reflected}`, '  negative: 0', '  sessions: 0', '  reExtracted: 0',
      'created: 2026-10-17', 'updated: 2026-10-17', 'supersedes: null', `extractedBy: ${s.habit ? 'auto' : 'manual'}`, '---', '',
      '## Context', s.context ?? '', '', '## Content', s.content, '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, `${s.name}.md`), md);
  }
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  return home;
}

export function hookEnv(home: string, cwd: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, FORGEN_HOME: path.join(home, '.forgen'), FORGEN_SYNTHETIC: '1', FORGEN_CWD: cwd, FORGEN_NO_BLOCK_JUDGE: '1' };
}

export function injectedNames(stdout: string): string[] {
  const first = stdout.trim().split('\n')[0] ?? '';
  try {
    const ctx: string = JSON.parse(first)?.hookSpecificOutput?.additionalContext ?? '';
    return [...ctx.matchAll(/^- ([^\s:[\]]+)/gm)].map((m) => m[1]);
  } catch { return []; }
}

export function runCase(home: string, cwd: string, c: GoldenCase, sessionPrefix = 'golden'): string[] {
  const r = spawnSync(process.execPath, [path.join(DIST, 'hooks', 'solution-injector.js')], {
    input: JSON.stringify({ session_id: `${sessionPrefix}-${c.id}`, prompt: c.prompt, cwd, hook_event_name: 'UserPromptSubmit' }),
    encoding: 'utf-8', cwd, env: hookEnv(home, cwd), timeout: 60_000,
  });
  return injectedNames(r.stdout ?? '');
}

export interface Metrics {
  positives: number; recalled: number; recall: number;
  /** 정답 없는(없어야 함) 케이스에서 무언가 주입된 건수 */
  negInjections: number; negCases: number;
  /** 정답 외 솔루션이 주입된 총 건수(정답 케이스 포함) */
  wrongInjections: number;
  perCase: Array<{ id: number; prompt: string; expect: string[]; got: string[] }>;
}

/** sessionPrefix 가 같으면 hook 의 세션 캐시가 이미 주입한 솔루션을 건너뛰므로, 재측정은 다른 접두사를 쓴다. */
export function measure(home: string, cwd: string, g: Golden, sessionPrefix = 'golden'): Metrics {
  const perCase = g.cases.map((c) => ({ id: c.id, prompt: c.prompt, expect: c.expect, got: runCase(home, cwd, c, sessionPrefix) }));
  const pos = perCase.filter((c) => c.expect.length > 0);
  const neg = perCase.filter((c) => c.expect.length === 0);
  const recalled = pos.filter((c) => c.expect.every((e) => c.got.includes(e))).length;
  return {
    positives: pos.length, recalled, recall: pos.length ? recalled / pos.length : 0,
    negCases: neg.length, negInjections: neg.filter((c) => c.got.length > 0).length,
    wrongInjections: perCase.reduce((n, c) => n + c.got.filter((x) => !c.expect.includes(x)).length, 0),
    perCase,
  };
}

/** 제품 경로 그대로 기존 솔루션 태그를 재계산하고 습관 로그를 분리한다 (`forgen compound retag --apply`, `habits --apply`). */
export function applyMigrations(home: string, cwd: string): void {
  for (const sub of ['retag', 'habits']) {
    const r = spawnSync(process.execPath, [path.join(DIST, 'cli.js'), 'compound', sub, '--apply'], { encoding: 'utf-8', cwd, env: hookEnv(home, cwd), timeout: 60_000 });
    if (r.status !== 0) throw new Error(`compound ${sub} --apply 실패: ${r.stderr}`);
  }
}
