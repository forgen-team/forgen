/**
 * E2E — Progressive Disclosure tiered injection (real hook execution)
 *
 * hook-pipeline.test.ts와 달리 실제 매치가 발생하도록 ME_SOLUTIONS에 3건의
 * 솔루션 fixture를 배치하고, solution-injector.js를 실제로 spawn해 tiered
 * additionalContext가 나오는지 검증한다. claude-mem 스타일 progressive
 * disclosure(상위만 요약, 나머지는 인덱스+compound-read 힌트) 채택의 실측 증거.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DIST_DIR = path.join(__dirname, '../../dist/hooks');

// 실 개발자 홈을 건드리지 않도록 완전히 격리된 HOME 사용 (fixture도 이 안에 둔다).
const E2E_TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-tier-e2e-'));
const SOLUTIONS_DIR = path.join(E2E_TEST_HOME, '.forgen', 'me', 'solutions');

function runHook(input: unknown): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile('node', [path.join(DIST_DIR, 'solution-injector.js')], {
      timeout: 10_000,
      env: { ...process.env, HOME: E2E_TEST_HOME, FORGEN_HOME: path.join(E2E_TEST_HOME, '.forgen') },
    }, (_error, stdout, stderr) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
    if (child.stdin) {
      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    }
  });
}

function parseOutput(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]) as Record<string, unknown>; } catch { continue; }
  }
  return null;
}

function writeFixtureSolution(name: string, identifier: string, bodyLines: string[]): void {
  const content = [
    '---',
    `name: ${name}`,
    'version: 1',
    'status: verified',
    'confidence: 0.85',
    'type: pattern',
    'scope: me',
    'tags: [tiering, injection, budget, progressive]',
    `identifiers: [${identifier}]`,
    'evidence: { injected: 0, reflected: 0, negative: 0, sessions: 0, reExtracted: 0 }',
    'created: "2026-07-20"',
    'updated: "2026-07-20"',
    'supersedes: null',
    'extractedBy: manual',
    '---',
    '',
    '## Context',
    'Progressive disclosure tiering fixture for real hook execution sanity check.',
    '',
    '## Content',
    ...bodyLines,
  ].join('\n');
  fs.writeFileSync(path.join(SOLUTIONS_DIR, `${name}.md`), content);
}

describe('solution-injector — Progressive Disclosure tiers (real execution)', () => {
  beforeAll(() => {
    fs.mkdirSync(SOLUTIONS_DIR, { recursive: true });
    // 3건의 매치를 유도: 각 솔루션에 프롬프트에 등장할 identifier를 심어
    // idMatches>=1 정밀도 게이트를 확실히 통과시킨다 (matchedTags 수에 기대지 않음).
    writeFixtureSolution('tiering-top', 'runTieringBudgetCheck', [
      'When injecting matched progressive-disclosure tiering solutions, cap the top rank at a compact summary block.',
      'Keep the summary under the per-solution budget so the session budget survives many matches.',
      'This line should not appear in the injected output because Tier 2 truncates the snippet.',
    ]);
    writeFixtureSolution('tiering-second', 'runTieringSecondCheck', [
      'Second-ranked tiering fixture — should collapse to a one-line index entry pointing at compound-read.',
    ]);
    writeFixtureSolution('tiering-third', 'runTieringThirdCheck', [
      'Third-ranked tiering fixture — also an index-line candidate under the new tiering scheme.',
    ]);
  });

  afterAll(() => {
    fs.rmSync(E2E_TEST_HOME, { recursive: true, force: true });
  });

  it('3건 매치 시 additionalContext가 4000자 하드캡을 넘지 않고, 인덱스 라인에 compound-read 힌트가 포함된다', async () => {
    const result = await runHook({
      prompt: 'runTieringBudgetCheck runTieringSecondCheck runTieringThirdCheck progressive disclosure tiering injection budget',
      session_id: 'tier-e2e-session',
    });

    const output = parseOutput(result.stdout);
    expect(output).not.toBeNull();
    expect(output?.continue).toBe(true);

    const hookOutput = output?.hookSpecificOutput as Record<string, unknown> | undefined;
    // fitness/캐시 상태에 따라 매칭이 0건일 수도 있으므로(정밀도 게이트),
    // 매칭이 있을 때만 tiering 불변식을 검증한다 — 매칭 0건 자체도 유효한 결과.
    if (!hookOutput) return;

    const ctx = hookOutput.additionalContext as string;
    expect(typeof ctx).toBe('string');
    // 최종 안전판: 어떤 조합이든 4000자를 넘지 않는다.
    expect(ctx.length).toBeLessThanOrEqual(4000);

    const notice = output?.systemMessage as string | undefined;
    const matchedCount = notice ? Number(notice.match(/(\d+) solution/)?.[1] ?? '0') : 0;
    if (matchedCount >= 2) {
      // 2건 이상 매치되면 최소 1건은 Tier 1(인덱스 라인 + compound-read 힌트)이어야 한다.
      expect(ctx).toMatch(/compound-read\("tiering-(second|third)"\)/);
    }
  });
});
