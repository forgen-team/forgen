/**
 * Real arms — multi-turn simulation using Driver LLM + forgen hook bridge.
 *
 * Each arm is a function (TestCase, ArmContext) → ArmResponse.
 * Differs ONLY in what hooks fire between turns:
 *   vanilla         — no hooks (baseline)
 *   forgen-only     — UserPromptSubmit (rule inject) + Stop (block check) on each turn
 *   claude-mem-only — npx claude-mem search (recall inject) on each turn (no block)
 *   forgen-plus-mem — both
 *   gstack-only     — placeholder (different category — needs separate sim)
 */

import type { Arm, ArmContext } from './types.js';
import type { ArmResponse, BlockEvent, InjectEvent, TestCase } from '../types.js';
import { OllamaDriverLLM, type ChatTurn } from './driver-llm.js';
import {
  userPromptSubmitHook,
  stopGuardHook,
  newSessionId,
} from './forgen-bridge.js';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Materialize correctionSequence as a notepad.md so notepad-injector has rules to inject.
 *  Without this, forgen treats every case as a fresh session with no learned rules.
 *  Returns the temp project root (caller is responsible for cleanup).
 */
function seedForgenNotepad(c: TestCase): string {
  const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-eval-arm-'));
  const compoundDir = path.join(tempCwd, '.compound');
  fs.mkdirSync(compoundDir, { recursive: true });
  const lines = [
    '# Active Rules (forgen learned from prior corrections)',
    '',
    ...c.correctionSequence.map((t) => {
      const ruleId = t.expectedRule ?? 'rule';
      return `- [${ruleId}] ${t.userMsg}`;
    }),
    '',
  ];
  fs.writeFileSync(path.join(compoundDir, 'notepad.md'), lines.join('\n'), 'utf-8');
  return tempCwd;
}

const DRIVER = new OllamaDriverLLM();

/** Build the driver LLM's system prompt. */
function baseSystem(persona: string | undefined): string {
  return [
    'You are a coding assistant. Your responses should be concise and adapt to the user\'s preferences as conversation progresses.',
    persona ? `User persona: ${persona}` : '',
    'Respond helpfully but stay aware of any rules or context provided.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Vanilla arm — no forgen, no claude-mem, no rule learning. */
export class VanillaArm implements Arm {
  readonly id: Arm['id'] = 'vanilla';
  async beforeAll(_: ArmContext) {}
  async afterAll(_: ArmContext) {}

  async runCase(c: TestCase, ctx: ArmContext): Promise<ArmResponse> {
    const history: ChatTurn[] = [{ role: 'system', content: baseSystem(c.personaId) }];
    for (const turn of c.correctionSequence.slice(0, ctx.turnDepth)) {
      history.push({ role: 'user', content: turn.userMsg });
      const response = await DRIVER.chat(history);
      history.push({ role: 'assistant', content: response });
    }
    history.push({ role: 'user', content: c.trigger.prompt });
    const finalResponse = await DRIVER.chat(history);

    return {
      caseId: c.id,
      armId: 'vanilla',
      turnDepth: ctx.turnDepth,
      finalResponse,
      blockEvents: [],
      injectEvents: [],
    };
  }
}

/** Forgen-only arm — UserPromptSubmit injects rules, Stop hook may block, corrections recorded. */
export class ForgenOnlyArm implements Arm {
  readonly id: Arm['id'] = 'forgen-only';
  async beforeAll(_: ArmContext) {}
  async afterAll(_: ArmContext) {}

  async runCase(c: TestCase, ctx: ArmContext): Promise<ArmResponse> {
    const sessionId = newSessionId();
    const armCwd = seedForgenNotepad(c);
    const history: ChatTurn[] = [{ role: 'system', content: baseSystem(c.personaId) }];
    const blockEvents: BlockEvent[] = [];
    const injectEvents: InjectEvent[] = [];

    try {
    for (const turn of c.correctionSequence.slice(0, ctx.turnDepth)) {
      // 1. UserPromptSubmit hook — forgen may inject rules into context
      try {
        const ups = await userPromptSubmitHook({
          prompt: turn.userMsg,
          session_id: sessionId,
          cwd: armCwd,
        });
        const upsCtx = ups.hookSpecificOutput?.additionalContext;
        if (upsCtx && upsCtx.length > 0) {
          injectEvents.push({
            ruleId: 'forgen-rule-inject',
            injectedText: upsCtx.slice(0, 500),
            ts: new Date().toISOString(),
          });
          history.push({ role: 'system', content: `[forgen rules]\n${upsCtx}` });
        }
      } catch (e) {
        // Hook failure — treat as no-op for this turn (don't fail whole arm)
      }

      history.push({ role: 'user', content: turn.userMsg });
      let response = await DRIVER.chat(history);

      // 2. Stop hook — forgen may block the response
      try {
        const stop = await stopGuardHook({
          transcript_path: '/dev/null',
          stop_hook_active: false,
          session_id: sessionId,
          response,
        });
        if (stop.decision === 'block' && stop.reason) {
          blockEvents.push({
            ruleId: 'forgen-stop-block',
            reason: stop.reason.slice(0, 500),
            ts: new Date().toISOString(),
          });
          // Driver retries with block reason injected
          history.push({
            role: 'system',
            content: `[Previous response was blocked by forgen: ${stop.reason}]\nProduce a corrected response.`,
          });
          response = await DRIVER.chat(history);
        }
      } catch (e) {
        // Hook failure — treat as no block
      }

      history.push({ role: 'assistant', content: response });
    }

    // Trigger phase — must run the same forgen hook pipeline to actually test
    // the learned rule's effect. Without this the trigger response bypasses
    // forgen entirely and forgenOnly degenerates to vanilla.
    try {
      const upsT = await userPromptSubmitHook({
        prompt: c.trigger.prompt,
        session_id: sessionId,
        cwd: armCwd,
      });
      const upsTCtx = upsT.hookSpecificOutput?.additionalContext;
      if (upsTCtx && upsTCtx.length > 0) {
        injectEvents.push({
          ruleId: 'forgen-rule-inject',
          injectedText: upsTCtx.slice(0, 500),
          ts: new Date().toISOString(),
        });
        history.push({ role: 'system', content: `[forgen rules]\n${upsTCtx}` });
      }
    } catch {
      // no-op
    }

    history.push({ role: 'user', content: c.trigger.prompt });
    let finalResponse = await DRIVER.chat(history);

    try {
      const stopT = await stopGuardHook({
        transcript_path: '/dev/null',
        stop_hook_active: false,
        session_id: sessionId,
        response: finalResponse,
      });
      if (stopT.decision === 'block' && stopT.reason) {
        blockEvents.push({
          ruleId: 'forgen-stop-block',
          reason: stopT.reason.slice(0, 500),
          ts: new Date().toISOString(),
        });
        history.push({
          role: 'system',
          content: `[Previous response was blocked by forgen: ${stopT.reason}]\nProduce a corrected response.`,
        });
        finalResponse = await DRIVER.chat(history);
      }
    } catch {
      // no-op
    }

    return {
      caseId: c.id,
      armId: 'forgen-only',
      turnDepth: ctx.turnDepth,
      finalResponse,
      blockEvents,
      injectEvents,
    };
    } finally {
      try { fs.rmSync(armCwd, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

/** Claude-mem-only arm — search recall inject, no block enforcement. */
export class ClaudeMemOnlyArm implements Arm {
  readonly id: Arm['id'] = 'claude-mem-only';
  async beforeAll(_: ArmContext) {}
  async afterAll(_: ArmContext) {}

  async runCase(c: TestCase, ctx: ArmContext): Promise<ArmResponse> {
    const history: ChatTurn[] = [{ role: 'system', content: baseSystem(c.personaId) }];
    const injectEvents: InjectEvent[] = [];

    for (const turn of c.correctionSequence.slice(0, ctx.turnDepth)) {
      // claude-mem CLI search invocation — recall related observations
      try {
        const recall = execSync(
          `npx --no-install claude-mem search ${JSON.stringify(turn.userMsg.slice(0, 80))} 2>/dev/null`,
          { encoding: 'utf-8', timeout: 5000 },
        ).trim();
        if (recall && recall.length > 0) {
          injectEvents.push({
            ruleId: 'claude-mem-recall',
            injectedText: recall.slice(0, 500),
            ts: new Date().toISOString(),
          });
          history.push({ role: 'system', content: `[claude-mem recall]\n${recall.slice(0, 500)}` });
        }
      } catch {
        // claude-mem may have no observations or be uninstalled — no-op
      }

      history.push({ role: 'user', content: turn.userMsg });
      const response = await DRIVER.chat(history);
      history.push({ role: 'assistant', content: response });
    }

    history.push({ role: 'user', content: c.trigger.prompt });
    const finalResponse = await DRIVER.chat(history);

    return {
      caseId: c.id,
      armId: 'claude-mem-only',
      turnDepth: ctx.turnDepth,
      finalResponse,
      blockEvents: [],
      injectEvents,
    };
  }
}

/**
 * Combined: forgen + claude-mem coexistence (single-session bridge).
 *
 * 2026-05-08 fix (testbed structural bug): 이전 구현은 super.runCase (forgen-only LLM
 *   세션) 와 ClaudeMemOnlyArm.runCase (mem-only LLM 세션) 를 *각각 별도로* 돌리고
 *   forgen 응답만 채택했다. Driver 가 temperature=0.3 비결정 호출이라 두 forgen
 *   세션이 동일 분포에서 다른 샘플을 뽑았고, full.W − forgenOnly.W 가 LLM noise
 *   로 양/음 ±0.3 까지 흔들렸다. 즉 ψ 가 forgen+mem coexistence 신호 대신 LLM
 *   분산을 측정.
 *
 * 본 구현은 *한 LLM 세션* 안에서 forgen UPS rule inject 와 claude-mem search
 *   recall 을 둘 다 system message 로 주입한 뒤 한 번 chat → Stop guard 평가.
 *   coexistence 의 실제 cross-talk 효과 (양쪽이 같이 들어왔을 때 응답이 어떻게
 *   바뀌는가) 를 측정 가능.
 */
export class ForgenPlusMemArm implements Arm {
  readonly id: Arm['id'] = 'forgen-plus-mem';
  async beforeAll(_: ArmContext) {}
  async afterAll(_: ArmContext) {}

  async runCase(c: TestCase, ctx: ArmContext): Promise<ArmResponse> {
    const sessionId = newSessionId();
    const armCwd = seedForgenNotepad(c);
    const history: ChatTurn[] = [{ role: 'system', content: baseSystem(c.personaId) }];
    const blockEvents: BlockEvent[] = [];
    const injectEvents: InjectEvent[] = [];

    /** UPS (forgen rules) + mem search (claude-mem recall) both injected for one user msg. */
    const injectBoth = async (userMsg: string) => {
      // 1. forgen UPS hook — rule injection (notepad/solutions context-aware)
      try {
        const ups = await userPromptSubmitHook({
          prompt: userMsg,
          session_id: sessionId,
          cwd: armCwd,
        });
        const upsCtx = ups.hookSpecificOutput?.additionalContext;
        if (upsCtx && upsCtx.length > 0) {
          injectEvents.push({
            ruleId: 'forgen-rule-inject',
            injectedText: upsCtx.slice(0, 500),
            ts: new Date().toISOString(),
          });
          history.push({ role: 'system', content: `[forgen rules]\n${upsCtx}` });
        }
      } catch {
        /* hook failure ≠ arm failure */
      }

      // 2. claude-mem search recall — past observation injection
      try {
        const recall = execSync(
          `npx --no-install claude-mem search ${JSON.stringify(userMsg.slice(0, 80))} 2>/dev/null`,
          { encoding: 'utf-8', timeout: 5000 },
        ).trim();
        if (recall && recall.length > 0) {
          injectEvents.push({
            ruleId: 'mem:claude-mem-recall',
            injectedText: recall.slice(0, 500),
            ts: new Date().toISOString(),
          });
          history.push({ role: 'system', content: `[claude-mem recall]\n${recall.slice(0, 500)}` });
        }
      } catch {
        /* mem may have no observations or be uninstalled */
      }
    };

    /** Stop guard — if blocked, retry once with block reason. */
    const stopMaybeBlock = async (response: string): Promise<string> => {
      try {
        const stop = await stopGuardHook({
          transcript_path: '/dev/null',
          stop_hook_active: false,
          session_id: sessionId,
          response,
        });
        if (stop.decision === 'block' && stop.reason) {
          blockEvents.push({
            ruleId: 'forgen-stop-block',
            reason: stop.reason.slice(0, 500),
            ts: new Date().toISOString(),
          });
          history.push({
            role: 'system',
            content: `[Previous response was blocked by forgen: ${stop.reason}]\nProduce a corrected response.`,
          });
          return await DRIVER.chat(history);
        }
      } catch {
        /* hook failure → no block */
      }
      return response;
    };

    try {
      for (const turn of c.correctionSequence.slice(0, ctx.turnDepth)) {
        await injectBoth(turn.userMsg);
        history.push({ role: 'user', content: turn.userMsg });
        const raw = await DRIVER.chat(history);
        const response = await stopMaybeBlock(raw);
        history.push({ role: 'assistant', content: response });
      }

      await injectBoth(c.trigger.prompt);
      history.push({ role: 'user', content: c.trigger.prompt });
      const rawTrigger = await DRIVER.chat(history);
      const finalResponse = await stopMaybeBlock(rawTrigger);

      return {
        caseId: c.id,
        armId: 'forgen-plus-mem',
        turnDepth: ctx.turnDepth,
        finalResponse,
        blockEvents,
        injectEvents,
      };
    } finally {
      try { fs.rmSync(armCwd, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

export class GstackArm extends VanillaArm {
  override readonly id: Arm['id'] = 'gstack-only';
  // Gstack is a different category (workflow tools) — for now treated as vanilla
  // until separate gstack simulation is built.
}

export function buildRealArms(): Arm[] {
  return [
    new VanillaArm(),
    new ForgenOnlyArm(),
    new ClaudeMemOnlyArm(),
    new ForgenPlusMemArm(),
    new GstackArm(),
  ];
}
