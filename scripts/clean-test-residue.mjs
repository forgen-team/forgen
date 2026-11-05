#!/usr/bin/env node
/**
 * 격리 없이 돌던 과거 테스트가 실제 환경에 남긴 흔적 정리. 기본은 목록만 출력한다.
 *   node scripts/clean-test-residue.mjs          # dry-run
 *   node scripts/clean-test-residue.mjs --apply  # 실제 정리
 *
 * 대상: /tmp/forgen* (1일 이상 지난 것), state/preflight-warned-test-*,
 *       solution-quarantine.jsonl 의 임시 경로 행. 사용자 룰·교정·솔루션은 건드리지 않는다.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const apply = process.argv.includes('--apply');
const forgenHome = process.env.FORGEN_HOME ?? path.join(os.homedir(), '.forgen');
const tmpRoot = process.env.FORGEN_RESIDUE_TMP ?? '/tmp';
const stateDir = path.join(forgenHome, 'state');
const DAY = 86_400_000;

const tmpDirs = fs.existsSync(tmpRoot)
  ? fs.readdirSync(tmpRoot)
      .filter((n) => /^forgen-.*[-_][0-9A-Za-z]{4,}$/.test(n)) // 테스트가 만든 "forgen-<이름>-<임의값>" 형태만
      .map((n) => path.join(tmpRoot, n))
      .filter((p) => { try { return Date.now() - fs.lstatSync(p).mtimeMs > DAY; } catch { return false; } })
  : [];

const markers = fs.existsSync(stateDir)
  ? fs.readdirSync(stateDir).filter((n) => n.startsWith('preflight-warned-test-')).map((n) => path.join(stateDir, n))
  : [];

const quarantine = path.join(stateDir, 'solution-quarantine.jsonl');
const qLines = fs.existsSync(quarantine) ? fs.readFileSync(quarantine, 'utf-8').split('\n').filter(Boolean) : [];
// 임시 경로 중 테스트 폴더만. /tmp 아래의 실제 솔루션 격리 기록은 남긴다.
const isTmpLine = (line) => { try { return /^\/(private\/)?tmp\/[^/]*test[^/]*\//.test(JSON.parse(line).path); } catch { return false; } };
const qRemoved = qLines.filter(isTmpLine);

console.log(`임시 폴더 ${tmpDirs.length}, preflight 마커 ${markers.length}, quarantine 임시 경로 행 ${qRemoved.length}/${qLines.length}`);
if (!apply) {
  console.log('dry-run: --apply 로 실제 정리');
  process.exit(0);
}
let failed = 0;
for (const p of [...tmpDirs, ...markers]) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { failed++; }
}
if (qRemoved.length > 0) {
  fs.writeFileSync(`${quarantine}.bak-${Date.now()}`, `${qLines.join('\n')}\n`);
  const keep = qLines.filter((l) => !isTmpLine(l));
  const staged = `${quarantine}.tmp-${process.pid}`;
  fs.writeFileSync(staged, keep.length ? `${keep.join('\n')}\n` : '');
  fs.renameSync(staged, quarantine);
}
console.log(failed ? `정리 완료, 실패 ${failed}건` : '정리 완료');
