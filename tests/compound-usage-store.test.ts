/**
 * Pathfinder D11 — compound usage signal collection.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { recordUsage, readUsageCounts, COMPOUND_USAGE_LOG } from '../src/store/compound-usage-store.js';

describe('compound-usage-store — D11', () => {
  beforeEach(() => {
    // 깨끗한 상태로 시작
    if (fs.existsSync(COMPOUND_USAGE_LOG)) {
      fs.unlinkSync(COMPOUND_USAGE_LOG);
    }
  });

  it('recordUsage appends a JSON line with at/name/via', () => {
    recordUsage('starter-tdd-red-green-refactor', 'mcp');
    const lines = fs.readFileSync(COMPOUND_USAGE_LOG, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.name).toBe('starter-tdd-red-green-refactor');
    expect(entry.via).toBe('mcp');
    expect(typeof entry.at).toBe('string');
    expect(new Date(entry.at).toString()).not.toBe('Invalid Date');
  });

  it('multiple recordUsage calls append independently', () => {
    recordUsage('a');
    recordUsage('a');
    recordUsage('b');
    const counts = readUsageCounts();
    expect(counts.get('a')).toBe(2);
    expect(counts.get('b')).toBe(1);
  });

  it('readUsageCounts returns empty map when log missing', () => {
    expect(readUsageCounts().size).toBe(0);
  });

  it('readUsageCounts skips malformed lines', () => {
    fs.appendFileSync(COMPOUND_USAGE_LOG, 'not-json\n');
    fs.appendFileSync(COMPOUND_USAGE_LOG, JSON.stringify({ at: '2026-04-30', name: 'good' }) + '\n');
    const counts = readUsageCounts();
    expect(counts.get('good')).toBe(1);
    expect(counts.size).toBe(1);
  });

  it('empty name is ignored (fail-open)', () => {
    recordUsage('');
    expect(fs.existsSync(COMPOUND_USAGE_LOG)).toBe(false);
  });

  it('default via is mcp', () => {
    recordUsage('x');
    const lines = fs.readFileSync(COMPOUND_USAGE_LOG, 'utf-8').trim().split('\n');
    expect(JSON.parse(lines[0]).via).toBe('mcp');
  });
});
