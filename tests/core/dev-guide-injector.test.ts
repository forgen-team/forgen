import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  detectStack,
  readPrinciples,
  injectDevGuidePrinciples,
} from '../../src/core/dev-guide-injector.js';

// forgen repo root (실제 assets/dev-guide/* 사용)
const PKG_ROOT = path.resolve(process.cwd());

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-dev-guide-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── detectStack ───────────────────────────────────────────────────────────────

describe('detectStack', () => {
  it('package.json 에 react → fe/react', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { react: '^19.0.0' } }),
    );
    const result = detectStack(tmpDir);
    expect(result).toMatchObject({ side: 'fe', stack: 'react' });
    expect(result?.principlesFiles).toEqual(['common.md', 'react.md']);
  });

  it('package.json 에 next → fe/react', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { next: '^15.0.0' } }),
    );
    expect(detectStack(tmpDir)).toMatchObject({ side: 'fe', stack: 'react' });
  });

  it('package.json 에 vue → fe/vue', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { vue: '^3.0.0' } }),
    );
    expect(detectStack(tmpDir)).toMatchObject({ side: 'fe', stack: 'vue' });
  });

  it('package.json 에 nuxt → fe/vue', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ devDependencies: { nuxt: '^3.0.0' } }),
    );
    expect(detectStack(tmpDir)).toMatchObject({ side: 'fe', stack: 'vue' });
  });

  it('package.json 에 react/vue 없음 → be/node', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { express: '^4.0.0' } }),
    );
    expect(detectStack(tmpDir)).toMatchObject({ side: 'be', stack: 'node' });
  });

  it('go.mod 존재 → be/go', () => {
    fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/app\ngo 1.21\n');
    expect(detectStack(tmpDir)).toMatchObject({ side: 'be', stack: 'go' });
  });

  it('package.json 도 go.mod 도 없으면 null', () => {
    expect(detectStack(tmpDir)).toBeNull();
  });

  it('package.json 이 invalid JSON 이면 go.mod 로 fallback', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), 'NOT_JSON');
    fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/app\n');
    expect(detectStack(tmpDir)).toMatchObject({ side: 'be', stack: 'go' });
  });
});

// ── readPrinciples ────────────────────────────────────────────────────────────

describe('readPrinciples', () => {
  it('fe/react 원칙 파일 두 개를 합쳐 반환', () => {
    const content = readPrinciples(PKG_ROOT, 'fe', 'react');
    expect(content).toContain('<!-- forgen dev-guide principles');
    expect(content).toContain('# common (fe)');
    expect(content).toContain('# react');
    expect(content).toContain('---');
  });

  it('be/go 원칙 파일 두 개를 합쳐 반환', () => {
    const content = readPrinciples(PKG_ROOT, 'be', 'go');
    expect(content).toContain('# common (be)');
    expect(content).toContain('# go');
  });
});

// ── injectDevGuidePrinciples ──────────────────────────────────────────────────

describe('injectDevGuidePrinciples', () => {
  it('1. react → .claude/rules/dev-guide-principles.md + AGENTS.md 생성', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { react: '^19.0.0' } }),
    );

    const result = injectDevGuidePrinciples({ cwd: tmpDir, pkgRoot: PKG_ROOT });

    expect(result.stack).toMatchObject({ side: 'fe', stack: 'react' });
    expect(result.claudeRuleWritten).toBe(true);
    expect(result.agentsMdInjected).toBe(true);
    expect(fs.existsSync(result.claudeRulePath)).toBe(true);
    expect(fs.existsSync(result.agentsMdPath)).toBe(true);

    const claudeContent = fs.readFileSync(result.claudeRulePath, 'utf-8');
    expect(claudeContent).toContain('# react');

    const agentsContent = fs.readFileSync(result.agentsMdPath, 'utf-8');
    expect(agentsContent).toContain('<!-- >>> forgen-managed-rules -->');
    expect(agentsContent).toContain('<!-- <<< forgen-managed-rules -->');
  });

  it('2. vue → fe/vue inject', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { vue: '^3.0.0' } }),
    );

    const result = injectDevGuidePrinciples({ cwd: tmpDir, pkgRoot: PKG_ROOT });

    expect(result.stack).toMatchObject({ side: 'fe', stack: 'vue' });
    const claudeContent = fs.readFileSync(result.claudeRulePath, 'utf-8');
    expect(claudeContent).toContain('# vue');
  });

  it('3. react/vue 없음 → be/node inject', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { express: '^4.0.0' } }),
    );

    const result = injectDevGuidePrinciples({ cwd: tmpDir, pkgRoot: PKG_ROOT });

    expect(result.stack).toMatchObject({ side: 'be', stack: 'node' });
    const claudeContent = fs.readFileSync(result.claudeRulePath, 'utf-8');
    expect(claudeContent).toContain('# node');
  });

  it('4. go.mod 존재 → be/go inject', () => {
    fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/app\n');

    const result = injectDevGuidePrinciples({ cwd: tmpDir, pkgRoot: PKG_ROOT });

    expect(result.stack).toMatchObject({ side: 'be', stack: 'go' });
    const claudeContent = fs.readFileSync(result.claudeRulePath, 'utf-8');
    expect(claudeContent).toContain('# go');
  });

  it('5. 스택 미감지 → stack null, 파일 미생성', () => {
    const result = injectDevGuidePrinciples({ cwd: tmpDir, pkgRoot: PKG_ROOT });

    expect(result.stack).toBeNull();
    expect(result.claudeRuleWritten).toBe(false);
    expect(result.agentsMdInjected).toBe(false);
    expect(fs.existsSync(result.claudeRulePath)).toBe(false);
    expect(fs.existsSync(result.agentsMdPath)).toBe(false);
  });

  it('6. 재실행 idempotent — 두 번째 호출 시 written=false, 사용자 작성 부분 보존', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { react: '^19.0.0' } }),
    );

    const r1 = injectDevGuidePrinciples({ cwd: tmpDir, pkgRoot: PKG_ROOT });
    expect(r1.claudeRuleWritten).toBe(true);
    expect(r1.agentsMdInjected).toBe(true);

    // 사용자가 AGENTS.md 에 별도 내용 추가
    const agentsMdPath = path.join(tmpDir, 'AGENTS.md');
    const before = fs.readFileSync(agentsMdPath, 'utf-8');
    const userSection = '\n## My Custom Rules\n- always do X\n';
    fs.appendFileSync(agentsMdPath, userSection);

    const r2 = injectDevGuidePrinciples({ cwd: tmpDir, pkgRoot: PKG_ROOT });
    expect(r2.claudeRuleWritten).toBe(false); // 동일 내용
    expect(r2.agentsMdInjected).toBe(false);  // 동일 내용

    const after = fs.readFileSync(agentsMdPath, 'utf-8');
    expect(after).toContain('## My Custom Rules'); // 사용자 섹션 보존
    expect(after).toContain('<!-- >>> forgen-managed-rules -->');

    // 첫 inject 와 managed block 내용 동일
    const blockPattern = /<!-- >>> forgen-managed-rules -->[\s\S]*?<!-- <<< forgen-managed-rules -->/;
    const beforeBlock = before.match(blockPattern)?.[0];
    const afterBlock = after.match(blockPattern)?.[0];
    expect(beforeBlock).toBe(afterBlock);
  });

  it('7. AGENTS.md begin marker 만 있고 end 누락 시 self-heal', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { react: '^19.0.0' } }),
    );

    // 손상된 AGENTS.md (begin 만 있고 end 없음)
    const agentsMdPath = path.join(tmpDir, 'AGENTS.md');
    fs.writeFileSync(
      agentsMdPath,
      '# Agent Instructions\n\nSome user content.\n\n<!-- >>> forgen-managed-rules -->\nPartial content without end marker\n',
    );

    const result = injectDevGuidePrinciples({ cwd: tmpDir, pkgRoot: PKG_ROOT });

    expect(result.agentsMdInjected).toBe(true);
    const content = fs.readFileSync(agentsMdPath, 'utf-8');
    expect(content).toContain('<!-- >>> forgen-managed-rules -->');
    expect(content).toContain('<!-- <<< forgen-managed-rules -->');
    // begin/end 쌍이 정확히 한 개
    const beginCount = (content.match(/<!-- >>> forgen-managed-rules -->/g) ?? []).length;
    const endCount = (content.match(/<!-- <<< forgen-managed-rules -->/g) ?? []).length;
    expect(beginCount).toBe(1);
    expect(endCount).toBe(1);
  });

  it('8. dryRun: true — 파일 변경 0, 결과만 반환', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { react: '^19.0.0' } }),
    );

    const result = injectDevGuidePrinciples({ cwd: tmpDir, pkgRoot: PKG_ROOT, dryRun: true });

    expect(result.stack).toMatchObject({ side: 'fe', stack: 'react' });
    expect(result.claudeRuleWritten).toBe(true);  // would write
    expect(result.agentsMdInjected).toBe(true);   // would inject
    expect(result.bytesWritten).toBe(0);           // dry run → 0
    expect(fs.existsSync(result.claudeRulePath)).toBe(false);
    expect(fs.existsSync(result.agentsMdPath)).toBe(false);
  });
});
