import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-candidate-exploration-${process.pid}`,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const { incrementEvidence } = await import('../src/engine/solution-writer.js');
const { parseFrontmatterOnly } = await import('../src/engine/solution-format.js');
const { ME_SOLUTIONS } = await import('../src/core/paths.js');

function writeSolution(name: string, status: 'candidate' | 'verified', injected: number): string {
  fs.mkdirSync(ME_SOLUTIONS, { recursive: true });
  const fm = {
    name,
    version: 1,
    status,
    confidence: 0.6,
    type: 'pattern',
    scope: 'me',
    tags: ['test'],
    identifiers: [] as string[],
    created: '2026-04-16',
    updated: '2026-04-16',
    supersedes: null,
    extractedBy: 'auto',
    evidence: { injected, reflected: 0, negative: 0, sessions: 0, reExtracted: 0 },
  };
  const p = path.join(ME_SOLUTIONS, `${name}.md`);
  fs.writeFileSync(p, `---\n${yaml.dump(fm)}---\n\nbody\n`);
  return p;
}

function readStatus(filePath: string): { status: string; injected: number } {
  const fm = parseFrontmatterOnly(fs.readFileSync(filePath, 'utf-8'));
  if (!fm) throw new Error('invalid frontmatter');
  return { status: fm.status, injected: fm.evidence.injected };
}

/**
 * Invariant: incrementEvidence는 status를 절대 바꾸지 않는다.
 *
 * 이 테스트는 "핵심 피드백 루프 3축 single source of truth" 원칙을 잠근다.
 * 과거 inject≥5 자동 verified 승급 버그가 재유입되면 여기서 즉시 잡힌다.
 * 모든 status 전이는 compound-lifecycle.ts::runLifecycleCheck 또는
 * verifySolution 단일 경로로만 일어나야 한다.
 */
describe('incrementEvidence invariant: never mutates status', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('verified 솔루션에 inject를 쌓아도 verified 유지', () => {
    const p = writeSolution('mature', 'verified', 100);
    incrementEvidence('mature', 'injected');
    expect(readStatus(p)).toEqual({ status: 'verified', injected: 101 });
  });

  it('candidate 솔루션에 inject 4회 — candidate 유지', () => {
    const p = writeSolution('fresh', 'candidate', 3);
    incrementEvidence('fresh', 'injected');
    expect(readStatus(p)).toEqual({ status: 'candidate', injected: 4 });
  });

  it('candidate 솔루션에 inject 5회 — 승급 금지 (dual-path 제거 invariant)', () => {
    const p = writeSolution('fresh', 'candidate', 4);
    incrementEvidence('fresh', 'injected');
    expect(readStatus(p)).toEqual({ status: 'candidate', injected: 5 });
  });

  it('candidate 솔루션에 inject 10회 누적해도 승급 금지 (5회 threshold 훨씬 초과)', () => {
    const p = writeSolution('fresh', 'candidate', 0);
    for (let i = 0; i < 10; i++) incrementEvidence('fresh', 'injected');
    expect(readStatus(p)).toEqual({ status: 'candidate', injected: 10 });
  });

  it('reflected 증가도 status 변경 없음', () => {
    const p = writeSolution('fresh', 'candidate', 10);
    incrementEvidence('fresh', 'reflected');
    expect(readStatus(p)).toMatchObject({ status: 'candidate' });
  });

  it('sessions 증가도 status 변경 없음', () => {
    const p = writeSolution('fresh', 'candidate', 10);
    incrementEvidence('fresh', 'sessions');
    expect(readStatus(p)).toMatchObject({ status: 'candidate' });
  });
});

/**
 * Invariant: 프로덕션 소스에서 verified status flip이 허용 모듈에만 존재한다.
 *
 * grep-based 스모크 테스트. 새 모듈이 status를 'verified'로 재할당하려 하면
 * 이 테스트가 실패한다.
 */
describe('source invariant: verified flip locations', () => {
  const ALLOWED_FILES = new Set([
    'src/engine/compound-lifecycle.ts',
  ]);

  it('status = verified 재할당은 허용 모듈에만 존재', () => {
    const srcRoot = path.join(__dirname, '..', 'src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') continue;
          walk(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
          const rel = path.relative(path.join(__dirname, '..'), full);
          if (ALLOWED_FILES.has(rel)) continue;
          const content = fs.readFileSync(full, 'utf-8');
          // 탐지 대상: 'status = "verified"' 혹은 status: 'verified' (객체 리터럴 안의 재할당)
          // 허용: z.enum(), type guards, 비교문 (=== 'verified'), 문자열 리터럴 비교
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // 재할당 패턴만 잡음: `.status = 'verified'` 또는 `status: 'verified'` (객체에서)
            // 주석/테스트/문자열 안은 휴리스틱으로 제외
            if (/\.status\s*=\s*['"]verified['"]/.test(line)) {
              offenders.push(`${rel}:${i + 1} — ${line.trim()}`);
            }
          }
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});
