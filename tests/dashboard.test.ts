import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: '/tmp/forgen-test-dashboard',
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TEST_HOME };
});

import {
  collectKnowledgeOverview,
  collectInjectionActivity,
  collectReflectionData,
  collectLifecycleActivity,
  collectSessionHistory,
  collectHookHealth,
  renderDashboard,
} from '../src/core/dashboard.js';

const ME_DIR = path.join(TEST_HOME, '.forgen', 'me');
const SOLUTIONS_DIR = path.join(ME_DIR, 'solutions');
const RULES_DIR = path.join(ME_DIR, 'rules');
const BEHAVIOR_DIR = path.join(ME_DIR, 'behavior');
const STATE_DIR = path.join(TEST_HOME, '.forgen', 'state');

function writeSolution(name: string, overrides?: {
  status?: string;
  confidence?: number;
  reflected?: number;
  sessions?: number;
  negative?: number;
  type?: string;
  created?: string;
  updated?: string;
}): void {
  const status = overrides?.status ?? 'candidate';
  const confidence = overrides?.confidence ?? 0.5;
  const reflected = overrides?.reflected ?? 0;
  const sessions = overrides?.sessions ?? 0;
  const negative = overrides?.negative ?? 0;
  const type = overrides?.type ?? 'pattern';
  const created = overrides?.created ?? '2026-01-15';
  const updated = overrides?.updated ?? '2026-03-01';

  fs.mkdirSync(SOLUTIONS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SOLUTIONS_DIR, `${name}.md`), `---
name: "${name}"
version: 1
status: "${status}"
confidence: ${confidence}
type: "${type}"
scope: "me"
tags: ["test", "typescript"]
identifiers: []
evidence:
  injected: 5
  reflected: ${reflected}
  negative: ${negative}
  sessions: ${sessions}
  reExtracted: 0
created: "${created}"
updated: "${updated}"
supersedes: null
extractedBy: "auto"
---

## Content
Test content for ${name}
`);
}

function writeRule(name: string): void {
  fs.mkdirSync(RULES_DIR, { recursive: true });
  fs.writeFileSync(path.join(RULES_DIR, `${name}.md`), `---
name: "${name}"
version: 1
status: "candidate"
confidence: 0.5
type: "decision"
scope: "me"
tags: ["rule"]
identifiers: []
evidence:
  injected: 0
  reflected: 0
  negative: 0
  sessions: 0
  reExtracted: 0
created: "2026-02-01"
updated: "2026-02-15"
supersedes: null
extractedBy: "manual"
---

## Content
Rule content
`);
}

describe('dashboard', () => {
  beforeEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    fs.mkdirSync(ME_DIR, { recursive: true });
    fs.mkdirSync(STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  });

  describe('collectKnowledgeOverview', () => {
    it('returns empty overview when no files exist', () => {
      const overview = collectKnowledgeOverview();
      expect(overview.solutions.total).toBe(0);
      expect(overview.rules.total).toBe(0);
      expect(overview.behavior.total).toBe(0);
      expect(overview.dateRange.oldest).toBeNull();
      expect(overview.dateRange.newest).toBeNull();
    });

    it('counts solutions by status correctly', () => {
      writeSolution('sol-exp', { status: 'experiment' });
      writeSolution('sol-cand', { status: 'candidate' });
      writeSolution('sol-ver', { status: 'verified' });
      writeSolution('sol-mat', { status: 'mature', confidence: 0.9 });

      const overview = collectKnowledgeOverview();
      expect(overview.solutions.total).toBe(4);
      expect(overview.solutions.byStatus.experiment).toBe(1);
      expect(overview.solutions.byStatus.candidate).toBe(1);
      expect(overview.solutions.byStatus.verified).toBe(1);
      expect(overview.solutions.byStatus.mature).toBe(1);
    });

    it('counts rules and computes date range', () => {
      writeSolution('sol-a', { created: '2026-01-01', updated: '2026-03-15' });
      writeRule('rule-a');

      const overview = collectKnowledgeOverview();
      expect(overview.solutions.total).toBe(1);
      expect(overview.rules.total).toBe(1);
      expect(overview.dateRange.oldest).toBe('2026-01-01');
      expect(overview.dateRange.newest).toBe('2026-03-15');
    });
  });

  describe('collectReflectionData', () => {
    it('returns zero rate when no solutions exist', () => {
      const data = collectReflectionData();
      expect(data.totalSolutions).toBe(0);
      expect(data.reflectionRate).toBe(0);
    });

    it('calculates reflection rate correctly', () => {
      writeSolution('reflected-a', { reflected: 3 });
      writeSolution('reflected-b', { reflected: 1 });
      writeSolution('unreflected-a', { reflected: 0 });

      const data = collectReflectionData();
      expect(data.reflectedCount).toBe(2);
      expect(data.unreflectedCount).toBe(1);
      // 2 reflected out of 3 active = 66.7%
      expect(data.reflectionRate).toBeCloseTo(66.67, 0);
    });

    it('excludes retired solutions from rate calculation', () => {
      writeSolution('active', { reflected: 1 });
      writeSolution('retired', { status: 'retired', reflected: 0, confidence: 0 });

      const data = collectReflectionData();
      // Only 1 active solution, 1 reflected → 100%
      expect(data.reflectionRate).toBeCloseTo(100, 0);
    });
  });

  describe('collectLifecycleActivity', () => {
    it('returns empty when no solutions exist', () => {
      const data = collectLifecycleActivity();
      expect(data.recentPromotionCandidates).toHaveLength(0);
    });

    it('identifies promotion candidates sorted by reflection count', () => {
      writeSolution('high-ref', { status: 'candidate', reflected: 5, sessions: 3 });
      writeSolution('low-ref', { status: 'experiment', reflected: 1, sessions: 1 });

      const data = collectLifecycleActivity();
      expect(data.recentPromotionCandidates.length).toBeGreaterThan(0);
      expect(data.recentPromotionCandidates[0].name).toBe('high-ref');
    });
  });

  describe('collectSessionHistory', () => {
    it('returns null when no extraction history exists', () => {
      const data = collectSessionHistory();
      expect(data.lastExtraction).toBeNull();
    });

    it('reads last extraction state', () => {
      fs.writeFileSync(
        path.join(STATE_DIR, 'last-extraction.json'),
        JSON.stringify({
          lastCommitSha: 'abc1234',
          lastExtractedAt: '2026-04-10T12:00:00Z',
          extractionsToday: 3,
          todayDate: '2026-04-10',
        }),
      );

      const data = collectSessionHistory();
      expect(data.lastExtraction).not.toBeNull();
      expect(data.lastExtraction!.extractionsToday).toBe(3);
    });
  });

  describe('collectHookHealth', () => {
    it('returns empty when no errors exist', () => {
      const data = collectHookHealth();
      expect(data.errors).toHaveLength(0);
    });

    it('reads hook error counts', () => {
      fs.writeFileSync(
        path.join(STATE_DIR, 'hook-errors.json'),
        JSON.stringify({
          'solution-injector': { count: 3, lastAt: '2026-04-10T10:00:00Z' },
          'context-guard': { count: 1, lastAt: '2026-04-09T14:00:00Z' },
        }),
      );

      const data = collectHookHealth();
      expect(data.errors).toHaveLength(2);
      const injErr = data.errors.find(e => e.hookName === 'solution-injector');
      expect(injErr?.count).toBe(3);
    });
  });

  describe('collectInjectionActivity', () => {
    it('returns empty when no log exists', () => {
      const data = collectInjectionActivity();
      expect(data.totalRecords).toBe(0);
      expect(data.recentInjections).toHaveLength(0);
      expect(data.topSolutions).toHaveLength(0);
    });
  });

  describe('renderDashboard', () => {
    it('produces output without crashing on empty data', () => {
      const output = renderDashboard();
      expect(output).toContain('Compound Dashboard');
      expect(output).toContain('Knowledge Overview');
      expect(output).toContain('Injection Activity');
      expect(output).toContain('Hook Health');
    });

    it('produces output with populated data', () => {
      writeSolution('sol-a', { status: 'verified', reflected: 3, sessions: 2 });
      writeSolution('sol-b', { status: 'candidate', reflected: 0, sessions: 1 });
      writeRule('rule-a');

      const output = renderDashboard();
      expect(output).toContain('Knowledge Overview');
      expect(output).toContain('Code Reflection');
      expect(output).toContain('Lifecycle Activity');
    });
  });
});
