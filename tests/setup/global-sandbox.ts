/**
 * 전체 테스트 공통 환경.
 * - dist·hooks/hooks.json 을 현재 소스로 맞춘다(프로세스 실행 테스트가 낡은 빌드를 검증하지 않게).
 * - 실제 홈이 테스트 때문에 바뀌면 보고한다. FORGEN_TEST_STRICT_HOME=1(CI·Docker)이면 실패 처리.
 *   HOME·TMPDIR 샌드박스 자체는 vitest.config.ts 가 워커 생성 전에 설정한다.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO = path.resolve(__dirname, '..', '..');
const REAL_HOME = process.env.FORGEN_TEST_REAL_HOME ?? '';
const WATCHED = ['.forgen/me', '.forgen/notepad.md', '.claude/settings.json', '.claude/rules', '.claude.json', '.codex/hooks.json'];

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) newest = Math.max(newest, fs.statSync(full).mtimeMs);
  }
  return newest;
}

function ensureBuild(): void {
  const marker = path.join(REPO, 'dist', 'cli.js');
  const stale = !fs.existsSync(marker) || fs.statSync(marker).mtimeMs < newestMtime(path.join(REPO, 'src'));
  // 빌드와 hooks.json 생성은 샌드박스 HOME 으로 돈다. postinstall 은 부르지 않는다.
  if (stale) {
    // 타입 오류로 빌드가 실패해도 소스 테스트는 돌게 둔다. dist 를 쓰는 테스트가 실패로 드러난다.
    try { execFileSync('npx', ['tsc'], { cwd: REPO, stdio: 'inherit' }); } catch { process.stderr.write('[forgen-test] tsc 실패: dist 가 낡았을 수 있습니다\n'); }
  }
  if (stale || !fs.existsSync(path.join(REPO, 'hooks', 'hooks.json'))) {
    execFileSync(process.execPath, ['scripts/copy-assets.js'], { cwd: REPO, stdio: 'ignore' });
    execFileSync(process.execPath, ['scripts/prepack-hooks.cjs'], { cwd: REPO, stdio: 'ignore' });
  }
}

function fingerprint(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (p: string): void => {
    let st: fs.Stats;
    try { st = fs.lstatSync(p); } catch { return; }
    if (st.isDirectory()) { for (const n of fs.readdirSync(p)) walk(path.join(p, n)); return; }
    out.set(p, `${st.size}:${st.mtimeMs}`);
  };
  if (REAL_HOME) for (const rel of WATCHED) walk(path.join(REAL_HOME, rel));
  return out;
}

export default function setup(): () => void {
  ensureBuild();
  const before = fingerprint();
  return () => {
    const after = fingerprint();
    const changed = [...after].filter(([p, v]) => before.get(p) !== v).map(([p]) => p);
    const sandbox = process.env.FORGEN_TEST_SANDBOX;
    // 상속받은 샌드박스(중첩 vitest)는 만든 쪽이 지운다.
    if (sandbox && process.env.FORGEN_TEST_SANDBOX_OWNER === String(process.pid)) fs.rmSync(sandbox, { recursive: true, force: true });
    if (changed.length === 0) return;
    const msg = `[forgen-test] 테스트 실행 중 실제 홈이 바뀌었습니다 (${changed.length}):\n  ${changed.slice(0, 20).join('\n  ')}`;
    if (process.env.FORGEN_TEST_STRICT_HOME === '1') throw new Error(msg);
    // 개발 중에는 실행 중인 다른 세션도 이 파일들을 쓸 수 있어 경고만 한다.
    process.stderr.write(`${msg}\n`);
  };
}
