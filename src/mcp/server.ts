#!/usr/bin/env node
/**
 * Forgen — MCP Compound Knowledge Server
 *
 * Pull 모델: Claude가 필요할 때 compound-search/read를 직접 호출.
 * instructions 필드로 Claude에게 compound 도구 사용법을 안내.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';

if (!process.env.FORGEN_CWD && !process.env.COMPOUND_CWD) {
  process.env.FORGEN_CWD = process.cwd();
  process.env.COMPOUND_CWD = process.cwd(); // legacy compat
}

// Multi-host evidence attribution (spec §10-5):
// 호출 host 가 spawn 시 `--host=<claude|codex>` 인자를 넘기면 본 process 의
// FORGEN_HOST env 를 set 한다. evidence-store 의 detectHost() 가 이 env 를 읽어
// correction-record 가 정확한 host 로 박제되게 한다. 미지정 시 기존 fallback
// (FORGEN_HOST > CODEX_HOME 추론 > 'claude') 그대로.
const hostArg = process.argv
  .find((a) => a === '--host=claude' || a === '--host=codex')
  ?.split('=')[1];
if (hostArg === 'claude' || hostArg === 'codex') {
  process.env.FORGEN_HOST = hostArg;
}

const INSTRUCTIONS = [
  'Forgen compound knowledge — accumulated patterns and solutions from past sessions.',
  '',
  'When to use:',
  '- Before starting a task: search for similar past patterns with compound-search',
  '- When encountering an error: search for troubleshooting solutions',
  '- When making architectural decisions: check if a similar decision was documented',
  '- After completing work: user may run /compound to extract new patterns',
  '',
  'Usage flow: compound-search (find relevant) → compound-read (get full content)',
  'compound-stats gives an overview of accumulated knowledge.',
  '',
  'Evidence collection:',
  '- When the user corrects your behavior, use correction-record to record it as evidence',
  '- This enables forgen to learn from corrections and adapt personalization over time',
].join('\n');

const server = new McpServer(
  { name: 'forgen-compound', version: '1.0.0' },
  { instructions: INSTRUCTIONS },
);

registerTools(server);

try {
  const transport = new StdioServerTransport();
  await server.connect(transport);
} catch (err) {
  process.stderr.write(`[forgen-mcp] Failed to start: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
}
