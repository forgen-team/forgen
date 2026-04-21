/**
 * Invariant: compound archive import guards against path traversal
 * including sibling-directory prefix collision.
 *
 * Follow-up audit (2026-04-21, finding #A): prior
 * `realDest.startsWith(ME_DIR)` permitted `/Users/x/.forgen/me-evil/...`
 * because the string starts with `/Users/x/.forgen/me`. Fix uses
 * `parent + path.sep` so sibling directories cannot collide.
 *
 * macOS bsdtar refuses to extract archives containing `..` paths, so
 * the fix is primarily defense-in-depth. We unit-test the containment
 * helper directly to assert the check is correct regardless of the
 * tar implementation on the test host.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-import-traversal-${process.pid}`,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const { importKnowledge, isPathInside } = await import('../src/engine/compound-export.js');
const { ME_DIR } = await import('../src/core/paths.js');

describe('isPathInside — sibling prefix collision defense', () => {
  const parent = '/home/u/.forgen/me' + path.sep;

  it('직속 자식 경로 통과', () => {
    expect(isPathInside(parent, '/home/u/.forgen/me/solutions/x.md')).toBe(true);
    expect(isPathInside(parent, '/home/u/.forgen/me/a')).toBe(true);
  });

  it('sibling-prefix 공격 거부 (/me-evil/…)', () => {
    expect(isPathInside(parent, '/home/u/.forgen/me-evil/payload.md')).toBe(false);
    expect(isPathInside(parent, '/home/u/.forgen/me2/x')).toBe(false);
  });

  it('부모 자신은 "inside" 아님', () => {
    expect(isPathInside(parent, '/home/u/.forgen/me')).toBe(false);
  });

  it('외부 절대 경로 거부', () => {
    expect(isPathInside(parent, '/etc/passwd')).toBe(false);
    expect(isPathInside(parent, '/home/u/.ssh/authorized_keys')).toBe(false);
  });

  it('../ 포함 경로는 path.resolve로 정규화된 뒤 체크', () => {
    // path.resolve는 `../`를 제거하므로 악의적 상대 경로가 부모 밖이 되면 거부됨
    expect(isPathInside(parent, '/home/u/.forgen/me/../me-evil/x')).toBe(false);
    expect(isPathInside(parent, '/home/u/.forgen/me/../../etc/passwd')).toBe(false);
  });
});

describe('importKnowledge happy path (end-to-end)', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(ME_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('정상 솔루션 파일은 import된다', () => {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-arch-ok-'));
    try {
      fs.mkdirSync(path.join(stage, 'solutions'), { recursive: true });
      fs.writeFileSync(path.join(stage, 'solutions', 'hello.md'), '---\nname: hello\n---\nhi');
      const archive = `${stage}.tar.gz`;
      execFileSync('tar', ['czf', archive, '-C', stage, 'solutions/hello.md'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const result = importKnowledge(archive);
      expect(result.imported).toBe(1);
      expect(fs.existsSync(path.join(ME_DIR, 'solutions', 'hello.md'))).toBe(true);
      fs.rmSync(archive);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });
});
