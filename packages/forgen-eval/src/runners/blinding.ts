/**
 * Arm blinding — judge에게 arm 라벨 누설 방지 (Round 11 [HIGH] fix).
 * 결과 집계 시점에서만 unblind.
 */

import type { ArmId, ArmResponse, JudgeScore } from '../types.js';
import { randomBytes } from 'node:crypto';

export interface BlindingMap {
  /** blindedId -> real ArmId. Never expose to judges. */
  reverse: Map<string, ArmId>;
  /** ArmId -> blindedId for current run. */
  forward: Map<ArmId, string>;
}

export function makeBlindingMap(): BlindingMap {
  const arms: ArmId[] = ['vanilla', 'forgen-only', 'claude-mem-only', 'forgen-plus-mem', 'gstack-only'];
  const reverse = new Map<string, ArmId>();
  const forward = new Map<ArmId, string>();
  for (const arm of arms) {
    const blinded = `arm-${randomBytes(8).toString('hex')}`;
    reverse.set(blinded, arm);
    forward.set(arm, blinded);
  }
  return { reverse, forward };
}

export function blindResponses(responses: ArmResponse[], map: BlindingMap): ArmResponse[] {
  return responses.map((r) => {
    const blinded = map.forward.get(r.armId);
    if (!blinded) throw new Error(`Unmapped arm: ${r.armId}`);
    return { ...r, armId: blinded as ArmId };
  });
}

export function unblindScores(scores: JudgeScore[], map: BlindingMap): JudgeScore[] {
  return scores.map((s) => {
    const real = map.reverse.get(s.blindedArmId);
    if (!real) throw new Error(`Unknown blinded id: ${s.blindedArmId}`);
    return { ...s, blindedArmId: real };
  });
}
