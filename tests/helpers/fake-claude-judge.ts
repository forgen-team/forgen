/**
 * 감사 판정기(src/audit/judge.ts)용 `claude` 실행 파일 대역 — tests/helpers/fake-claude.ts 와 같은 방식으로 PATH 맨 앞에 둔다.
 * 판정기·캐시·재생 코드는 전부 실물이고, 이 대역은 모델 응답만 결정적으로 흉내 낸다.
 *   교정 판정: USER 줄에 [[C:tqNN]] 이 있으면 교정(요지에 tqNN), [[T]] 가 더 있으면 이 작업 전용. 그 밖은 교정 아님.
 *   쌍 판정(비대칭 1회): 교정·기억이 같은 tqNN 을 가지면 yes, 어느 쪽이든 UNK 가 있으면 unknown, 그 밖은 no.
 *   같은 뜻 중복: A·B 가 같은 dqNN 을 가지면 yes · 부딪힘: 같은 cqNN 이면 yes (둘 다 UNK 가 있으면 unknown, 그 밖은 no).
 *   섞임: 지시에 [[MIX]] 면 project(짐작한 프로젝트), [[UNK]] 면 unknown, 그 밖은 general.
 *   두 층 발동 조건: 규칙에 [[CMD:x]] 면 tools Bash(+없는 도구 하나)·commands [x], [[PATH]] 면 paths docs/plans/**, cw… 낱말을 words 로.
 *   처방 문안: merge = 원문1 + " (합침)", rewrite = 원문1 앞 150자, index = 원문1 의 링크 뒤 "짧게", memo = 원문1 로 name·description·text.
 *   FAKE_STATE/calls.log 에 호출마다 "<종류> <항목 수> <모델>" 한 줄. FAKE_DOWN=1 이면 로그인 오류로 실패.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SCRIPT = `#!/usr/bin/env node
const fs = require('fs');
const S = process.env.FAKE_STATE;
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  if (process.env.FAKE_DOWN === '1') { process.stderr.write('Please run /login\\n'); process.exit(1); }
  const model = process.argv[process.argv.indexOf('--model') + 1];
  const blocks = input.split(/^### /m).slice(1).map((b) => { const nl = b.indexOf('\\n'); return { id: b.slice(0, nl).trim(), body: b.slice(nl + 1) }; });
  const isPair = input.includes('이미 지시하고 있었나');
  const kind = input.includes('언제 쓰는 규칙인가') ? 'condition' : input.includes('기억 파일을 정리하는 편집자') ? 'fix' : input.includes('한 프로젝트에서만 뜻이 있는가') ? 'mix' : input.includes('하나만 남겨도 AI 가 받는') ? 'dup' : input.includes('동시에 지킬 수 없는가') ? 'conflict' : isPair ? 'pair' : 'correction';
  const out = [];
  for (const b of blocks) {
    if (kind === 'dup' || kind === 'conflict') {
      const a = (/^A: (.*)$/m.exec(b.body) || [])[1] || '';
      const bb = (/^B: (.*)$/m.exec(b.body) || [])[1] || '';
      const re = kind === 'dup' ? /dq\\d\\d/ : /cq\\d\\d/;
      const ta = (a.match(re) || [])[0];
      const tb = (bb.match(re) || [])[0];
      const answer = a.includes('UNK') && bb.includes('UNK') ? 'unknown' : ta && ta === tb ? 'yes' : 'no';
      out.push(JSON.stringify({ id: b.id, answer, reason: 'fake ' + kind }));
    } else if (kind === 'mix') {
      const t = (/^지시: (.*)$/m.exec(b.body) || [])[1] || '';
      const g = (/^짐작: (.*)$/m.exec(b.body) || [])[1] || '';
      const answer = t.includes('[[MIX]]') ? 'project' : t.includes('[[UNK]]') ? 'unknown' : 'general';
      out.push(JSON.stringify({ id: b.id, answer, project: answer === 'project' && g !== '(없음)' ? g : null, reason: 'fake mix' }));
    } else if (kind === 'condition') {
      const t = (/^규칙: (.*)$/m.exec(b.body) || [])[1] || '';
      const cmd = (/\\[\\[CMD:([^\\]]+)\\]\\]/.exec(t) || [])[1];
      const words = (t.match(/cw[a-z]{3,}/g) || []).slice(0, 3);
      out.push(JSON.stringify({ id: b.id, folders: [], tools: cmd ? ['Bash', 'NotATool'] : [], commands: cmd ? [cmd] : [], paths: t.includes('[[PATH]]') ? ['docs/plans/**'] : [], words, reason: 'fake cond' }));
    } else if (kind === 'fix') {
      const task = (/^task: (.*)$/m.exec(b.body) || [])[1] || '';
      const t1 = (/^원문1: (.*)$/m.exec(b.body) || [])[1] || '';
      if (task === 'merge') out.push(JSON.stringify({ id: b.id, text: t1 + ' (합침)' }));
      else if (task === 'rewrite') out.push(JSON.stringify({ id: b.id, text: t1.slice(0, 150) }));
      else if (task === 'index') out.push(JSON.stringify({ id: b.id, text: '짧게' }));
      else out.push(JSON.stringify({ id: b.id, text: t1, name: 'memo ' + t1.slice(0, 12), description: t1.slice(0, 60) }));
    } else if (isPair) {
      const a = (/^교정: (.*)$/m.exec(b.body) || [])[1] || '';
      const bb = (/^기억: (.*)$/m.exec(b.body) || [])[1] || '';
      const ta = (a.match(/tq\\d\\d/) || [])[0];
      const tb = (bb.match(/tq\\d\\d/) || [])[0];
      const answer = a.includes('UNK') || bb.includes('UNK') ? 'unknown' : ta && ta === tb ? 'yes' : 'no';
      out.push(JSON.stringify({ id: b.id, answer }));
    } else {
      const u = (/^USER: (.*)$/m.exec(b.body) || [])[1] || '';
      const m = /\\[\\[C:(tq\\d\\d)\\]\\]/.exec(u);
      out.push(JSON.stringify({ id: b.id, correction: !!m, gist: m ? '고칠 것 ' + m[1] + (u.includes('UNK') ? ' UNK' : '') + ' 방향 지시' : '', task_specific: u.includes('[[T]]') }));
    }
  }
  if (S) fs.appendFileSync(S + '/calls.log', kind + ' ' + blocks.length + ' ' + model + '\\n');
  process.stdout.write('\`\`\`\\n' + out.join('\\n') + '\\n\`\`\`\\n');
});
`;

export function installFakeJudge(binDir: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'claude'), SCRIPT, { mode: 0o755 });
}

export function readJudgeCalls(stateDir: string): string[] {
  try { return fs.readFileSync(path.join(stateDir, 'calls.log'), 'utf-8').split('\n').filter(Boolean); } catch { return []; }
}
