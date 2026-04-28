import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: '/tmp/forgen-test-post-tool-use-full',
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

import {
  ERROR_PATTERNS,
  detectErrorPattern,
  trackModifiedFile,
  validateAgentOutput,
} from '../src/hooks/post-tool-use.js';

describe('post-tool-use - extended', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  // ── ERROR_PATTERNS ──

  describe('ERROR_PATTERNS', () => {
    it('패턴 목록이 비어있지 않다', () => {
      expect(ERROR_PATTERNS.length).toBeGreaterThan(0);
    });

    it('모든 패턴에 description이 있다', () => {
      for (const p of ERROR_PATTERNS) {
        expect(p.description).toBeTruthy();
      }
    });
  });

  // ── detectErrorPattern ──

  describe('detectErrorPattern', () => {
    it('ENOENT를 감지한다', () => {
      const result = detectErrorPattern('Error: ENOENT: no such file or directory');
      expect(result).not.toBeNull();
      expect(result!.description).toContain('file not found');
    });

    it('permission denied를 감지한다', () => {
      const result = detectErrorPattern('EACCES: permission denied');
      expect(result).not.toBeNull();
      expect(result!.description).toContain('permission');
    });

    it('SyntaxError를 감지한다', () => {
      const result = detectErrorPattern('SyntaxError: Unexpected token');
      expect(result).not.toBeNull();
      expect(result!.description).toContain('syntax');
    });

    it('out of memory를 감지한다', () => {
      const result = detectErrorPattern('FATAL ERROR: out of memory');
      expect(result).not.toBeNull();
      expect(result!.description).toContain('memory');
    });

    it('정상 출력에서는 null 반환', () => {
      expect(detectErrorPattern('Build completed successfully.')).toBeNull();
    });

    it('빈 텍스트는 null 반환', () => {
      expect(detectErrorPattern('')).toBeNull();
    });

    it('no space left를 감지한다', () => {
      const result = detectErrorPattern('write ENOSPC: no space left on device');
      expect(result).not.toBeNull();
    });

    it('segmentation fault를 감지한다', () => {
      const result = detectErrorPattern('segmentation fault (core dumped)');
      expect(result).not.toBeNull();
    });
  });

  // ── trackModifiedFile ──

  describe('trackModifiedFile', () => {
    it('새 파일을 추적한다', () => {
      const state = { sessionId: 'test', files: {}, toolCallCount: 0 };
      const result = trackModifiedFile(state, '/path/to/file.ts', 'Edit');
      expect(result.count).toBe(1);
      expect(result.state.files['/path/to/file.ts']).toBeDefined();
      expect(result.state.files['/path/to/file.ts'].tool).toBe('Edit');
    });

    it('같은 파일의 카운트를 증가시킨다', () => {
      const state = { sessionId: 'test', files: {}, toolCallCount: 0 };
      trackModifiedFile(state, '/path/file.ts', 'Edit');
      const result = trackModifiedFile(state, '/path/file.ts', 'Write');
      expect(result.count).toBe(2);
      expect(result.state.files['/path/file.ts'].tool).toBe('Write');
    });

    it('여러 파일을 독립적으로 추적한다', () => {
      const state = { sessionId: 'test', files: {}, toolCallCount: 0 };
      trackModifiedFile(state, '/a.ts', 'Edit');
      trackModifiedFile(state, '/b.ts', 'Write');
      trackModifiedFile(state, '/a.ts', 'Edit');
      expect(state.files['/a.ts'].count).toBe(2);
      expect(state.files['/b.ts'].count).toBe(1);
    });

    it('lastModified를 업데이트한다', () => {
      const state = { sessionId: 'test', files: {}, toolCallCount: 0 };
      trackModifiedFile(state, '/file.ts', 'Edit');
      expect(state.files['/file.ts'].lastModified).toBeTruthy();
    });
  });

  // ── validateAgentOutput (Tier 2-F) ──

  describe('validateAgentOutput', () => {
    it('빈 출력을 감지한다', () => {
      const result = validateAgentOutput('');
      expect(result).not.toBeNull();
      expect(result!.signal).toBe('agent_empty_output');
      expect(result!.severity).toBe('warning');
    });

    it('너무 짧은 출력을 감지한다', () => {
      const result = validateAgentOutput('OK');
      expect(result).not.toBeNull();
      expect(result!.signal).toBe('agent_empty_output');
    });

    it('정상적인 긴 출력에서는 null 반환', () => {
      const longOutput = 'Here is a detailed analysis of the codebase. The main entry point is src/index.ts which imports...';
      expect(validateAgentOutput(longOutput)).toBeNull();
    });

    it('agent 실패 패턴을 감지한다', () => {
      const output = 'I couldn\'t find any files matching the pattern. The search returned no results in the repository.';
      const result = validateAgentOutput(output);
      expect(result).not.toBeNull();
      expect(result!.signal).toBe('agent_unable');
    });

    it('타임아웃 패턴을 감지한다', () => {
      const output = 'The operation timed out after 30 seconds. The agent was unable to complete the search within the deadline.';
      const result = validateAgentOutput(output);
      expect(result).not.toBeNull();
      expect(result!.signal).toBe('agent_timeout');
    });

    it('컨텍스트 오버플로우를 감지한다', () => {
      const output = 'The file is too large to read in its entirety. The context limit exceeded the maximum allowed size for processing.';
      const result = validateAgentOutput(output);
      expect(result).not.toBeNull();
      expect(result!.signal).toBe('agent_context_overflow');
    });

    // 회귀 박제: tool_response 가 object / array 인 경우 (sub-agent 결과 등)
    // 과거 trim 호출 직전에 string 가정 → TypeError 폭발 했던 버그.
    it('tool_response 가 object 인 경우에도 crash 없이 normalize', () => {
      const result = validateAgentOutput({ items: ['a', 'b'] } as unknown);
      // stringified JSON 길이가 충분하면 null, 짧으면 agent_empty_output. 둘 다 throw 없으면 통과.
      expect(() => result).not.toThrow();
    });

    it('tool_response 가 null/undefined 일 때도 안전하게 empty 처리', () => {
      expect(() => validateAgentOutput(null as unknown)).not.toThrow();
      expect(() => validateAgentOutput(undefined as unknown)).not.toThrow();
      const r = validateAgentOutput(null as unknown);
      expect(r?.signal).toBe('agent_empty_output');
    });

    it('null/undefined 입력을 안전하게 처리한다', () => {
      const result = validateAgentOutput(null as unknown as string);
      expect(result).not.toBeNull();
      expect(result!.signal).toBe('agent_empty_output');
    });
  });
});
