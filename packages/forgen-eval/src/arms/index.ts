/**
 * Arm registry — 5종.
 * 실 통신 구현은 v0.5 통합 단계에서 채워짐. 현재는 contract + stub.
 */

import { execSync } from 'node:child_process';
import type { Arm, ArmContext } from './types.js';
import type { ArmResponse, TestCase } from '../types.js';

class StubArm implements Arm {
  constructor(public readonly id: Arm['id']) {}
  async beforeAll(_ctx: ArmContext): Promise<void> {}
  async runCase(c: TestCase, ctx: ArmContext): Promise<ArmResponse> {
    return {
      caseId: c.id,
      armId: ctx.armId,
      turnDepth: ctx.turnDepth,
      finalResponse: `[stub:${ctx.armId}] case=${c.id}`,
      blockEvents: [],
      injectEvents: [],
    };
  }
  async afterAll(_ctx: ArmContext): Promise<void> {}
}

class ClaudeMemOnlyArm extends StubArm {
  constructor() {
    super('claude-mem-only');
  }
  override async beforeAll(_ctx: ArmContext): Promise<void> {
    // Lifecycle managed by runners/worker-lifecycle.ts.
    // Here we only verify install presence.
    try {
      execSync('npx --no-install claude-mem version', { stdio: 'pipe' });
    } catch (err) {
      throw new Error(
        'claude-mem not installed. Run `npx claude-mem install --ide claude-code` first. ' +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}

class ForgenOnlyArm extends StubArm {
  constructor() {
    super('forgen-only');
  }
  override async beforeAll(_ctx: ArmContext): Promise<void> {
    // forgen-only arm: claude-mem plugin이 설치되어 있다면 *uninstall* 검증
    // (race condition 회피 — ADR-004 amendment 위험 항목)
    try {
      execSync('npx --no-install claude-mem version', { stdio: 'pipe' });
      // installed → must uninstall before forgen-only run
      throw new Error(
        'forgen-only arm requires claude-mem to be uninstalled. Run `npx claude-mem uninstall`.',
      );
    } catch {
      // not installed = good
    }
  }
}

class ForgenPlusMemArm extends StubArm {
  constructor() {
    super('forgen-plus-mem');
  }
}

class VanillaArm extends StubArm {
  constructor() {
    super('vanilla');
  }
}

class GstackArm extends StubArm {
  constructor() {
    super('gstack-only');
  }
}

export function buildArms(): Arm[] {
  return [
    new VanillaArm(),
    new ForgenOnlyArm(),
    new ClaudeMemOnlyArm(),
    new ForgenPlusMemArm(),
    new GstackArm(),
  ];
}

export type { Arm, ArmContext } from './types.js';
