/**
 * Tests for failOpenWithTracking in hook-response.ts
 *
 * Uses vi.mock('node:os') to redirect homedir to a sandboxed TEST_HOME so
 * the tracking log never touches real ~/.forgen/state. Without this, every
 * `npm test` run pollutes the contributor's production hook-errors.jsonl
 * (149+ "test-hook"/"hook-with-special/chars"/"" entries were observed in
 * the field — see 2026-04-21 data audit).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/forgen-test-hook-response-${process.pid}`,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

const { failOpenWithTracking, approve, deny, ask, blockStop, approveWithContext } = await import(
  '../src/hooks/shared/hook-response.js'
);

describe('hook-response functions', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  it('failOpenWithTracking returns continue: true JSON', () => {
    const result = JSON.parse(failOpenWithTracking('test-hook'));
    expect(result.continue).toBe(true);
  });

  it('failOpenWithTracking does not throw even with invalid inputs', () => {
    expect(() => failOpenWithTracking('')).not.toThrow();
    expect(() => failOpenWithTracking('hook-with-special/chars')).not.toThrow();
  });

  it('failOpenWithTracking v0.4.1: captures error message + stack + code when provided', () => {
    const err = new Error('ENOENT: no such file or directory');
    (err as { code?: string }).code = 'ENOENT';
    failOpenWithTracking('error-capture-test', err);
    const sandboxLog = path.join(TEST_HOME, '.forgen', 'state', 'hook-errors.jsonl');
    const entry = JSON.parse(fs.readFileSync(sandboxLog, 'utf-8').trim());
    expect(entry.hook).toBe('error-capture-test');
    expect(entry.error).toContain('ENOENT');
    expect(entry.code).toBe('ENOENT');
    expect(typeof entry.stack).toBe('string');
  });

  it('failOpenWithTracking v0.4.1: accepts non-Error values (string thrown)', () => {
    failOpenWithTracking('string-throw', 'plain string error');
    const sandboxLog = path.join(TEST_HOME, '.forgen', 'state', 'hook-errors.jsonl');
    const entry = JSON.parse(fs.readFileSync(sandboxLog, 'utf-8').trim());
    expect(entry.error).toBe('plain string error');
  });

  it('failOpenWithTracking v0.4.1: caps error message at 400 chars', () => {
    const huge = 'A'.repeat(1000);
    failOpenWithTracking('huge-err', new Error(huge));
    const sandboxLog = path.join(TEST_HOME, '.forgen', 'state', 'hook-errors.jsonl');
    const entry = JSON.parse(fs.readFileSync(sandboxLog, 'utf-8').trim());
    expect(entry.error.length).toBe(400);
  });

  it('failOpenWithTracking writes tracking entries under the sandbox, never real $HOME', () => {
    failOpenWithTracking('sandboxed-hook');
    const sandboxLog = path.join(TEST_HOME, '.forgen', 'state', 'hook-errors.jsonl');
    expect(fs.existsSync(sandboxLog)).toBe(true);
    const lines = fs.readFileSync(sandboxLog, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.hook).toBe('sandboxed-hook');
    expect(typeof entry.at).toBe('number');

    // Belt-and-suspenders: the sandbox path must not equal the real home.
    expect(sandboxLog.startsWith('/tmp/')).toBe(true);
  });

  it('approve returns continue: true', () => {
    const result = JSON.parse(approve());
    expect(result.continue).toBe(true);
  });

  it('deny returns continue: true (session keeps going) with deny decision', () => {
    const result = JSON.parse(deny('test reason'));
    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toBe('test reason');
  });

  it('ask returns continue: true with ask decision', () => {
    const result = JSON.parse(ask('confirm reason'));
    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput.permissionDecision).toBe('ask');
  });

  describe('approveWithContext — H1 user notice', () => {
    it('returns additionalContext only when no userNotice', () => {
      const result = JSON.parse(approveWithContext('ctx text', 'UserPromptSubmit'));
      expect(result.continue).toBe(true);
      expect(result.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
      expect(result.hookSpecificOutput.additionalContext).toBe('ctx text');
      expect('systemMessage' in result).toBe(false);
    });

    it('H1: attaches systemMessage when userNotice provided (UI surfacing)', () => {
      const notice = '[Forgen] 🔎 3 solutions recalled: a, b, c';
      const result = JSON.parse(approveWithContext('ctx', 'UserPromptSubmit', notice));
      expect(result.systemMessage).toBe(notice);
      // additionalContext 여전히 모델에 도달해야 함
      expect(result.hookSpecificOutput.additionalContext).toBe('ctx');
    });
  });

  describe('blockStop (Stop hook only)', () => {
    it('returns continue: true with decision: block and reason verbatim', () => {
      const q = '직전 응답 전에 Docker e2e 증거가 있는가? 없다면 먼저 e2e를 돌리고 재응답하라.';
      const result = JSON.parse(blockStop(q));
      expect(result.continue).toBe(true);
      expect(result.decision).toBe('block');
      expect(result.reason).toBe(q);
    });

    it('attaches systemMessage only when provided (short rule tag)', () => {
      const withTag = JSON.parse(blockStop('q', 'rule:R-B1 — e2e-before-done'));
      expect(withTag.systemMessage).toBe('rule:R-B1 — e2e-before-done');

      const withoutTag = JSON.parse(blockStop('q'));
      expect('systemMessage' in withoutTag).toBe(false);
    });

    it('does not use hookSpecificOutput (Stop hook uses top-level decision/reason)', () => {
      const result = JSON.parse(blockStop('q'));
      expect('hookSpecificOutput' in result).toBe(false);
    });
  });
});
