/**
 * 0.5.4 — forgen 훅 출력(사영 후)이 Codex 0.153.4 의 이벤트별 hook 출력 스키마를 통과하는지.
 *
 * 스키마 사본: tests/fixtures/codex-hook-schemas/*.command.output.schema.json
 * (openai/codex rust-v0.153.4, codex-rs/hooks/schema/generated). Codex 는 `additionalProperties:false`
 * 라서 허용되지 않은 키가 하나라도 있으면 출력 전체를 버리고 Failed 로 표시한다 — 0.5.3 에서 Stop 훅
 * 2개가 실환경에서 매 턴 Failed 였던 원인. 이 테스트가 그 회귀를 막는다.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectCodexToClaude } from '../../src/host/projection.js';
import { approve, approveWithContext, approveWithWarning, ask, blockStop, deny } from '../../src/hooks/shared/hook-response.js';

type Schema = Record<string, unknown>;
const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'codex-hook-schemas');

function loadSchema(event: string): Schema {
  const file = `${event.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}.command.output.schema.json`;
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf-8')) as Schema;
}

/** 최소 JSON-Schema 검증기: properties / additionalProperties / required / type / enum / const / allOf / $ref / default:null. */
function validate(root: Schema, schema: Schema, value: unknown, where: string): string[] {
  const errors: string[] = [];
  const resolve = (s: Schema): Schema => {
    if (typeof s.$ref === 'string') {
      const name = s.$ref.split('/').pop() as string;
      const defs = (root.definitions ?? root.$defs ?? {}) as Record<string, Schema>;
      return resolve(defs[name] ?? {});
    }
    if (Array.isArray(s.allOf)) {
      return (s.allOf as Schema[]).reduce<Schema>((acc, part) => ({ ...acc, ...resolve(part) }), { ...s, allOf: undefined });
    }
    return s;
  };
  const s = resolve(schema);
  if (value === null || value === undefined) {
    if (s.default === null || s.type === 'null') return errors;
  }
  if (s.const !== undefined && value !== s.const) errors.push(`${where}: expected const ${JSON.stringify(s.const)}, got ${JSON.stringify(value)}`);
  if (Array.isArray(s.enum) && !(s.enum as unknown[]).includes(value)) errors.push(`${where}: ${JSON.stringify(value)} not in enum ${JSON.stringify(s.enum)}`);
  const types = Array.isArray(s.type) ? (s.type as string[]) : typeof s.type === 'string' ? [s.type] : [];
  if (types.length > 0) {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const ok = types.some((t) => (t === 'integer' ? actual === 'number' : t === actual));
    if (!ok) errors.push(`${where}: type ${actual} not in ${types.join('|')}`);
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && (s.properties || s.additionalProperties === false)) {
    const props = (s.properties ?? {}) as Record<string, Schema>;
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (!(key in props) && s.additionalProperties === false) errors.push(`${where}.${key}: not allowed`);
      else if (key in props) errors.push(...validate(root, props[key], (value as Record<string, unknown>)[key], `${where}.${key}`));
    }
    for (const req of (s.required ?? []) as string[]) {
      if (!(req in (value as Record<string, unknown>))) errors.push(`${where}.${req}: required`);
    }
  }
  return errors;
}

function assertValid(event: string, rawOutput: string): void {
  const projected = projectCodexToClaude(JSON.parse(rawOutput), { hook_event_name: event } as never);
  const errors = validate(loadSchema(event), loadSchema(event), projected, event);
  expect(errors, `${event} ← ${rawOutput}\n→ ${JSON.stringify(projected)}`).toEqual([]);
}

describe('Codex 0.153.4 hook output schema conformance (사영 후)', () => {
  const ALL_EVENTS = ['SessionStart', 'SubagentStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'SubagentStop', 'PreCompact', 'PostCompact', 'Interrupt'];

  it('approve() 는 모든 이벤트에서 유효', () => {
    for (const ev of ALL_EVENTS) assertValid(ev, approve());
  });

  it('approveWithWarning() (systemMessage + suppressOutput:false) 는 모든 이벤트에서 유효', () => {
    for (const ev of ALL_EVENTS) assertValid(ev, approveWithWarning('<compound-warning/>'));
  });

  it('approveWithContext() 는 SessionStart / UserPromptSubmit / SubagentStart 에서 유효하고, Stop/PreCompact 에서도 깎여서 유효', () => {
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'PreToolUse', 'PostToolUse']) {
      assertValid(ev, approveWithContext('<forgen-rules host="codex">…</forgen-rules>', ev));
    }
    for (const ev of ['Stop', 'SubagentStop', 'PreCompact', 'PostCompact']) {
      assertValid(ev, approveWithContext('ctx', ev));
    }
  });

  it('blockStop() 은 Stop / SubagentStop 에서 유효하고 decision/reason 이 살아 있다', () => {
    for (const ev of ['Stop', 'SubagentStop']) {
      assertValid(ev, blockStop('[forgen:stop-guard] tests not run', '[tag]'));
      const projected = projectCodexToClaude(JSON.parse(blockStop('r', 's')), { hook_event_name: ev } as never);
      expect(projected.decision).toBe('block');
      expect(projected.reason).toBe('r');
    }
  });

  it('deny() / ask() 는 PreToolUse 에서 유효 (continue:false 제거)', () => {
    assertValid('PreToolUse', deny('rm -rf blocked'));
    assertValid('PreToolUse', ask('confirm'));
    const projected = projectCodexToClaude(JSON.parse(deny('x')), { hook_event_name: 'PreToolUse' } as never);
    expect(projected.continue).toBe(true);
    expect(projected.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('deny() 가 PostToolUse 에 쓰이면 PostToolUse block 형으로 번역되어 유효', () => {
    assertValid('PostToolUse', deny('secret leaked'));
  });

  it('검증기 자체 점검: Stop 에 hookSpecificOutput 이 있으면 스키마 위반으로 잡힌다 (0.5.3 회귀 형태)', () => {
    const bad = { continue: true, hookSpecificOutput: { hookEventName: 'Stop' } };
    const errors = validate(loadSchema('Stop'), loadSchema('Stop'), bad, 'Stop');
    expect(errors.length).toBeGreaterThan(0);
  });
});
