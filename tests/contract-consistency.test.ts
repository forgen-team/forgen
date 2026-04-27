import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { KEYWORD_PATTERNS } from '../src/hooks/keyword-detector.js';

const ROOT = path.resolve(__dirname, '..');

function read(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf-8');
}

function extractCliCommands(): string[] {
  const source = read('src/cli.ts');
  return [...source.matchAll(/name:\s*'([^']+)'/g)]
    .map((match) => match[1])
    .filter((name) => name !== 'string')
    .slice(0, 11);
}

function extractSlashSkills(): string[] {
  const commandsDir = path.join(ROOT, 'assets', 'claude', 'commands');
  return fs.readdirSync(commandsDir)
    .filter((file) => file.endsWith('.md'))
    .map((file) => read(path.join('assets', 'claude', 'commands', file)).match(/^name:\s*([^\n]+)$/m)?.[1]?.trim())
    .filter((name): name is string => Boolean(name));
}

describe('contract consistency', () => {
  it('CLI and slash skill name overlap stays explicit and reviewed', () => {
    const cliCommands = extractCliCommands();
    const slashSkills = extractSlashSkills();
    const overlap = cliCommands.filter((name) => slashSkills.includes(name));
    // `compound`: CLI previews / --save commits; skill triggers session
    // pattern extraction. Both in the "accumulate knowledge" family.
    // `learn`: CLI does solution-index maintenance (fix-up / quarantine /
    // fitness); skill manages compound knowledge (search / stats / prune /
    // export / import). Both in the "manage learned knowledge" family.
    expect(overlap).toEqual(['compound', 'learn']);
  });

  it('compound skill documents that CLI behavior is preview-first', () => {
    const content = read(path.join('assets', 'claude', 'commands', 'compound.md'));
    expect(content).toContain('CLI `forgen compound`');
    expect(content).toContain('`--save`');
  });

  it('shared keyword names route through actual skills instead of ad-hoc inject messages', () => {
    const routedAsSkills = new Map(
      KEYWORD_PATTERNS
        .filter((entry) => entry.type === 'skill' && entry.skill)
        .map((entry) => [entry.keyword, entry.skill]),
    );

    // 유지된 스킬
    expect(routedAsSkills.get('code-review')).toBe('code-review');
    expect(routedAsSkills.get('deep-interview')).toBe('deep-interview');

    // 신규 스킬
    expect(routedAsSkills.get('forge-loop')).toBe('forge-loop');
    expect(routedAsSkills.get('ship')).toBe('ship');
    expect(routedAsSkills.get('retro')).toBe('retro');
    expect(routedAsSkills.get('learn')).toBe('learn');
    expect(routedAsSkills.get('calibrate')).toBe('calibrate');

    // 삭제된 스킬은 더 이상 존재하지 않음
    expect(routedAsSkills.has('tdd')).toBe(false);
    expect(routedAsSkills.has('refactor')).toBe(false);
    expect(routedAsSkills.has('ecomode')).toBe(false);
    expect(routedAsSkills.has('git-master')).toBe(false);
  });

  it('compound preview/save flow is documented in the primary entry docs', () => {
    for (const relPath of ['README.md', 'README.ko.md']) {
      expect(read(relPath)).toContain('forgen compound --save');
    }
  });

  it('primary docs do not advertise stale hook or pattern counts', () => {
    for (const relPath of ['README.md', 'README.ko.md']) {
      const content = read(relPath);
      expect(content).not.toContain('16 hooks');
      expect(content).not.toContain('16개 훅');
      expect(content).not.toContain('35 patterns');
      expect(content).not.toContain('35개 감지 패턴');
    }
  });

  it('CLI help text reflects compound management', () => {
    const cliSource = read('src/cli.ts');
    expect(cliSource).toContain('Manage accumulated knowledge');
  });

  it('compound command help keeps entry-management wording aligned with rules support', () => {
    const source = read('src/engine/compound-loop.ts');
    expect(source).toContain('List saved entries (solutions and rules)');
    expect(source).toContain('Remove a saved entry');
    expect(source).toContain('Rollback unused auto-extracted solutions since date');
  });
});
