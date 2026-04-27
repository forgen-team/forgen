#!/usr/bin/env node

/**
 * Codex 훅 어댑터 — Multi-Host Core Design §10 우선순위 2 (승격)
 *
 * 본 binary 는 codex 런타임에서 실행되는 훅 스크립트 출력을 Claude Hook schema 로
 * 사영(projection)한다. 사영 로직은 정식 계약 `ProjectToClaudeEvent` (src/host/projection.ts)
 * 에서 제공하며, 본 파일은 그 계약의 *binary 진입점* 역할만 수행한다.
 *
 * - 입력: 사용자 hook 스크립트(stdin JSON, argv 의 첫 인자가 delegate path)
 * - 출력: Claude HookEventOutput 동치 JSON (stdout 1줄)
 * - 실패 정책: parse/실행 실패 → fail-open (`{ continue: true }`)
 */

import { spawnSync } from 'node:child_process';
import type { HookEventInput } from '../core/types.js';
import { projectCodexToClaude } from './projection.js';

function lastJSONObjectFromText(raw: string): unknown | null {
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const [delegatePath, ...restArgs] = process.argv.slice(2);
  if (!delegatePath) {
    console.log(JSON.stringify({ continue: true }));
    return;
  }

  const input = await (async () => {
    const chunks: Array<Buffer | string> = [];
    let totalBytes = 0;
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (totalBytes > 10 * 1024 * 1024) break;
    }
    const raw = Buffer.concat(chunks.map(c => typeof c === 'string' ? Buffer.from(c) : c)).toString('utf-8').trim();
    if (!raw) return {};
    try {
      return JSON.parse(raw) as HookEventInput;
    } catch {
      return {};
    }
  })();

  try {
    const result = spawnSync(process.execPath, [delegatePath, ...restArgs], {
      encoding: 'utf-8',
      input: JSON.stringify(input),
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (result.error) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    const parsed = lastJSONObjectFromText(result.stdout ?? '');
    if (!parsed) {
      console.log(JSON.stringify({ continue: true }));
      return;
    }

    const output = projectCodexToClaude(parsed, input as HookEventInput);
    console.log(JSON.stringify(output));
  } catch {
    console.log(JSON.stringify({ continue: true }));
  }
}

main().catch(() => {
  console.log(JSON.stringify({ continue: true }));
});
