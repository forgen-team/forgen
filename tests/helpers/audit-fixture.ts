/**
 * 감사·처방 합성 픽스처 (docs/plans/2026-11-25-v1.0-plan.md §12.1-4 합성 A·B·C) + 모델 판정 검사용으로 심은 문제.
 * 문장은 전부 합성이다(실제 룰 본문·개인 경로 없음). 가짜 판정기(fake-claude-judge.ts)의 표지:
 *   dqNN = 같은 뜻 짝, cqNN = 부딪히는 짝, [[MIX]] = 한 프로젝트 전용, [[GEN]] = 일반 원칙(섞임 아님), rwNN = 긴 룰(짧게 다시 쓰기)
 * 모든 파일은 root 아래(임시 HOME) 에 만든다.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const SHARED = '- Always run the full test suite before reporting a task as finished';

export interface Fixture {
  home: string;
  claude: string;
  forgenHome: string;
  A: string;
  B: string;
  C: string;
  folders: string[];
  /** 심은 문제(재현율 계산용): 키 = 검사 종류, 값 = 표지 */
  planted: { dup: string[]; conflict: string[]; mix: string[]; stale: number; sameSentence: number; truncated: number };
}

export const W = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
export const encodeDir = (abs: string) => abs.replace(/[^A-Za-z0-9]/g, '-');

/** 파일만 만든다. forgen 룰은 addRules 로 따로 넣는다(rule-store 를 import 한 쪽이 FORGEN_HOME 을 정한 뒤). */
export function buildFixture(root: string): Fixture {
  const home = path.join(root, 'home');
  const claude = path.join(home, '.claude');
  const forgenHome = path.join(home, '.forgen');
  const A = path.join(root, 'work', 'proj-a');
  const B = path.join(root, 'work', 'proj-b');
  const C = path.join(root, 'work', 'projc');
  fs.mkdirSync(claude, { recursive: true });

  // 사용자 층(모든 폴더에 실림): 같은 문장 · 섞임 · 부딪힘 · 같은 뜻
  W(path.join(claude, 'CLAUDE.md'), [
    '# Global', SHARED, '- Keep answers short',
    '- [[MIX]] projc release checklist lives in the team wiki under the projc space',
    '- cq01 Write every commit message in English for this team',
    '- dq01 Always confirm the deploy target with the owner before shipping a release',
    '',
  ].join('\n'));
  W(path.join(claude, 'rules', 'global.md'), '- [[MIX]] For projc the nightly import runs from the projc data bucket first\n');

  // 합성 A: 300줄 단일 CLAUDE.md — 같은 문장·낡은 경로·없는 npm 스크립트·부딪힘, 같은 뜻 짝은 룰 파일에
  fs.mkdirSync(path.join(A, '.git'), { recursive: true });
  fs.mkdirSync(path.join(A, 'docs'), { recursive: true });
  W(path.join(A, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
  const filler = Array.from({ length: 293 }, (_, i) => `- Synthetic instruction number ${i} for the fixture`);
  W(path.join(A, 'CLAUDE.md'), [
    '# Project A', SHARED,
    '- Read notes at ~/missing-dir/notes.md before starting',
    '- Design doc: `docs/missing-design.md`',
    '- Run `npm run nonexistent-script` to lint',
    '- cq01 Never write commit messages in English for this team',
    '- dq03 Summaries must list every changed file and the reason for it',
    ...filler, '',
  ].join('\n'));
  W(path.join(A, '.claude', 'rules', 'summary.md'), '- dq03 Every summary should list each changed file and the reason it changed\n');

  // 합성 B: 사용자·프로젝트·로컬 3층 + .claude/rules 20개(paths 있는 10 · 없는 10) + AGENTS.md
  fs.mkdirSync(path.join(B, '.git'), { recursive: true });
  W(path.join(B, 'CLAUDE.md'), '- Project B uses the synthetic widget toolkit\n- dq02 Keep pull request descriptions short and list the verification steps\n');
  W(path.join(B, 'CLAUDE.local.md'), '- Local only override for this machine\n');
  W(path.join(B, 'AGENTS.md'), `${SHARED}\n- dq02 Pull request descriptions stay short and must list the verification steps\n`);
  for (let i = 0; i < 20; i++) {
    const fm = i < 10 ? (i % 3 === 0 ? '---\npaths:\n  - "src/**/*.ts"\n  - lib/**\n---\n' : i % 3 === 1 ? '---\npaths: "src/api/**"\n---\n' : '---\npaths: ["a/**", "b/**"]\n---\n') : '';
    W(path.join(B, '.claude', 'rules', `r${String(i).padStart(2, '0')}.md`), `${fm}- Rule file ${i} says something specific enough\n`);
  }

  // 합성 C: MEMORY.md 230줄·27KB 넘음, 주제 파일 100개(색인 안 된 것 포함)
  fs.mkdirSync(path.join(C, '.git'), { recursive: true });
  const mem = path.join(claude, 'projects', encodeDir(C), 'memory');
  const idx = ['# Memory'];
  for (let i = 0; i < 229; i++) idx.push(`- [Topic ${i}](topic_${i}.md) — ${'synthetic description text '.repeat(4)}${i}`);
  W(path.join(mem, 'MEMORY.md'), `${idx.join('\n')}\n`);
  for (let i = 0; i < 100; i++) W(path.join(mem, `topic_${i}.md`), `---\nname: t${i}\nmetadata:\n  type: ${i % 2 ? 'feedback' : 'project'}\n---\nbody ${i}\n`);
  W(path.join(mem, 'orphan_note.md'), '---\ntype: user\n---\nnot indexed\n');

  // 홈 메모: 다른 프로젝트 이야기 + 없는 주제 파일 링크 + forgen 룰과 겹치는 feedback(겹치는 교정)
  const homeMem = path.join(claude, 'projects', encodeDir(home), 'memory');
  W(path.join(homeMem, 'MEMORY.md'), [
    '- [projc deploy order](missing_topic.md) — restart sequence for the projc servers',
    '- [General habit](general.md) — answers in short paragraphs',
    '- [Korean replies](feedback_korean.md) — dq04 answer the owner in Korean and never in English',
    '',
  ].join('\n'));
  W(path.join(homeMem, 'general.md'), '---\ntype: feedback\n---\nshort answers\n');
  W(path.join(homeMem, 'feedback_korean.md'), '---\nname: korean\ndescription: dq04 answer the owner in Korean and never in English\nmetadata:\n  type: feedback\n---\ndq04 Always answer the owner in Korean, never in English.\n');

  fs.mkdirSync(path.join(forgenHome, 'state'), { recursive: true });
  W(path.join(forgenHome, 'state', 'marker.json'), '{}');
  return {
    home, claude, forgenHome, A, B, C, folders: [A, B, C, home],
    planted: { dup: ['dq01', 'dq02', 'dq03', 'dq04'], conflict: ['cq01', 'cq02'], mix: ['projc release checklist', 'rebuild the synthetic image', 'nightly import runs', 'schema migration check'], stale: 4, sameSentence: 1, truncated: 1 },
  };
}

/** forgen 룰(rule-store 의 createRule·saveRule 을 받는다 — FORGEN_HOME 을 정한 뒤 import 한 것). */
export function addRules(createRule: (o: Record<string, unknown>) => Record<string, unknown>, saveRule: (r: never) => void, broken: string): Record<string, string> {
  const ids: Record<string, string> = {};
  const mk = (key: string, policy: string, extra: Record<string, unknown> = {}) => {
    const r = { ...createRule({ category: 'workflow', scope: 'me', trigger: policy.slice(0, 10), policy, strength: 'default', source: 'explicit_correction', render_key: `w.${key}` }), ...extra };
    saveRule(r as never);
    ids[key] = String(r.rule_id);
  };
  // 채굴 룰(중요 지침 아님) — 범위 옮기기를 묶음으로 적용할 수 있다
  mk('mix', '[[MIX]] For projc always rebuild the synthetic image before testing', { source: 'behavior_inference' });
  // 중요 지침(strong) 섞임 — 범위 옮기기는 하나씩만(묶음 제외), 옮기면 다른 폴더에서 누락으로 센다
  mk('mixImportant', '[[MIX]] For projc never skip the projc schema migration check', { strength: 'strong' });
  // 같은 뜻 forgen 룰 둘: 직접 교정(중요) · 채굴 — 지워지는 쪽은 채굴만
  mk('dq06a', 'dq06 Keep generated fixture files out of the main source folder', { source: 'behavior_inference' });
  mk('dq06b', 'dq06 Generated fixture files must stay out of the main source folder');
  mk('gen', '[[GEN]] Reply in Korean even when the work is about projc');
  mk('shared', SHARED.slice(2));
  mk('scoped', 'Scoped rule only for proj-a work', { projects: ['proj-a'] });
  mk('dq01', 'dq01 Before shipping a release, confirm the deploy target with the owner first');
  mk('cq02a', 'cq02 Run the full lint pass after every change you make');
  mk('cq02b', 'cq02 Do not run the full lint pass after every change you make, only on commit');
  mk('dq04', 'dq04 Always answer the owner in Korean and never in English');
  mk('rw01', `rw01 dq05 When you prepare a release, ${'check the changelog entry, the version field, the migration notes and the rollback plan, then '.repeat(5)}report what you checked`);
  fs.writeFileSync(broken, '{ not json');
  return ids;
}
