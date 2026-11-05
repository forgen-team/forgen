import { describe, it, expect, vi } from 'vitest';

describe('buildSessionSummary — honest-null (인과 절약 미주장, % 정확도)', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');

  it('[SEV-3] 다중 주입(솔루션>프롬프트)에도 불가능한 >100% 없음 — 원시 밀도', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-sess-sum-'));
    const stateDir = path.join(home, '.forgen', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const injected = Array.from({ length: 15 }, (_, i) => ({ name: `sol-${i}`, injectedAt: '2026-07-21T00:00:00Z' }));
    // sanitizeId('sess1') === 'sess1'
    fs.writeFileSync(path.join(stateDir, 'solution-cache-sess1.json'), JSON.stringify({ injected }));
    const orig = process.env.HOME; process.env.HOME = home;
    try {
      vi.resetModules();
      const m = await import('../src/hooks/context-guard.js');
      const out = m.buildSessionSummary('sess1', 10).replace(/\x1b\[[0-9;]*m/g, '');
      const pctMatch = out.match(/(\d+)\s*%/);
      const pct = pctMatch ? Number(pctMatch[1]) : 0;
      expect(pct, `불가능한 비율: ${out}`).toBeLessThanOrEqual(100);
      expect(out).toContain('주입된 compound: 15건');
      // 인과 절약/카운터팩추얼 어휘 없음
      expect(out).not.toMatch(/절약|없었으면|효과|덕분|단축/);
    } finally {
      if (orig === undefined) delete process.env.HOME; else process.env.HOME = orig;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
