/**
 * ADR-016 (critic m2) — Codex 추출 run 에도 FORGEN_NESTED_RUN=1 이 전달된다.
 *
 * 실제 spawn 으로 검증한다: PATH 앞에 가짜 `codex` 실행 파일을 두고, 그 프로세스가 본 env 를
 * `codex exec --json` 형식으로 되돌려 받는다.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execHost } from '../../src/host/exec-host.js';

let binDir: string;
let prevPath: string | undefined;
let prevNested: string | undefined;

beforeEach(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-fake-codex-'));
  const fake = path.join(binDir, 'codex');
  fs.writeFileSync(fake, [
    '#!/usr/bin/env node',
    'const text = `nested=${process.env.FORGEN_NESTED_RUN ?? ""} args=${process.argv.slice(2, 3).join("")}`;',
    'console.log(JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } }));',
    '',
  ].join('\n'));
  fs.chmodSync(fake, 0o755);
  prevPath = process.env.PATH;
  prevNested = process.env.FORGEN_NESTED_RUN;
  delete process.env.FORGEN_NESTED_RUN;
  process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ''}`;
});

afterEach(() => {
  process.env.PATH = prevPath;
  if (prevNested === undefined) delete process.env.FORGEN_NESTED_RUN; else process.env.FORGEN_NESTED_RUN = prevNested;
  fs.rmSync(binDir, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('execHost codex — nested-run 표식', () => {
  it('기본값: 추출용 codex exec 에 FORGEN_NESTED_RUN=1 을 준다 (훅·notify 폴백이 그 세션을 건드리지 않게)', () => {
    const r = execHost({ host: 'codex', prompt: 'x' });
    expect(r.host).toBe('codex');
    expect(r.message).toBe('nested=1 args=exec');
  });

  it('nestedRun:false (invoke-agent 위임) 는 표식을 주지 않는다 — 위임 에이전트는 훅이 살아 있어야 한다', () => {
    expect(execHost({ host: 'codex', prompt: 'x', nestedRun: false }).message).toBe('nested= args=exec');
  });
});
