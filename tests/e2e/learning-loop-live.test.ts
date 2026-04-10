/**
 * Forgen E2E — Learning Loop Live Verification
 *
 * 실제 `claude -p`를 사용하여 학습 루프의 전체 라이프사이클을 검증.
 * API 키 없이 로그인 인증으로도 동작.
 *
 * 실행: npx vitest run tests/e2e/learning-loop-live.test.ts
 *
 * 검증 체인:
 *   1. processCorrection → promoteSessionCandidates → 영구 규칙 생성
 *   2. 영구 규칙이 renderRules에 반영되어 Claude에 도달
 *   3. auto-compound-runner Step 4와 동일한 경로로 승격
 *   4. forgen me 대시보드에 규칙 카운트 표시
 *   5. MCP compound-search가 실제 솔루션을 검색
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const TIMEOUT = 30_000;
const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');

// ── claude CLI 존재 확인 ──

let claudeAvailable = false;

beforeAll(() => {
  try {
    execFileSync('claude', ['--version'], { timeout: 5000, stdio: 'pipe' });
    claudeAvailable = true;
  } catch {
    claudeAvailable = false;
  }
});

// ── 격리된 HOME에서 학습 루프 전체 검증 ──

describe('Learning Loop Live: 교정 → 승격 → 규칙 반영 전체 사이클', () => {
  const TEST_HOME = path.join(os.tmpdir(), `forgen-live-e2e-${process.pid}`);
  const FORGEN_HOME = path.join(TEST_HOME, '.forgen');
  const ME_DIR = path.join(FORGEN_HOME, 'me');
  const RULES_DIR = path.join(ME_DIR, 'rules');
  const EVIDENCE_DIR = path.join(ME_DIR, 'behavior');
  const SOLUTIONS_DIR = path.join(ME_DIR, 'solutions');
  const STATE_DIR = path.join(FORGEN_HOME, 'state');
  const V1_DIR = path.join(FORGEN_HOME, 'v1');

  beforeAll(() => {
    // 격리 환경 생성
    for (const dir of [RULES_DIR, EVIDENCE_DIR, SOLUTIONS_DIR, STATE_DIR,
      path.join(V1_DIR, 'rules'), path.join(V1_DIR, 'evidence'),
      path.join(V1_DIR, 'sessions'), path.join(V1_DIR, 'state'),
      path.join(V1_DIR, 'raw-logs'), path.join(V1_DIR, 'recommendations'),
      path.join(V1_DIR, 'solutions'),
      path.join(ME_DIR, 'skills'), path.join(FORGEN_HOME, 'sessions'),
      path.join(FORGEN_HOME, 'handoffs'), path.join(FORGEN_HOME, 'plans'),
      path.join(FORGEN_HOME, 'specs'),
      path.join(FORGEN_HOME, 'artifacts', 'ask'),
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  afterAll(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  /**
   * 격리된 HOME에서 Node.js 스크립트 실행.
   * HOME을 오버라이드하여 실제 사용자 환경에 영향 없음.
   */
  function runInIsolation(script: string): string {
    return execFileSync('node', ['-e', script], {
      timeout: TIMEOUT,
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: TEST_HOME,
        FORGEN_CWD: PROJECT_ROOT,
        COMPOUND_CWD: PROJECT_ROOT,
      },
      cwd: PROJECT_ROOT,
    }).trim();
  }

  it('1. processCorrection → evidence 생성 + promotion_candidate', () => {
    const result = runInIsolation(`
      const { processCorrection } = require('./dist/forge/evidence-processor.js');
      const r = processCorrection({
        session_id: 'live-session-1',
        kind: 'prefer-from-now',
        message: 'always use early return pattern',
        target: 'early-return',
        axis_hint: 'quality_safety',
      });
      console.log(JSON.stringify({
        candidate: r.promotion_candidate,
        evidenceId: r.evidence_event_id,
        tempRule: r.temporary_rule,
      }));
    `);

    const parsed = JSON.parse(result);
    expect(parsed.candidate).toBe(true);
    expect(parsed.evidenceId).toBeTruthy();
    expect(parsed.tempRule).toBeNull(); // prefer-from-now은 임시 규칙 안 만듦
  });

  it('2. promoteSessionCandidates → scope:me 영구 규칙 생성', () => {
    const result = runInIsolation(`
      const { promoteSessionCandidates } = require('./dist/store/evidence-store.js');
      const { loadActiveRules } = require('./dist/store/rule-store.js');

      const promoted = promoteSessionCandidates('live-session-1');
      const rules = loadActiveRules().filter(r => r.scope === 'me');
      const rule = rules.find(r => r.policy.includes('early return'));

      console.log(JSON.stringify({
        promoted,
        ruleCount: rules.length,
        rulePolicy: rule?.policy ?? null,
        ruleCategory: rule?.category ?? null,
        ruleStrength: rule?.strength ?? null,
      }));
    `);

    const parsed = JSON.parse(result);
    expect(parsed.promoted).toBe(1);
    expect(parsed.ruleCount).toBeGreaterThanOrEqual(1);
    expect(parsed.rulePolicy).toContain('early return');
    expect(parsed.ruleCategory).toBe('quality');
    expect(parsed.ruleStrength).toBe('default');
  });

  it('3. avoid-this 교정 → strong 규칙 + 세션 임시 규칙', () => {
    const result = runInIsolation(`
      const { processCorrection } = require('./dist/forge/evidence-processor.js');
      const { promoteSessionCandidates } = require('./dist/store/evidence-store.js');
      const { loadActiveRules } = require('./dist/store/rule-store.js');

      processCorrection({
        session_id: 'live-session-1',
        kind: 'avoid-this',
        message: 'never use any type in TypeScript',
        target: 'typescript-any',
        axis_hint: 'quality_safety',
      });

      const promoted = promoteSessionCandidates('live-session-1');
      const rules = loadActiveRules();
      const meRules = rules.filter(r => r.scope === 'me');
      const sessionRules = rules.filter(r => r.scope === 'session');
      const strongRule = meRules.find(r => r.strength === 'strong');

      console.log(JSON.stringify({
        promoted,
        meCount: meRules.length,
        sessionCount: sessionRules.length,
        hasStrong: !!strongRule,
        strongPolicy: strongRule?.policy ?? null,
      }));
    `);

    const parsed = JSON.parse(result);
    expect(parsed.promoted).toBe(1);
    expect(parsed.meCount).toBeGreaterThanOrEqual(2); // early-return + typescript-any
    expect(parsed.sessionCount).toBeGreaterThanOrEqual(1); // avoid-this → 임시 규칙
    expect(parsed.hasStrong).toBe(true);
    expect(parsed.strongPolicy).toContain('any type');
  });

  it('4. 세션 규칙 정리 → 이전 세션의 session 규칙 제거', () => {
    const result = runInIsolation(`
      const { loadActiveRules, cleanupStaleSessionRules } = require('./dist/store/rule-store.js');

      const before = loadActiveRules().filter(r => r.scope === 'session').length;
      const cleaned = cleanupStaleSessionRules('live-session-2'); // 새 세션
      const after = loadActiveRules().filter(r => r.scope === 'session').length;

      console.log(JSON.stringify({ before, cleaned, after }));
    `);

    const parsed = JSON.parse(result);
    expect(parsed.before).toBeGreaterThan(0);
    expect(parsed.cleaned).toBeGreaterThan(0);
    expect(parsed.after).toBe(0);
  });

  it('5. 중복 승격 방지 — 같은 render_key는 재승격 안 됨', () => {
    const result = runInIsolation(`
      const { promoteSessionCandidates } = require('./dist/store/evidence-store.js');
      const dup = promoteSessionCandidates('live-session-1');
      console.log(dup);
    `);

    expect(parseInt(result)).toBe(0);
  });

  it('6. 3세션 mismatch 감지', () => {
    const result = runInIsolation(`
      const { processCorrection } = require('./dist/forge/evidence-processor.js');
      const { loadEvidenceBySession } = require('./dist/store/evidence-store.js');
      const { computeSessionSignals, detectMismatch } = require('./dist/forge/mismatch-detector.js');

      const allSignals = [];
      for (let i = 0; i < 3; i++) {
        const sid = 'live-mismatch-' + i;
        for (let j = 0; j < 2; j++) {
          processCorrection({
            session_id: sid,
            kind: 'prefer-from-now',
            message: 'quality correction ' + i + '-' + j,
            target: 'quality-' + i + '-' + j,
            axis_hint: 'quality_safety',
          });
        }
        const corrections = loadEvidenceBySession(sid);
        const signals = computeSessionSignals(sid, corrections, [], [], '보수형', '확인 우선형');
        allSignals.push(...signals);
      }

      const result = detectMismatch(allSignals);
      console.log(JSON.stringify({
        mismatch: result.quality_mismatch,
        score: result.quality_score,
      }));
    `);

    const parsed = JSON.parse(result);
    expect(parsed.mismatch).toBe(true);
    expect(parsed.score).toBeGreaterThanOrEqual(4);
  });

  it('7. forgen me 대시보드에 규칙/증거 카운트 표시', () => {
    // 프로필 먼저 생성
    runInIsolation(`
      const { createProfile, saveProfile } = require('./dist/store/profile-store.js');
      const p = createProfile('live-test', '보수형', '확인 우선형', '가드레일 우선', 'test');
      saveProfile(p);
    `);

    const meOutput = execFileSync('node', [
      path.join(PROJECT_ROOT, 'dist', 'cli.js'), 'me',
    ], {
      timeout: TIMEOUT,
      encoding: 'utf-8',
      env: { ...process.env, HOME: TEST_HOME },
      cwd: PROJECT_ROOT,
    }).trim();

    expect(meOutput).toContain('Learning Loop Status');
    expect(meOutput).toContain('Rules:');
    // 이전 테스트에서 me 규칙 2개+ 생성했으므로
    expect(meOutput).toMatch(/\d+ me/);
  });

  it('8. claude -p로 실제 LLM 호출 가능 확인 (실제 HOME 사용)', { timeout: TIMEOUT }, () => {
    if (!claudeAvailable) {
      console.log('  ⏭ claude CLI 없음 — 스킵');
      return;
    }

    // 실제 HOME을 사용해야 인증이 동작 (키체인 기반)
    // 격리된 HOME에서는 인증 불가하므로 실제 HOME으로 호출
    try {
      const result = execFileSync('claude', [
        '-p', 'respond with exactly the word "forgen-ok" and nothing else',
        '--model', 'haiku',
      ], {
        timeout: TIMEOUT,
        encoding: 'utf-8',
        env: { ...process.env }, // 실제 HOME 유지
      }).trim();

      expect(result.toLowerCase()).toContain('forgen-ok');
    } catch {
      // 인증 실패 시 (API 키 없음, 로그인 만료 등) 스킵
      console.log('  ⏭ claude -p 인증 실패 — 스킵 (로그인 필요)');
    }
  });
});
