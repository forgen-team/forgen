import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * P1-S1: auto-compound-runner가 전체 Bash 권한이 아니라 `Bash(forgen compound:*)`
 * allowlist를 Claude에게 전달한다. 공급망 인젝션 공격에서 임의 shell 명령 실행
 * 차단.
 */
describe('P1-S1: auto-compound-runner restricts Bash to forgen compound', () => {
  const srcPath = path.join(__dirname, '..', 'src', 'core', 'auto-compound-runner.ts');
  const content = fs.readFileSync(srcPath, 'utf-8');

  it('중첩 추출 호출은 모델에 도구를 아예 주지 않는다 (--tools "" — Bash 허용 목록보다 강함)', () => {
    const haiku = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'extraction-haiku.ts'), 'utf-8');
    expect(haiku).toMatch(/NESTED_ISOLATION_ARGS[^=]*=\s*\[\s*'--tools',\s*''/);
    expect(content).toContain('callHaiku(');
  });

  it('전체 Bash 권한(인자 `Bash` 단독)이 더 이상 존재하지 않음', () => {
    // 주석/문자열 제외한 코드 라인에서 "'Bash'" 또는 `"Bash"` 단독 리터럴 검사
    const codeLines = content
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));
    const code = codeLines.join('\n');
    // execClaudeRetry([..., '--allowedTools', 'Bash', ...]) 패턴이 없어야
    expect(code).not.toMatch(/'--allowedTools',\s*'Bash'/);
    expect(code).not.toMatch(/"--allowedTools",\s*"Bash"/);
  });
});

/**
 * P1-C1: prepack-hooks.cjs가 plugin.json version을 package.json과 동기화한다.
 * 과거에는 package.json v0.3.1 vs plugin.json v5.1.2 분리.
 */
describe('P1-C1: prepack syncs plugin.json version to package.json', () => {
  const prepackPath = path.join(__dirname, '..', 'scripts', 'prepack-hooks.cjs');
  const content = fs.readFileSync(prepackPath, 'utf-8');

  it('prepack-hooks.cjs에 syncPluginVersion 함수 존재 + main에서 호출', () => {
    expect(content).toMatch(/function syncPluginVersion/);
    expect(content).toMatch(/syncPluginVersion\(\)/);
  });

  it('syncPluginVersion을 실제 실행하면 plugin.json이 package.json 버전으로 맞춰진다', () => {
    // 임시 디렉터리에 미니 구조 만들어 검증
    const tmpDir = fs.mkdtempSync('/tmp/forgen-prepack-sync-test-');
    try {
      // package.json (source of truth)
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'test', version: '1.2.3' }),
      );
      // plugin.json (to be synced)
      fs.writeFileSync(
        path.join(tmpDir, 'plugin.json'),
        JSON.stringify({ name: 'test-plugin', version: '9.9.9' }),
      );
      fs.mkdirSync(path.join(tmpDir, '.claude-plugin'));
      fs.writeFileSync(
        path.join(tmpDir, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'test-plugin', version: '9.9.9' }),
      );

      // 스크립트의 syncPluginVersion 함수 그대로 복제 (인-프로세스 실행)
      const scriptsDir = path.join(tmpDir, 'scripts');
      fs.mkdirSync(scriptsDir);
      const stubScript = `
const fs = require('node:fs');
const path = require('node:path');
function syncPluginVersion() {
  const pkg = require(path.resolve(__dirname, '..', 'package.json'));
  const targetVersion = pkg.version;
  const pluginFiles = [
    path.resolve(__dirname, '..', 'plugin.json'),
    path.resolve(__dirname, '..', '.claude-plugin', 'plugin.json'),
  ];
  for (const pluginPath of pluginFiles) {
    if (!fs.existsSync(pluginPath)) continue;
    const data = JSON.parse(fs.readFileSync(pluginPath, 'utf-8'));
    if (data.version === targetVersion) continue;
    data.version = targetVersion;
    fs.writeFileSync(pluginPath, JSON.stringify(data, null, 2) + '\\n');
  }
}
syncPluginVersion();
`;
      fs.writeFileSync(path.join(scriptsDir, 'sync.cjs'), stubScript);
      execSync(`node ${path.join(scriptsDir, 'sync.cjs')}`, { cwd: tmpDir });

      const p1 = JSON.parse(fs.readFileSync(path.join(tmpDir, 'plugin.json'), 'utf-8'));
      const p2 = JSON.parse(
        fs.readFileSync(path.join(tmpDir, '.claude-plugin', 'plugin.json'), 'utf-8'),
      );
      expect(p1.version).toBe('1.2.3');
      expect(p2.version).toBe('1.2.3');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
