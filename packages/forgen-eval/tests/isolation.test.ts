import { describe, it, expect, afterEach } from 'vitest';
import { evalChildEnv, getIsolatedForgenHome, useRealHome } from '../src/utils/isolation.js';

describe('evalChildEnv', () => {
  const prevEnv = process.env.FORGEN_EVAL_USE_REAL_HOME;
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.FORGEN_EVAL_USE_REAL_HOME;
    else process.env.FORGEN_EVAL_USE_REAL_HOME = prevEnv;
  });

  it('기본: 격리 FORGEN_HOME + FORGEN_SYNTHETIC=1, 호출자 FORGEN_HOME 덮어씀', () => {
    delete process.env.FORGEN_EVAL_USE_REAL_HOME;
    const env = evalChildEnv({ FORGEN_HOME: '/home/real/.forgen' });
    expect(env.FORGEN_HOME).toBe(getIsolatedForgenHome());
    expect(env.FORGEN_HOME).toContain('forgen-eval-home-');
    expect(env.FORGEN_SYNTHETIC).toBe('1');
  });
  it('같은 프로세스에서 격리 홈은 재사용', () => {
    expect(getIsolatedForgenHome()).toBe(getIsolatedForgenHome());
  });
  it('FORGEN_EVAL_USE_REAL_HOME=1: FORGEN_HOME 미개입, synthetic 은 유지', () => {
    process.env.FORGEN_EVAL_USE_REAL_HOME = '1';
    expect(useRealHome()).toBe(true);
    const env = evalChildEnv({ FORGEN_HOME: '/x' });
    expect(env.FORGEN_HOME).toBe('/x');
    expect(env.FORGEN_SYNTHETIC).toBe('1');
  });
});
