import { describe, it, expect } from 'vitest';
import { classifyFailure, NESTED_ISOLATION_ARGS } from '../src/core/extraction-haiku.js';

describe('classifyFailure (D4 사유 분류)', () => {
  it('ENOENT = 호출 불가, 재시도 안 함', () => {
    expect(classifyFailure({ code: 'ENOENT' })).toMatchObject({ outcome: 'unavailable', retriable: false });
  });
  it('타임아웃 = 재시도 대상', () => {
    expect(classifyFailure({ code: 'ETIMEDOUT' })).toMatchObject({ outcome: 'timeout', retriable: true });
    expect(classifyFailure({ signal: 'SIGTERM' })).toMatchObject({ outcome: 'timeout', retriable: true });
  });
  it('미로그인 = 호출 불가(재시도 무의미), 한도 = 재시도', () => {
    expect(classifyFailure({ stderr: 'Please run /login' })).toMatchObject({ outcome: 'unavailable', retriable: false });
    expect(classifyFailure({ stdout: 'Claude AI usage limit reached' })).toMatchObject({ outcome: 'rate-limited', retriable: true });
  });
  it('중첩 호출은 도구·MCP·설정·슬래시 명령을 모두 끈다', () => {
    const a = NESTED_ISOLATION_ARGS.join(' ');
    expect(a).toContain('--strict-mcp-config');
    expect(a).toContain('--no-session-persistence');
    expect(a).toContain('--disable-slash-commands');
    expect(NESTED_ISOLATION_ARGS[NESTED_ISOLATION_ARGS.indexOf('--tools') + 1]).toBe('');
    expect(NESTED_ISOLATION_ARGS[NESTED_ISOLATION_ARGS.indexOf('--setting-sources') + 1]).toBe('');
  });
});
