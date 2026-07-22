import { describe, it, expect } from 'vitest';
import {
  mapToolName,
  normalizeToolArgs,
  toolBeforeToClaudeInput,
  decisionFromForgenOutput,
  OPENCODE_TO_CLAUDE_TOOL,
} from '../src/host/opencode/translate.js';

describe('opencode/translate (W3-3 plugin 슬림)', () => {
  describe('mapToolName', () => {
    it('알려진 tool 은 Claude 이름으로', () => {
      expect(mapToolName('bash')).toBe('Bash');
      expect(mapToolName('read')).toBe('Read');
      expect(mapToolName('write')).toBe('Write');
      expect(mapToolName('edit')).toBe('Edit');
      expect(mapToolName('webfetch')).toBe('WebFetch');
    });
    it('대소문자 무관', () => {
      expect(mapToolName('BASH')).toBe('Bash');
    });
    it('미지 tool 은 첫 글자 대문자 폴백', () => {
      expect(mapToolName('customtool')).toBe('Customtool');
    });
    it('빈 문자열 안전', () => {
      expect(mapToolName('')).toBe('');
    });
    it('매핑 테이블에 핵심 가드 대상 tool 존재', () => {
      // db-guard=Bash, secret/write=Write/Edit — 이들이 매핑돼야 가드가 발화
      expect(OPENCODE_TO_CLAUDE_TOOL.bash).toBe('Bash');
      expect(OPENCODE_TO_CLAUDE_TOOL.write).toBe('Write');
    });
  });

  describe('normalizeToolArgs', () => {
    it('filePath → file_path (가드 정합)', () => {
      expect(normalizeToolArgs({ filePath: '/x/.env' })).toMatchObject({ file_path: '/x/.env', filePath: '/x/.env' });
    });
    it('command 는 그대로 (db-guard 가 tool_input.command 로 rm -rf 감지)', () => {
      expect(normalizeToolArgs({ command: 'rm -rf /' })).toMatchObject({ command: 'rm -rf /' });
    });
    it('file_path 가 이미 있으면 덮어쓰지 않음', () => {
      expect(normalizeToolArgs({ file_path: '/a', filePath: '/b' }).file_path).toBe('/a');
    });
    it('null/undefined 안전', () => {
      expect(normalizeToolArgs(null)).toEqual({});
      expect(normalizeToolArgs(undefined)).toEqual({});
    });
  });

  describe('toolBeforeToClaudeInput', () => {
    it('bash rm -rf → Claude PreToolUse 입력', () => {
      const r = toolBeforeToClaudeInput('bash', { command: 'rm -rf /tmp/x' });
      expect(r).toEqual({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /tmp/x' },
      });
    });
    it('write .env → file_path 정규화', () => {
      const r = toolBeforeToClaudeInput('write', { filePath: '/x/.env', content: 'SECRET=1' });
      expect(r.tool_name).toBe('Write');
      expect(r.tool_input.file_path).toBe('/x/.env');
    });
  });

  describe('decisionFromForgenOutput', () => {
    it('permissionDecision:deny → block + reason', () => {
      const out = JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'rm -rf 차단' } });
      const d = decisionFromForgenOutput(out);
      expect(d.block).toBe(true);
      expect(d.reason).toContain('rm -rf');
    });
    it('allow/continue → block 없음', () => {
      expect(decisionFromForgenOutput('{"continue":true}').block).toBe(false);
      expect(decisionFromForgenOutput(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } })).block).toBe(false);
    });
    it('로그 섞인 stdout 에서 마지막 JSON 파싱', () => {
      const out = '[forgen] some log line\n{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"blocked"}}';
      expect(decisionFromForgenOutput(out).block).toBe(true);
    });
    it('파싱 실패/빈 출력 → fail-open (block 없음)', () => {
      expect(decisionFromForgenOutput('not json').block).toBe(false);
      expect(decisionFromForgenOutput('').block).toBe(false);
    });
  });
});
