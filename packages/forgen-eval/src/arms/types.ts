/**
 * Arm execution contract — each arm executes a TestCase and returns ArmResponse.
 * forgen-only / forgen-plus-mem 은 forgen 본체와 통신 (peerDep).
 * claude-mem-only / forgen-plus-mem 은 child_process로 `npx claude-mem` invoke.
 */

import type { ArmId, ArmResponse, TestCase, TurnDepth } from '../types.js';

export interface ArmContext {
  armId: ArmId;
  /** Working dir for this arm — claude-mem worker DB lives here. */
  workdir: string;
  turnDepth: TurnDepth;
}

export interface Arm {
  id: ArmId;
  /** Setup before any cases run. e.g. install/uninstall claude-mem plugin. */
  beforeAll(ctx: ArmContext): Promise<void>;
  /** Per-case execution — runs the correction sequence + final trigger. */
  runCase(c: TestCase, ctx: ArmContext): Promise<ArmResponse>;
  /** Teardown — stop workers, clean state. */
  afterAll(ctx: ArmContext): Promise<void>;
}
