import { describe, it, expect } from 'vitest';
import { effortAdvisory } from '../src/core/effort-advisory.js';

describe('effort-advisory (ADR-009 §5, nudge-only)', () => {
  it('recommends xhigh when a long-running context is active', () => {
    const a = effortAdvisory({ longRunningActive: true });
    expect(a.recommend).toBe('xhigh');
    expect(a.reason).toMatch(/ultracode|xhigh/);
    expect(a.reason).toMatch(/forge-loop/);
  });

  it('recommends high (default) for routine work', () => {
    const a = effortAdvisory({ longRunningActive: false });
    expect(a.recommend).toBe('high');
  });

  it('is explicit that forgen cannot set effort programmatically (nudge-only)', () => {
    const a = effortAdvisory({ longRunningActive: true });
    expect(a.reason).toMatch(/직접 설정할 수|nudge/i);
  });
});
