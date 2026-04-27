/**
 * Codex JSONL parser — feat/codex-support P2-1 단위 테스트
 *
 * 실측 출력 형식 기반 corpus + edge case (parse failure / 빈 stdout / 다중 segment).
 */

import { describe, expect, it } from 'vitest';
import { parseCodexJsonlOutput } from '../../src/host/codex-output-parser.js';

const REAL_PROBE_OUTPUT = `Reading additional input from stdin...
{"type":"thread.started","thread_id":"019dcf0d-ae7e-7d61-8e9d-2743f14873a9"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"pong"}}
{"type":"turn.completed","usage":{"input_tokens":15069,"cached_input_tokens":6528,"output_tokens":78,"reasoning_output_tokens":71}}`;

describe('parseCodexJsonlOutput', () => {
  it('실 codex exec --json probe 출력 parse — agent message + usage + thread_id', () => {
    const r = parseCodexJsonlOutput(REAL_PROBE_OUTPUT);
    expect(r.message).toBe('pong');
    expect(r.segments).toEqual(['pong']);
    expect(r.threadId).toBe('019dcf0d-ae7e-7d61-8e9d-2743f14873a9');
    expect(r.usage).toEqual({
      input_tokens: 15069,
      cached_input_tokens: 6528,
      output_tokens: 78,
      reasoning_output_tokens: 71,
    });
    expect(r.parseFailures).toBe(0);
  });

  it('빈 stdout → message 빈 문자열, segments 빈 배열', () => {
    const r = parseCodexJsonlOutput('');
    expect(r.message).toBe('');
    expect(r.segments).toEqual([]);
    expect(r.usage).toBeNull();
    expect(r.threadId).toBeNull();
    expect(r.parseFailures).toBe(0);
  });

  it('다중 agent_message segment 가 \\n 으로 join', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"second"}}',
      '{"type":"turn.completed","usage":{"input_tokens":1}}',
    ].join('\n');
    const r = parseCodexJsonlOutput(stdout);
    expect(r.segments).toEqual(['first', 'second']);
    expect(r.message).toBe('first\nsecond');
  });

  it('parse 실패 line 은 무시 + 카운터에 박제', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"t1"}',
      '{ malformed json',
      '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}',
    ].join('\n');
    const r = parseCodexJsonlOutput(stdout);
    expect(r.message).toBe('ok');
    expect(r.parseFailures).toBe(1);
  });

  it('ANSI / 상태 라인 (Reading additional input...) 은 skip', () => {
    const stdout = [
      'Reading additional input from stdin...',
      '[1m[33mWarning[0m',
      '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}',
    ].join('\n');
    const r = parseCodexJsonlOutput(stdout);
    expect(r.message).toBe('ok');
    expect(r.parseFailures).toBe(0);
  });

  it('agent_message 가 아닌 item type 은 무시 (e.g., reasoning, file_change)', () => {
    const stdout = [
      '{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"final"}}',
    ].join('\n');
    const r = parseCodexJsonlOutput(stdout);
    expect(r.segments).toEqual(['final']);
  });

  it('thread.started 없으면 threadId=null', () => {
    const stdout = '{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}';
    const r = parseCodexJsonlOutput(stdout);
    expect(r.threadId).toBeNull();
    expect(r.message).toBe('hi');
  });
});
