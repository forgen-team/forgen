/**
 * 감사 판정기(src/audit/judge.ts)용 `claude` 실행 파일 대역 — tests/helpers/fake-claude.ts 와 같은 방식으로 PATH 맨 앞에 둔다.
 * 판정기·캐시·재생 코드는 전부 실물이고, 이 대역은 모델 응답만 결정적으로 흉내 낸다.
 *   교정 판정: USER 줄에 [[C:tqNN]] 이 있으면 교정(요지에 tqNN), [[T]] 가 더 있으면 이 작업 전용. 그 밖은 교정 아님.
 *   쌍 판정: A·B 가 같은 tqNN 을 가지면 같음. A 에 ASYM 이 있으면 무조건 같음, B 에 ASYM 이 있으면 무조건 다름(순서 바꾸면 갈림).
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
  const isPair = input.includes('같은 행동 지시');
  const out = [];
  for (const b of blocks) {
    if (isPair) {
      const a = (/^A: (.*)$/m.exec(b.body) || [])[1] || '';
      const bb = (/^B: (.*)$/m.exec(b.body) || [])[1] || '';
      const ta = (a.match(/tq\\d\\d/) || [])[0];
      const tb = (bb.match(/tq\\d\\d/) || [])[0];
      let same = !!ta && ta === tb;
      if (a.includes('ASYM')) same = true;
      if (bb.includes('ASYM')) same = false;
      out.push(JSON.stringify({ id: b.id, same }));
    } else {
      const u = (/^USER: (.*)$/m.exec(b.body) || [])[1] || '';
      const m = /\\[\\[C:(tq\\d\\d)\\]\\]/.exec(u);
      out.push(JSON.stringify({ id: b.id, correction: !!m, gist: m ? '고칠 것 ' + m[1] + (u.includes('ASYM') ? ' ASYM' : '') + ' 방향 지시' : '', task_specific: u.includes('[[T]]') }));
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
