import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

// R2-D1: 테스트 프로세스 전체에 대한 글로벌 env.
// FORGEN_DISABLE_PROJECT_RULES=1 — .forgen/rules/ 자동 로딩 차단.
// repo 루트에 committed 된 L1 dogfood rules 가 테스트 격리를 깨뜨리는 것을 방지.
// 통합 테스트가 dogfood 로딩을 실제로 검증하려면 해당 테스트에서 env 해제.
process.env.FORGEN_DISABLE_PROJECT_RULES ??= '1';

// ADR-019 이후 Haiku 동의가 기본 켜짐 → Stop/PreToolUse 차단 시 detached block-judge 가 `claude -p` 를 띄워
// HOME(테스트 임시 폴더)에 `.claude.json.tmp.*` 를 쓴다. afterEach 의 rmSync 와 경쟁해 ENOTEMPTY 가 간헐 발생했다
// (e2e-correction-to-enforcement 10회 중 4회 재현). 판정 프로세스를 테스트에서 띄우지 않는다.
process.env.FORGEN_NO_BLOCK_JUDGE ??= '1';

// 테스트는 실제 홈·실제 /tmp 를 쓰지 않는다. 워커가 상속하도록 생성 전에 설정한다.
// 격리 안 한 실행이 실제 ~/.forgen 에 quarantine 363행, preflight 마커 236개, /tmp/forgen* 3,100개를 남겼다.
if (!process.env.FORGEN_TEST_SANDBOX) {
  process.env.FORGEN_TEST_REAL_HOME = os.homedir();
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-test-sandbox-'));
  process.env.FORGEN_TEST_SANDBOX = sandbox;
  process.env.FORGEN_TEST_SANDBOX_OWNER = String(process.pid);
  process.env.HOME = path.join(sandbox, 'home');
  process.env.USERPROFILE = process.env.HOME;
  process.env.TMPDIR = path.join(sandbox, 'tmp');
  // 저장소 체크아웃에서는 postinstall 이 스킵되므로, 샌드박스 HOME 대상 설치 테스트에서만 켠다.
  process.env.FORGEN_FORCE_POSTINSTALL = '1';
  fs.mkdirSync(process.env.HOME, { recursive: true });
  fs.mkdirSync(process.env.TMPDIR, { recursive: true });
  // 실행 중인 세션에서 물려받은 값이 테스트를 실제 환경으로 돌리지 않게 지운다.
  for (const key of Object.keys(process.env)) {
    if (/^(FORGEN_(HOME|CWD|HARNESS|SESSION_ID|NESTED_RUN|USER_CONFIRMED|AUTO_COMPOUND|NO_AUTO_COMPOUND)|COMPOUND_CWD|CLAUDE_(PROJECT_DIR|SESSION_ID|PLUGIN_ROOT|CONFIG_DIR)|CODEX_HOME)$/.test(key)) {
      delete process.env[key];
    }
  }
}

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/setup/global-sandbox.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      thresholds: {
        // v3.0.0 실측 기준 (2026-03-31). 매 릴리즈마다 상향. 장기 목표 70%.
        lines: 47,
        branches: 45,
        functions: 54,
        statements: 47,
      },
    },
  },
});
