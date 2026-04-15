import { describe, it, expect } from 'vitest';
import { resolveLaunchContext } from '../src/services/session.js';

describe('resolveLaunchContext', () => {
  it('기본 runtime은 claude다', () => {
    const context = resolveLaunchContext(['Hello']);
    expect(context.runtime).toBe('claude');
    expect(context.args).toEqual(['Hello']);
  });

  it('환경변수 FORGEN_RUNTIME이 반영된다', () => {
    const prev = process.env.FORGEN_RUNTIME;
    process.env.FORGEN_RUNTIME = 'codex';
    try {
      const context = resolveLaunchContext(['Hello']);
      expect(context.runtime).toBe('codex');
      expect(context.args).toEqual(['Hello']);
      expect(context.runtimeSource).toBe('env');
    } finally {
      if (prev === undefined) delete process.env.FORGEN_RUNTIME;
      else process.env.FORGEN_RUNTIME = prev;
    }
  });

  it('--runtime 플래그가 환경변수를 오버라이드한다', () => {
    const prev = process.env.FORGEN_RUNTIME;
    process.env.FORGEN_RUNTIME = 'codex';
    try {
      const context = resolveLaunchContext(['--runtime', 'claude', 'Hello']);
      expect(context.runtime).toBe('claude');
      expect(context.args).toEqual(['Hello']);
      expect(context.runtimeSource).toBe('flag');
    } finally {
      if (prev === undefined) delete process.env.FORGEN_RUNTIME;
      else process.env.FORGEN_RUNTIME = prev;
    }
  });

  it('--runtime=codex 형태도 동작한다', () => {
    const context = resolveLaunchContext(['--runtime=codex', 'Hello']);
    expect(context.runtime).toBe('codex');
    expect(context.args).toEqual(['Hello']);
    expect(context.runtimeSource).toBe('flag');
  });

  it('--runtime 옵션 제거 후 나머지 args만 전달된다', () => {
    const context = resolveLaunchContext(['--runtime', 'codex', 'Hello']);
    expect(context.runtime).toBe('codex');
    expect(context.args).toEqual(['Hello']);
  });

  it('미지원 --runtime 값은 args로 유지된다', () => {
    const context = resolveLaunchContext(['--runtime', 'gpt', 'Hello']);
    expect(context.runtime).toBe('claude');
    expect(context.args).toEqual(['gpt', 'Hello']);
    expect(context.runtimeSource).toBe('default');
  });

  it('--runtime= 형태가 비어있으면 args가 보존된다', () => {
    const context = resolveLaunchContext(['--runtime=', 'Hello']);
    expect(context.runtime).toBe('claude');
    expect(context.args).toEqual(['Hello']);
    expect(context.runtimeSource).toBe('default');
  });

});
