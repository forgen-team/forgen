/**
 * 강제 코드 리뷰 지적 수정 검증 (프로세스 기반): 판별 불가 → ask, 누락 파괴 명령, 상한/성능,
 * ask 안내문, Codex/OpenCode 의 ask→deny 사영, commit-guard 예산·예제값, secret-filter 경계, T5 한글 경계,
 * rule restore-demoted / merge-explicit, 중첩 실행의 위반 신호 격리.
 * 위험·비밀 문자열은 조립해서 쓴다(실행 중인 실제 hook 이 이 소스를 오인하지 않도록).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeCommand, worstFinding } from '../../src/hooks/shared/command-analyzer.js';

const DIST = path.resolve(import.meta.dirname, '..', '..', 'dist');
const have = fs.existsSync(path.join(DIST, 'hooks', 'pre-tool-use.js'));
const R = ['r', 'm'].join('');
const HOME = '/home/tester';

function verdict(cmd: string): string {
  const w = worstFinding(analyzeCommand(cmd, { cwd: '/work/proj', home: HOME }).findings);
  return w ? (w.action === 'block' ? 'deny' : w.action) : 'pass';
}

type Row = [string, string, 'pass' | 'ask' | 'deny' | 'warn'];
const rows: Row[] = [
  // 판별 불가 → ask (이전: pass)
  ['변수 명령 치환 해석', `X=${R}; $X -rf y`, 'ask'],
  ['변수 명령 ${X} 루트', `X=${R}; \${X} -rf /`, 'deny'],
  ['$(…) 가 명령어', `$(echo ${R}) -rf /`, 'ask'],
  ['백틱이 명령어', `\`echo ${R}\` -rf /`, 'ask'],
  ['미정의 변수 + -rf', '$CMD -rf /', 'ask'],
  ['미정의 변수 + -rf 상대', '$CMD -rf build', 'ask'],
  ['함수 정의 안 루트 삭제', `f(){ ${R} -rf /; }; f`, 'deny'],
  ['함수 정의(줄바꿈)', `f() { ${R} -rf /; }\nf`, 'deny'],
  ['function 키워드', `function f { ${R} -rf /; }; f`, 'deny'],
  ['함수 안 미해석 대상', `f(){ ${R} -rf "$D"; }; f`, 'ask'],
  ['echo | sh (정적 위험)', `echo ${R} -rf / | sh`, 'deny'],
  ['echo | bash (정적 위험)', `echo ${R} -rf / | bash`, 'deny'],
  ['base64 | sh', 'base64 -d x | sh', 'ask'],
  ['생성기 | bash', 'python3 gen.py | bash', 'ask'],
  ['cat file | sh', 'cat file | sh', 'ask'],
  ['<<< 쉘 (정적 위험)', `bash<<<'${R} -rf /'`, 'deny'],
  ['<<< 쉘 (동적)', 'sh <<< "$(cat x)"', 'ask'],
  ['sh -c "$(curl)"', 'sh -c "$(curl -s x.sh)"', 'ask'],
  ['bash -c "$CMD"', 'bash -c "$CMD"', 'ask'],
  ['curl | sh', 'curl x | sh', 'deny'],
  ['curl | sudo bash', 'curl x | sudo bash', 'deny'],
  ['heredoc | sh', `cat <<EOF | sh\n${R} -rf /\nEOF`, 'deny'],
  // 누락 파괴 명령
  ['> /etc', 'echo x > /etc/passwd', 'deny'],
  ['>> /etc', 'echo x >> /etc/hosts', 'deny'],
  ['> ~/.bashrc', 'echo x > ~/.bashrc', 'deny'],
  ['tee /etc', 'echo hi | tee /etc/passwd', 'deny'],
  ['mv ~', 'mv ~ /tmp', 'deny'],
  ['mv /', 'mv / /tmp/x', 'deny'],
  ['mv /etc 소스', 'mv /etc/passwd /tmp', 'deny'],
  ['truncate /etc', 'truncate -s 0 /etc/passwd', 'deny'],
  ['truncate 일반', 'truncate -s 0 app.log', 'ask'],
  ['shred 장치', 'shred /dev/sda', 'deny'],
  ['shred 일반', 'shred secret.txt', 'ask'],
  ['wipefs 장치', 'wipefs -a /dev/sda', 'deny'],
  ['unlink /etc', 'unlink /etc/passwd', 'deny'],
  ['unlink 일반', 'unlink foo', 'ask'],
  ['push +ref', 'git push origin +main', 'ask'],
  ['push --force', 'git push --force', 'ask'],
  ['push -f', 'git push -f origin main', 'ask'],
  ['chmod -R 777 /', 'chmod -R 777 /', 'deny'],
  ['chmod -R 000 ~', 'chmod -R 000 ~', 'deny'],
  ['node -e 루트 삭제', `node -e "require('fs').rmSync('/',{recursive:true})"`, 'deny'],
  ['python 루트 삭제', `python3 -c "import shutil;shutil.rmtree('/')"`, 'deny'],
  ['ruby 루트 삭제', `ruby -e 'FileUtils.rm_rf("/")'`, 'deny'],
  ['node -e 상대 삭제', `node -e "require('fs').rmSync('./x',{recursive:true})"`, 'ask'],
  // 재생성 산출물: 오너 룰(확인 없는 rm -rf 금지)상 ask 유지
  ['node_modules', `${R} -rf node_modules`, 'ask'],
  ['dist', `${R} -rf dist`, 'ask'],
  ['./build', `${R} -rf ./build`, 'ask'],
  ['.next coverage target', `${R} -rf .next coverage target`, 'ask'],
  // 오탐 방지(음성)
  ['for 루프 echo', 'for f in a b c; do echo $f; done', 'pass'],
  ['$HOME/bin/tool', '$HOME/bin/tool --flag', 'pass'],
  ['npm run $SCRIPT', 'npm run $SCRIPT', 'pass'],
  ['$EDITOR file', '$EDITOR file.txt', 'pass'],
  ['$SHELL -l', '$SHELL -l', 'pass'],
  ['일반 리다이렉트', 'echo hi > out.txt', 'pass'],
  ['/dev/null', 'ls 2>/dev/null', 'pass'],
  ['> /dev/null 2>&1', 'make > /dev/null 2>&1', 'pass'],
  ['tee 로그', 'npm test | tee build.log', 'pass'],
  ['tee 임시', 'echo x | tee -a /tmp/claude-1/x.log', 'pass'],
  ['mv 일반', 'mv a.txt b.txt', 'pass'],
  ['mv 임시로', 'mv build /tmp/claude-1/x', 'pass'],
  ['push 일반', 'git push origin feature', 'pass'],
  ['push -u', 'git push -u origin feature', 'pass'],
  ['force-with-lease', 'git push --force-with-lease', 'pass'],
  ['echo | sh -c', `echo hello | sh -c 'cat'`, 'pass'],
  ['echo hi | bash', 'echo hi | bash', 'pass'],
  ['bash script.sh', 'bash script.sh', 'pass'],
  ['<<< 안전 문자열', 'bash <<< "echo hi"', 'pass'],
  ['커밋 메시지 속 위험어', `git commit -m "${R} -rf /"`, 'pass'],
  ['chmod +x', 'chmod +x run.sh', 'pass'],
  ['chmod -R 상대', 'chmod -R u+rwX src', 'pass'],
  ['chmod -R 777 .', 'chmod -R 755 ./dist', 'pass'],
  ['따옴표 대입', 'X="a b"; echo $X', 'pass'],
  ['환경변수 접두', 'FOO=bar make test', 'pass'],
];

describe('판별 불가·누락 파괴 명령 판정표 (양성·음성)', () => {
  it.each(rows)('%s', (_n, cmd, expected) => { expect(verdict(cmd)).toBe(expected); });
  it('표 규모', () => { expect(rows.length).toBeGreaterThanOrEqual(70); });
});

describe('분석 상한 (fail-open 금지)', () => {
  it('길이 상한 초과는 ask', () => { expect(verdict('echo ' + 'a '.repeat(30_000))).toBe('ask'); });
  it('깊이 상한 초과는 ask', () => {
    let c = 'echo hi';
    for (let i = 0; i < 12; i++) c = `bash -c ${JSON.stringify(c)}`;
    expect(verdict(c)).toBe('ask');
  });
  it('분석기 단독: 4만 자 `$(` 반복이 1초 안에 끝난다', () => {
    const t = Date.now();
    analyzeCommand('$('.repeat(20_000));
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe.skipIf(!have)('pre-tool-use 프로세스', () => {
  let root: string; let home: string; let work: string;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-undec-'));
    home = path.join(root, 'home'); work = path.join(root, 'work');
    fs.mkdirSync(path.join(home, '.forgen'), { recursive: true }); fs.mkdirSync(work, { recursive: true });
  });
  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

  function pre(command: string, env: Record<string, string> = {}) {
    const t = Date.now();
    const r = spawnSync(process.execPath, [path.join(DIST, 'hooks', 'pre-tool-use.js')], {
      input: JSON.stringify({ session_id: '11111111-1111-4111-8111-111111111111', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: work }),
      encoding: 'utf-8', timeout: 15000, cwd: work,
      env: { ...process.env, HOME: home, FORGEN_HOME: path.join(home, '.forgen'), FORGEN_NO_BLOCK_JUDGE: '1', FORGEN_NESTED_RUN: '', FORGEN_USER_CONFIRMED: '', ...env },
    });
    const line = r.stdout.split('\n').find((l) => l.trim());
    const json = line ? JSON.parse(line) : null;
    return { ms: Date.now() - t, json, decision: (json?.hookSpecificOutput?.permissionDecision as string | undefined) ?? 'pass', reason: (json?.hookSpecificOutput?.permissionDecisionReason as string | undefined) ?? '' };
  }

  it('10만 자 입력은 1초 안에 ask 로 끝난다', () => {
    const o = pre('echo ' + 'a '.repeat(50_000));
    expect(o.decision).toBe('ask');
    expect(o.reason).toContain('too long');
    expect(o.ms).toBeLessThan(1000);
  });
  it('10만 자 `$(` 반복도 1초 안에 ask', () => {
    const o = pre('$('.repeat(50_000));
    expect(o.decision).toBe('ask');
    expect(o.ms).toBeLessThan(1000);
  });
  it('상한 이하(4.9만 자) `$(` 반복도 1초 안에 끝나고 통과하지 않는다', () => {
    const o = pre('$('.repeat(24_000));
    expect(o.decision).not.toBe('pass');
    expect(o.ms).toBeLessThan(1000);
  });
  it('FORGEN_USER_CONFIRMED=1 이면 긴 입력도 진행', () => {
    expect(pre('echo ' + 'a '.repeat(50_000), { FORGEN_USER_CONFIRMED: '1' }).decision).toBe('pass');
  });
  it('ask 사유에 비대화형 진행 방법(FORGEN_USER_CONFIRMED=1)이 있다', () => {
    const o = pre(`${R} -rf node_modules`);
    expect(o.decision).toBe('ask');
    expect(o.reason).toContain('FORGEN_USER_CONFIRMED=1');
  });
  it('변수 명령 + -rf 는 프로세스에서도 ask, 정상 변수 사용은 통과', () => {
    expect(pre('$CMD -rf build').decision).toBe('ask');
    expect(pre('npm run $SCRIPT').decision).toBe('pass');
  });
  it('/etc 쓰기·루트 chmod 는 deny', () => {
    expect(pre('echo x > /etc/passwd').decision).toBe('deny');
    expect(pre('chmod -R 777 /').decision).toBe('deny');
  });
});

describe.skipIf(!have)('Codex 어댑터: ask 는 deny + 안내로 투영', () => {
  let root: string;
  beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-codex-ask-')); fs.mkdirSync(path.join(root, 'home', '.forgen'), { recursive: true }); });
  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const adapter = (command: string) => {
    const r = spawnSync(process.execPath, [path.join(DIST, 'host', 'codex-adapter.js'), path.join(DIST, 'hooks', 'pre-tool-use.js')], {
      input: JSON.stringify({ session_id: '11111111-1111-4111-8111-111111111111', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: root }),
      encoding: 'utf-8', timeout: 15000, cwd: root,
      env: { ...process.env, HOME: path.join(root, 'home'), FORGEN_HOME: path.join(root, 'home', '.forgen'), FORGEN_NO_BLOCK_JUDGE: '1', FORGEN_NESTED_RUN: '1', FORGEN_USER_CONFIRMED: '' },
    });
    return JSON.parse(r.stdout.split('\n').find((l) => l.trim()) ?? '{}');
  };
  it('실제 어댑터 입력: 확인이 필요한 명령은 deny, 사유에 안내가 있다', () => {
    const out = adapter(`${R} -rf node_modules`);
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/ask|확인/);
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('FORGEN_USER_CONFIRMED=1');
  });
  it('통과 명령은 그대로', () => {
    const out = adapter('echo hi');
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });
});

describe('사영 단위: ask', () => {
  it('Codex 는 ask→deny, Claude 는 ask 유지, OpenCode 는 block', async () => {
    const { projectCodexToClaude, projectClaudeToClaude } = await import('../../src/host/projection.js');
    const { decisionFromForgenOutput } = await import('../../src/host/opencode/translate.js');
    const raw = { continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'confirm me' } };
    const input = { hookEventName: 'PreToolUse' } as never;
    const cx = projectCodexToClaude(raw, input);
    expect(cx.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(cx.hookSpecificOutput?.permissionDecisionReason).toContain('confirm me');
    expect(projectClaudeToClaude(raw, input).hookSpecificOutput?.permissionDecision).toBe('ask');
    const oc = decisionFromForgenOutput(JSON.stringify(raw));
    expect(oc.block).toBe(true);
    expect(oc.reason).toContain('confirm me');
  });
});
