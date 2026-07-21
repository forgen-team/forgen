/**
 * extraction-session W2-5 통합 테스트 — loadClaudeProjectSessionContext 가
 * ~/.claude/projects 원시 트랜스크립트를 직접 읽을 때 <private> 범위를
 * 배제하는지 실측 (flow-reviewer SEV-3: 마지막 원시-읽기 경로).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: '/tmp/forgen-test-extraction-session-private',
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

// cwd 는 realpath 가능해야 프로젝트 디렉터리 매칭이 성립 → 실제 디렉터리 생성.
const CWD = path.join(os.tmpdir(), 'forgen-priv-cwd');

describe('extraction-session <private> 제외 (W2-5, SEV-3)', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(CWD, { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('원시 트랜스크립트의 user 프롬프트 <private> 범위를 prompts 에서 배제', async () => {
    const { loadClaudeProjectSessionContext } = await import('../src/engine/extraction-session.js');

    const dirName = CWD.replace(/[:\\/]/g, '-');
    const projectDir = path.join(TEST_HOME, '.claude', 'projects', dirName);
    fs.mkdirSync(projectDir, { recursive: true });

    const entries = [
      JSON.stringify({ type: 'user', cwd: CWD, message: { role: 'user', content: 'ask about PUBLICPROMPT design' } }),
      JSON.stringify({ type: 'user', cwd: CWD, message: { role: 'user', content: 'here <private>PRIVATEPROMPT789</private> ok' } }),
      JSON.stringify({ type: 'user', cwd: CWD, message: { role: 'user', content: '<private>WHOLLYPRIVATE555</private>' } }),
    ];
    fs.writeFileSync(path.join(projectDir, 'session.jsonl'), entries.join('\n'));

    const result = loadClaudeProjectSessionContext(CWD, '');
    const joined = result.prompts.join('\n');

    expect(joined).toContain('PUBLICPROMPT');
    expect(joined).not.toContain('PRIVATEPROMPT789');
    expect(joined).not.toContain('WHOLLYPRIVATE555');
    // 통째 private 프롬프트는 push 자체가 스킵됨.
    expect(result.prompts.some(p => p.trim() === '')).toBe(false);
  });

  it('write 스니펫의 <private> 범위 배제', async () => {
    const { loadClaudeProjectSessionContext } = await import('../src/engine/extraction-session.js');

    const dirName = CWD.replace(/[:\\/]/g, '-');
    const projectDir = path.join(TEST_HOME, '.claude', 'projects', dirName);
    fs.mkdirSync(projectDir, { recursive: true });

    const entry = JSON.stringify({
      type: 'assistant',
      cwd: CWD,
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          name: 'Write',
          input: { file_path: '/x/app.ts', content: 'export const A = 1; <private>const KEY = "SNIPPETSECRET";</private>' },
        }],
      },
    });
    fs.writeFileSync(path.join(projectDir, 'session.jsonl'), entry);

    const result = loadClaudeProjectSessionContext(CWD, '');
    const snippets = result.writes.map(w => w.contentSnippet).join('\n');
    expect(snippets).toContain('export const A');
    expect(snippets).not.toContain('SNIPPETSECRET');
  });
});
