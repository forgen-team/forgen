/**
 * 감사 판정기(src/audit/judge.ts)용 `claude` 실행 파일 대역 — tests/helpers/fake-claude.ts 와 같은 방식으로 PATH 맨 앞에 둔다.
 * 판정기·캐시·재생 코드는 전부 실물이고, 이 대역은 모델 응답만 결정적으로 흉내 낸다.
 *   교정 판정: USER 줄에 [[C:tqNN]] 이 있으면 교정(요지에 tqNN), [[T]] 가 더 있으면 이 작업 전용. 그 밖은 교정 아님.
 *   쌍 판정(비대칭 1회): 교정·기억이 같은 tqNN 을 가지면 yes, 어느 쪽이든 UNK 가 있으면 unknown, 그 밖은 no.
 *   FAKE_STATE/calls.log 에 호출마다 "correction <항목 수>" / "pair <항목 수>" 한 줄. FAKE_DOWN=1 이면 로그인 오류로 실패.
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
  const out = [];
  for (const b of blocks) {
    if (isPair) {
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
  if (S) fs.appendFileSync(S + '/calls.log', (isPair ? 'pair ' : 'correction ') + blocks.length + ' ' + model + '\\n');
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
