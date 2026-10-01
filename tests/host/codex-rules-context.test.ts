/**
 * ADR-014 D1 — Codex 개인화 룰 주입 블록 + 컴팩션 재주입 플래그
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let originalForgenHome: string | undefined;
let isolatedHome: string;

beforeEach(() => {
  originalForgenHome = process.env.FORGEN_HOME;
  isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-codex-rules-'));
  process.env.FORGEN_HOME = isolatedHome;
  vi.resetModules();
});

afterEach(() => {
  if (originalForgenHome === undefined) delete process.env.FORGEN_HOME;
  else process.env.FORGEN_HOME = originalForgenHome;
  fs.rmSync(isolatedHome, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function load() {
  return await import('../../src/host/codex-rules-context.js');
}

describe('renderCodexRulesBlock', () => {
  it('룰 파일 맵을 <forgen-rules host="codex"> 블록으로 감싼다', async () => {
    const { renderCodexRulesBlock } = await load();
    const out = renderCodexRulesBlock({
      'v1-rules.md': '# Forgen v1 — Rendered Rules\n## Must Not\n- mock 으로 완료 선언 금지',
      'project-context.md': '# Security\n- secret-filter',
    });
    expect(out).not.toBeNull();
    expect(out).toMatch(/^<forgen-rules host="codex">/);
    expect(out).toMatch(/<\/forgen-rules>$/);
    expect(out).toContain('<!-- v1-rules.md -->');
    expect(out).toContain('mock 으로 완료 선언 금지');
    expect(out).toContain('<!-- project-context.md -->');
    expect(out).toContain('.claude/rules/');
  });

  it('빈/공백 파일만 있으면 null', async () => {
    const { renderCodexRulesBlock } = await load();
    expect(renderCodexRulesBlock({})).toBeNull();
    expect(renderCodexRulesBlock({ 'a.md': '   \n' })).toBeNull();
  });

  it('파일당 perRuleFile 캡 + 총량 totalRuleFiles 캡 (Claude 와 동일 상수)', async () => {
    const { renderCodexRulesBlock } = await load();
    const { RULE_FILE_CAPS } = await import('../../src/hooks/shared/injection-caps.js');
    const big = 'x'.repeat(RULE_FILE_CAPS.perRuleFile + 500);
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i += 1) files[`f${i}.md`] = big;
    const out = renderCodexRulesBlock(files)!;
    expect(out).toContain('(capped at rule file limit)');
    // 총량 캡: 10 × 3000 = 30000 > 15000 → 일부 파일은 생략
    const included = (out.match(/<!-- f\d\.md -->/g) ?? []).length;
    expect(included).toBeLessThan(10);
    expect(included).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(RULE_FILE_CAPS.totalRuleFiles + 2000);
  });
});

describe('buildCodexRulesContext', () => {
  it('generateClaudeRuleFiles 산출(정적 security/anti-pattern + v1 rules)을 블록으로 만든다', async () => {
    const { buildCodexRulesContext } = await load();
    const out = await buildCodexRulesContext(isolatedHome, '## Must Not\n- 사용자 confirm 없는 rm -rf 금지');
    expect(out).not.toBeNull();
    expect(out).toContain('<!-- project-context.md -->');
    expect(out).toContain('<!-- v1-rules.md -->');
    expect(out).toContain('rm -rf 금지');
  });
});

describe('isCodexRuntime', () => {
  it('FORGEN_RUNTIME=codex 일 때만 true', async () => {
    const { isCodexRuntime } = await load();
    expect(isCodexRuntime({})).toBe(false);
    expect(isCodexRuntime({ FORGEN_RUNTIME: 'claude' })).toBe(false);
    expect(isCodexRuntime({ FORGEN_RUNTIME: 'codex' })).toBe(true);
  });
});
