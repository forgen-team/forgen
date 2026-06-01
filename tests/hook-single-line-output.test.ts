/**
 * Regression: 각 등록 hook 엔트리는 stdout 에 JSON 제어 객체를 정확히 1줄만
 * emit 해야 한다. (Claude Code 규약: "stdout must contain only the JSON object")
 *
 * 배경 — context-guard 가 redactSecrets 를 './secret-filter.js' 에서 import 하는데,
 * secret-filter 가 ESM main-guard 없이 top-level `main()` 을 호출하던 버그로 인해
 * import 부작용으로 secret-filter.main() 이 실행되어 유령 {"continue":true} 가
 * 1줄 추가되었다. 결과적으로 context-guard 의 stdout 이 JSON 2줄 → Claude Code
 * 파싱 실패 → raw {"continue":true} 가 사용자 터미널에 노출되었다.
 *
 * 본 테스트는 실제 컴파일된 dist hook 을 서브프로세스로 실행하여 (mock 아님)
 * 1줄 emit 을 강제하고, secret-filter import 가 부작용을 일으키지 않음을 검증한다.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(__dirname, '..');
const HOOKS_DIR = path.join(REPO_ROOT, 'dist', 'hooks');
const SECRET_FILTER = path.join(HOOKS_DIR, 'secret-filter.js');

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-hook-1line-'));
}

function runHook(hookFile: string, payload: Record<string, unknown>, home: string) {
  return spawnSync('node', [path.join(HOOKS_DIR, hookFile)], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: home, FORGEN_SESSION_ID: 'test-1line' },
    encoding: 'utf-8',
    timeout: 10000,
  });
}

/** stdout 의 비어있지 않은 라인들. */
function stdoutLines(stdout: string): string[] {
  return stdout.trim().split('\n').filter(Boolean);
}

describe('hook stdout: exactly one JSON line per invocation', () => {
  const userPromptSubmitHooks = [
    'notepad-injector.js',
    'context-guard.js',
    'solution-injector.js',
    'skill-injector.js',
    'forge-loop-progress.js',
  ];

  for (const hook of userPromptSubmitHooks) {
    it(`${hook} (UserPromptSubmit) emits exactly one JSON line`, () => {
      const home = makeHome();
      try {
        const proc = runHook(hook, {
          hook_event_name: 'UserPromptSubmit',
          prompt: 'hello, please help me',
          session_id: 's-1',
          cwd: REPO_ROOT,
        }, home);
        const lines = stdoutLines(proc.stdout);
        expect(lines.length).toBe(1);
        // 단일 라인은 반드시 유효한 JSON 제어 객체여야 한다.
        expect(() => JSON.parse(lines[0])).not.toThrow();
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }

  it('context-guard (Stop) emits exactly one JSON line', () => {
    const home = makeHome();
    try {
      const proc = runHook('context-guard.js', {
        hook_event_name: 'Stop',
        stop_hook_type: 'end_turn',
        session_id: 's-2',
        transcript_path: path.join(home, 'no-such-transcript.jsonl'),
        cwd: REPO_ROOT,
      }, home);
      const lines = stdoutLines(proc.stdout);
      expect(lines.length).toBe(1);
      expect(() => JSON.parse(lines[0])).not.toThrow();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('secret-filter ESM main-guard', () => {
  it('importing secret-filter.js does NOT run main() (no stdout side-effect)', () => {
    const home = makeHome();
    try {
      // dynamic import 후 즉시 종료. guard 가 있으면 main() 미실행 → stdout 비어있음.
      // guard 가 없으면 import 시 main() 실행 → {"continue":true} 1줄 누출.
      const probe = `import(${JSON.stringify(pathToFileURL(SECRET_FILTER).href)}).then(() => process.exit(0));`;
      const proc = spawnSync('node', ['--input-type=module', '-e', probe], {
        // stdin 닫힘 — guard 가 없으면 readStdinJSON 이 빈 입력으로 진행해 approve() 를 찍는다.
        input: '',
        env: { ...process.env, HOME: home, FORGEN_SESSION_ID: 'test-import' },
        encoding: 'utf-8',
        timeout: 10000,
      });
      expect(proc.stdout.trim()).toBe('');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('running secret-filter.js directly DOES emit one JSON line (guard allows entrypoint)', () => {
    const home = makeHome();
    try {
      const proc = runHook('secret-filter.js', {
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: {},
        tool_response: 'nothing sensitive',
        session_id: 's-3',
        cwd: REPO_ROOT,
      }, home);
      const lines = stdoutLines(proc.stdout);
      expect(lines.length).toBe(1);
      expect(() => JSON.parse(lines[0])).not.toThrow();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
