/**
 * 강제 코드 리뷰 지적 수정: commit-guard 예산·예제값, secret-filter 경계, T5 한글 경계,
 * rule restore-demoted / merge-explicit, 중첩 실행의 위반 신호 격리. 시크릿·위험 문자열은 조립한다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SECRET_PATTERNS } from '../src/hooks/secret-filter.js';
import { NEGATION_RE } from '../src/engine/lifecycle/trigger-t5-conflict.js';
import { checkGitSecrets, checkGitSecretsBudgeted } from '../src/hooks/shared/commit-guard.js';
import type { Rule } from '../src/store/types.js';

const apiKey = SECRET_PATTERNS.find((p) => p.name === 'API Key')!.pattern;
const AWS_DOC = ['AKIA', 'IOSFODNN7', 'EXAMPLE'].join('');
const AWS_REAL = ['AKIA', 'Z7XQ4MNP2LKJ5HRT'].join('');

describe('secret-filter API Key 단어 경계', () => {
  it.each([
    'risk_assessment_for_production_deployment_v2',
    'task-runner-configuration-manager-v2-final',
    'ls /dev/disk-by-uuid-aaaaaaaaaaaaaaaa',
    'desk_organization_checklist_for_the_office',
  ])('오탐 아님: %s', (t) => { expect(apiKey.test(t)).toBe(false); });
  it.each([
    ['sk', '-', 'proj', '-', 'abcdefghijklmnopqrstuvwxyz0123'].join(''),
    ['pk', '_live_', 'abcdefghijklmnopqrstuvwxyz0123'].join(''),
    `OPENAI_API_KEY=${['sk', '-', 'abcdefghijklmnopqrstuvwxyz0123'].join('')}`,
    ['MY_', 'API_KEY', '_', 'abcdefghijklmnopqrstuvwxyz0123'].join(''),
    ['api', '-key-', 'abcdefghijklmnopqrstuvwxyz0123'].join(''),
  ])('진짜 키는 계속 잡힌다: %s', (t) => { expect(apiKey.test(t)).toBe(true); });
});

describe('T5 한글 부정 경계', () => {
  it.each(['마라톤 대회 참가 일정을 공유한다', '불가피한 경우에만 예외를 둔다', '마라탕 맛집 목록을 정리한다'])('오탐 아님: %s', (t) => { expect(NEGATION_RE.test(t)).toBe(false); });
  it.each(['마이그레이션은 즉시 실행하지 마라', '배포를 실행하지 않는다', '확인 없이 쓰지 않는 것', '직접 수정 금지', '이건 불가능하다', '삭제하면 안 된다'])('부정으로 잡힌다: %s', (t) => { expect(NEGATION_RE.test(t)).toBe(true); });
  it('"실행하라" 는 부정이 아니다', () => { expect(NEGATION_RE.test('마이그레이션은 항상 즉시 실행하라')).toBe(false); });
});

describe('commit-guard 예제값 허용·시간 예산', () => {
  let repo: string;
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-cg-'));
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  });
  afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });
  const stage = (name: string, body: string) => { fs.writeFileSync(path.join(repo, name), body); git('add', '-f', name); };
  const commitOp = [{ sub: 'commit', args: ['-m', 'x'], cwd: '' }];

  it('문서의 예제 값(AKIA…EXAMPLE, example.com, localhost, user:pass@)은 통과', () => {
    stage('README.md', `키 예시 ${AWS_DOC}\nDB: postgres://user:pass@localhost:5432/app\nredis://user:password@example.com:6379\n`);
    expect(checkGitSecrets(commitOp, repo)).toEqual([]);
  });
  it('진짜 키는 계속 잡힌다', () => {
    stage('cfg.ts', `export const k = '${AWS_REAL}';\n`);
    const hits = checkGitSecrets(commitOp, repo);
    expect(hits.map((h) => h.file)).toEqual(['cfg.ts']);
    expect(JSON.stringify(hits)).not.toContain(AWS_REAL);
  });
  it('예제 값 옆에 진짜 키가 있어도 진짜 키는 잡는다', () => {
    stage('mixed.md', `${AWS_DOC}\n그리고 example.com 설명\n${AWS_REAL}\n`);
    expect(checkGitSecrets(commitOp, repo).length).toBe(1);
  });
  it('시간 예산을 넘기면 timedOut 으로 알린다 (조용히 통과 아님)', () => {
    stage('a.txt', 'hello');
    const r = checkGitSecretsBudgeted(commitOp, repo, 0);
    expect(r.timedOut).toBe(true);
  });
  it('hook 프로세스: 예산 초과면 git commit 은 ask + 사유', () => {
    const dist = path.resolve(import.meta.dirname, '..', 'dist', 'hooks', 'pre-tool-use.js');
    if (!fs.existsSync(dist)) return;
    stage('a.txt', 'hello');
    const home = path.join(repo, '..', `home-${path.basename(repo)}`);
    fs.mkdirSync(path.join(home, '.forgen'), { recursive: true });
    const r = spawnSync(process.execPath, [dist], {
      input: JSON.stringify({ session_id: '11111111-1111-4111-8111-111111111111', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: repo }),
      encoding: 'utf-8', timeout: 15000, cwd: repo,
      env: { ...process.env, HOME: home, FORGEN_HOME: path.join(home, '.forgen'), FORGEN_NO_BLOCK_JUDGE: '1', FORGEN_NESTED_RUN: '', FORGEN_USER_CONFIRMED: '', FORGEN_COMMIT_GUARD_BUDGET_MS: '1' },
    });
    fs.rmSync(home, { recursive: true, force: true });
    const o = JSON.parse(r.stdout.split('\n').find((l) => l.trim())!);
    expect(o.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(o.hookSpecificOutput.permissionDecisionReason).toContain('2초');
    expect(o.hookSpecificOutput.permissionDecisionReason).toContain('FORGEN_USER_CONFIRMED=1');
  });
});

function mkRule(id: string, policy: string, over: Partial<Rule> = {}): Rule {
  return {
    rule_id: id, category: 'quality', scope: 'me', trigger: 't', policy, strength: 'default', source: 'explicit_correction',
    status: 'active', evidence_refs: [`ev-${id}`], render_key: `quality.${id}`,
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...over,
  } as Rule;
}

describe('rule restore-demoted / merge-explicit', () => {
  const home = path.join(os.tmpdir(), `forgen-rf-${process.pid}`);
  const fh = path.join(home, '.forgen');
  const rulesDir = path.join(fh, 'me', 'rules');
  const enf = path.join(fh, 'state', 'enforcement');
  let logs: string[]; let origLog: typeof console.log;
  beforeEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.mkdirSync(rulesDir, { recursive: true }); fs.mkdirSync(enf, { recursive: true });
    vi.resetModules();
    vi.stubEnv('HOME', home); vi.stubEnv('FORGEN_HOME', fh); vi.stubEnv('FORGEN_DISABLE_PROJECT_RULES', '1');
    logs = []; origLog = console.log; console.log = (m: unknown) => { logs.push(String(m)); };
  });
  afterEach(() => { console.log = origLog; vi.unstubAllEnvs(); process.exitCode = 0; fs.rmSync(home, { recursive: true, force: true }); });
  const put = (r: Rule) => fs.writeFileSync(path.join(rulesDir, `${r.rule_id}.json`), JSON.stringify(r));
  const read = (id: string) => JSON.parse(fs.readFileSync(path.join(rulesDir, `${id}.json`), 'utf-8')) as Rule;

  it('restore-demoted: 자동 강등(기록 있음)만 이전 모드로 복구, 수동 advise 는 그대로, 전역 epoch 리셋 없음', async () => {
    put(mkRule('auto1', '자동 강등된 룰의 정책 문장', { enforce_mode: 'advise' }));
    put(mkRule('manual1', '사용자가 직접 advise 로 둔 룰 정책', { enforce_mode: 'advise' }));
    fs.writeFileSync(path.join(enf, 'demotions.jsonl'), `${JSON.stringify({ at: '2026-11-01T00:00:00Z', rule_id: 'auto1', precision: 0.2, judged: 6, prev_mode: 'block', reason: 'precision-auto' })}\n`);
    const { handleRestoreDemoted } = await import('../src/engine/rule-toggle-cli.js');
    await handleRestoreDemoted([]); // 미리보기: 변경 없음
    expect(read('auto1').enforce_mode).toBe('advise');
    await handleRestoreDemoted(['--apply']);
    expect(read('auto1').enforce_mode).toBe('block');
    expect(read('manual1').enforce_mode).toBe('advise');
    expect(fs.existsSync(path.join(enf, 'judge-epoch.json'))).toBe(false); // 정밀도 기록 전체 리셋 금지
    const epochs = JSON.parse(fs.readFileSync(path.join(enf, 'rule-epochs.json'), 'utf-8'));
    expect(Object.keys(epochs)).toEqual(['auto1']);
  });

  it('강등 시 이전 모드·사유가 기록된다', async () => {
    const { maybeDemote, lastDemotion } = await import('../src/engine/block-judge.js');
    put(mkRule('d1', '강등 대상 정책 문장 입니다'));
    const rows: string[] = [];
    for (let i = 0; i < 8; i++) {
      rows.push(JSON.stringify({ at: new Date().toISOString(), rule_id: 'd1', kind: 'deny', session_id: `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${i}`, violation_id: `v${i}`, source: 'pre-tool-guard' }));
    }
    fs.writeFileSync(path.join(enf, 'violations.jsonl'), rows.join('\n') + '\n');
    fs.writeFileSync(path.join(enf, 'verdicts.jsonl'), Array.from({ length: 8 }, (_, i) => JSON.stringify({ at: new Date().toISOString(), violation_id: `v${i}`, rule_id: 'd1', verdict: 'false_positive', by: 'auto' })).join('\n') + '\n');
    expect(maybeDemote('d1')).toBe(true);
    const d = lastDemotion('d1');
    expect(d?.prev_mode).toBe('block');
    expect(d?.reason).toBe('precision-auto');

    // 사용자가 rule enforce 로 켠 룰은 같은 정밀도여도 자동으로 내려가지 않는다
    put(mkRule('d2', '사용자가 켠 룰 정책 문장 입니다', { enforce_mode: 'block' }));
    fs.appendFileSync(path.join(enf, 'violations.jsonl'), rows.map((r) => r.replace(/"rule_id":"d1"/, '"rule_id":"d2"').replace(/"violation_id":"v/, '"violation_id":"x')).join('\n') + '\n');
    fs.appendFileSync(path.join(enf, 'verdicts.jsonl'), Array.from({ length: 8 }, (_, i) => JSON.stringify({ at: new Date().toISOString(), violation_id: `x${i}`, rule_id: 'd2', verdict: 'false_positive', by: 'auto' })).join('\n') + '\n');
    expect(maybeDemote('d2')).toBe(false);
    expect(read('d2').enforce_mode).toBe('block');
  });

  const seedCluster = () => {
    for (const [id, p] of [['a', '완료 선언 전에 실제 동작을 검증하라 프로덕션 환경 확인'], ['b', '완료 선언 전 실제 검증 필수 라우트 존재만으로 완성 판단 금지'], ['c', '실제 동작 검증 후에만 완료 선언 프로덕션 확인 필수']]) put(mkRule(id, p));
  };
  it('merge-explicit: ID 없는 --apply 는 거부(아무것도 병합 안 함)', async () => {
    seedCluster();
    const { handleMergeExplicit } = await import('../src/engine/rule-toggle-cli.js');
    await handleMergeExplicit(['--apply']);
    expect(read('a').status).toBe('active');
    expect(logs.join('\n')).toContain('제안ID');
  });
  it('merge-explicit: 미리보기 ID 로만 적용', async () => {
    seedCluster();
    const { handleMergeExplicit } = await import('../src/engine/rule-toggle-cli.js');
    await handleMergeExplicit([]);
    const id = /\[([0-9a-f]{8})\]/.exec(logs.join('\n'))![1];
    await handleMergeExplicit(['--apply', id]);
    expect(read('a').status).toBe('superseded');
  });
  it('merge-explicit: 룰이 바뀌었으면(ID 불일치) 중단', async () => {
    seedCluster();
    const { handleMergeExplicit } = await import('../src/engine/rule-toggle-cli.js');
    await handleMergeExplicit([]);
    const id = /\[([0-9a-f]{8})\]/.exec(logs.join('\n'))![1];
    put(mkRule('a', '완료 선언 전에 실제 동작을 검증하라 프로덕션 환경 확인 그리고 로그도 남긴다'));
    logs.length = 0;
    await handleMergeExplicit(['--apply', id]);
    expect(logs.join('\n')).toContain('중단');
    expect(read('b').status).toBe('active');
  });
});

describe('중첩 실행의 위반 기록은 합성(synthetic)으로 격리', () => {
  const home = path.join(os.tmpdir(), `forgen-nest-${process.pid}`);
  beforeEach(() => { fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(home, { recursive: true }); vi.resetModules(); vi.stubEnv('HOME', home); vi.stubEnv('FORGEN_HOME', path.join(home, '.forgen')); });
  afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); });
  it('FORGEN_NESTED_RUN=1 이면 실세션 id 여도 집계에서 제외된다', async () => {
    const sig = await import('../src/engine/lifecycle/signals.js');
    const real = '11111111-1111-4111-8111-111111111111';
    vi.stubEnv('FORGEN_NESTED_RUN', '1');
    sig.recordViolation({ rule_id: 'r1', session_id: real, source: 'pre-tool-guard', kind: 'deny' });
    vi.stubEnv('FORGEN_NESTED_RUN', '');
    sig.recordViolation({ rule_id: 'r1', session_id: real, source: 'pre-tool-guard', kind: 'deny' });
    const rows = sig.readViolationsWindow();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => sig.isRealBlock(r))).toHaveLength(1);
  });
});
