import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-rollback-${process.pid}`,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const { rollbackSolutions } = await import('../src/engine/compound-cli.js');
const { ME_SOLUTIONS, ARCHIVED_DIR } = await import('../src/core/paths.js');

function writeSolution(
  name: string,
  opts: { createdDaysAgo: number; reflected?: number; sessions?: number } = { createdDaysAgo: 1 },
): string {
  fs.mkdirSync(ME_SOLUTIONS, { recursive: true });
  const createdDate = new Date(Date.now() - opts.createdDaysAgo * 86400 * 1000)
    .toISOString()
    .split('T')[0];
  const fm = {
    name,
    version: 1,
    status: 'candidate',
    confidence: 0.6,
    type: 'pattern',
    scope: 'me',
    tags: ['test'],
    identifiers: [] as string[],
    created: createdDate,
    updated: createdDate,
    supersedes: null,
    extractedBy: 'auto',
    evidence: {
      injected: 0,
      reflected: opts.reflected ?? 0,
      negative: 0,
      sessions: opts.sessions ?? 0,
      reExtracted: 0,
    },
  };
  const p = path.join(ME_SOLUTIONS, `${name}.md`);
  fs.writeFileSync(p, `---\n${yaml.dump(fm)}---\n\nbody\n`);
  return p;
}

function daysAgoIso(n: number): string {
  return new Date(Date.now() - n * 86400 * 1000).toISOString().split('T')[0];
}

/**
 * Invariant: rollback은 **archive 이동**이며 `unlinkSync` 영구 삭제가 아니다.
 *
 * 과거 버그: `compound-cli.rollbackSolutions`가 `fs.unlinkSync`로 솔루션 파일을
 * 지워 복구 불가였다. "time-bounded rollback"이 사실상 "영구 삭제 with date
 * filter"로 동작. 이 테스트는 그 regression을 잠근다.
 */
describe('rollback invariant: archive-based, never destructive', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('rollback 대상은 archive dir로 이동하고 원본은 사라진다', () => {
    const src = writeSolution('auto-a', { createdDaysAgo: 1 });
    const result = rollbackSolutions(daysAgoIso(3));

    expect(fs.existsSync(src)).toBe(false); // 원본 사라짐
    expect(result.archived).toEqual([src]);
    expect(result.archiveDir).not.toBeNull();
    expect(fs.existsSync(result.archiveDir!)).toBe(true);

    // archive dir에 파일이 존재해야 복구 가능
    const archivedFiles = fs.readdirSync(result.archiveDir!);
    expect(archivedFiles.length).toBe(1);
    expect(archivedFiles[0]).toContain('auto-a.md');
  });

  it('archive 파일은 원본과 동일한 content를 가진다 (복원 가능)', () => {
    const src = writeSolution('auto-b', { createdDaysAgo: 1 });
    const originalContent = fs.readFileSync(src, 'utf-8');
    const result = rollbackSolutions(daysAgoIso(3));

    const archivedFiles = fs.readdirSync(result.archiveDir!);
    const archivedPath = path.join(result.archiveDir!, archivedFiles[0]);
    const archivedContent = fs.readFileSync(archivedPath, 'utf-8');
    expect(archivedContent).toBe(originalContent);
  });

  it('reflected > 0 인 솔루션은 rollback에서 제외 (사용된 것 보호)', () => {
    const used = writeSolution('used', { createdDaysAgo: 1, reflected: 3 });
    const fresh = writeSolution('fresh', { createdDaysAgo: 1 });

    const result = rollbackSolutions(daysAgoIso(3));

    expect(fs.existsSync(used)).toBe(true); // 유지
    expect(fs.existsSync(fresh)).toBe(false); // archive 이동
    expect(result.archived).toEqual([fresh]);
  });

  it('sessions > 0 인 솔루션도 rollback에서 제외', () => {
    const used = writeSolution('used-session', { createdDaysAgo: 1, sessions: 1 });
    const fresh = writeSolution('fresh', { createdDaysAgo: 1 });

    const result = rollbackSolutions(daysAgoIso(3));

    expect(fs.existsSync(used)).toBe(true);
    expect(fs.existsSync(fresh)).toBe(false);
    expect(result.archived).toEqual([fresh]);
  });

  it('since 날짜 이전에 생성된 솔루션은 대상 아님', () => {
    const old = writeSolution('old', { createdDaysAgo: 10 });
    const recent = writeSolution('recent', { createdDaysAgo: 1 });

    const result = rollbackSolutions(daysAgoIso(5));

    expect(fs.existsSync(old)).toBe(true); // 5일보다 전, 건드리지 않음
    expect(fs.existsSync(recent)).toBe(false); // archive 이동
    expect(result.archived).toEqual([recent]);
  });

  it('--dry-run: 파일 변경 없이 대상 목록만 반환', () => {
    const src = writeSolution('auto-c', { createdDaysAgo: 1 });
    const result = rollbackSolutions(daysAgoIso(3), { dryRun: true });

    expect(fs.existsSync(src)).toBe(true); // 원본 유지
    expect(result.dryRun).toBe(true);
    expect(result.archived).toEqual([]);
    expect(result.skipped).toEqual([src]);
    expect(result.archiveDir).toBeNull();
    expect(fs.existsSync(ARCHIVED_DIR)).toBe(false); // archive dir 생성 안 됨
  });

  it('잘못된 날짜 포맷은 errors에 기록', () => {
    writeSolution('some', { createdDaysAgo: 1 });
    const result = rollbackSolutions('not-a-date');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('invalid-date');
    expect(result.archived).toEqual([]);
  });
});

/**
 * Invariant: `compound-cli.rollbackSolutions` 본문에 `unlinkSync`가 직접
 * 존재하지 않는다 (archive rename만 사용). source-level grep.
 */
describe('source invariant: rollback path never calls unlinkSync on solution files', () => {
  it('compound-cli.ts::rollbackSolutions 본문에 fs.unlinkSync 없음', () => {
    const srcPath = path.join(__dirname, '..', 'src', 'engine', 'compound-cli.ts');
    const content = fs.readFileSync(srcPath, 'utf-8');

    // rollbackSolutions 함수 본문 추출: 함수 선언부터 top-level `}` (indentation 0)까지
    const startIdx = content.indexOf('export function rollbackSolutions');
    expect(startIdx).toBeGreaterThan(-1);
    const afterLines = content.slice(startIdx).split('\n');
    let bodyEnd = -1;
    let sawOpenBrace = false;
    for (let i = 0; i < afterLines.length; i++) {
      const line = afterLines[i];
      if (!sawOpenBrace && line.endsWith('{')) sawOpenBrace = true;
      // 함수 본문 종료: 줄이 정확히 '}' (column 0의 닫는 중괄호)
      if (sawOpenBrace && line === '}') { bodyEnd = i; break; }
    }
    expect(bodyEnd).toBeGreaterThan(0);
    const body = afterLines.slice(0, bodyEnd + 1).join('\n');
    expect(body).not.toMatch(/fs\.unlinkSync/);
    // renameSync + archive 경로 존재 확인 (archive rename 방식 사용 중임을 입증)
    expect(body).toMatch(/renameSync/);
    expect(body).toMatch(/ARCHIVED_DIR|archived/);
  });
});
