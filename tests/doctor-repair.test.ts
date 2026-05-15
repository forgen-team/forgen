/**
 * v0.4.8 (E3): forgen doctor --repair 옵션이 DoctorOptions 시그니처에
 * 노출되고, repair=true 시 안내문이 "auto-repair 시도" 로 바뀌는지 검증.
 *
 * 실제 npm run build + postinstall 실행은 통합 환경 의존이라 단위 테스트
 * 에서는 호출 신호 (안내문 + opts 시그니처) 만 검증.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('A E3: forgen doctor --repair 시그니처', () => {
  const srcPath = path.join(__dirname, '..', 'src', 'core', 'doctor.ts');
  const cliPath = path.join(__dirname, '..', 'src', 'cli.ts');
  const doctorSrc = fs.readFileSync(srcPath, 'utf-8');
  const cliSrc = fs.readFileSync(cliPath, 'utf-8');

  it('DoctorOptions 에 repair?: boolean 필드 노출', () => {
    expect(doctorSrc).toMatch(/repair\?:\s*boolean/);
  });

  it('cli.ts doctor handler 가 --repair 플래그를 opts.repair 로 매핑', () => {
    expect(cliSrc).toMatch(/repair:\s*args\.includes\(['"]--repair['"]\)/);
  });

  it('attemptPluginRepair 함수가 build + postinstall 을 차례로 실행', () => {
    expect(doctorSrc).toMatch(/function attemptPluginRepair/);
    expect(doctorSrc).toMatch(/execFileSync\('npm',\s*\['run',\s*'build'\]/);
    expect(doctorSrc).toMatch(/execFileSync\('node',\s*\['scripts\/postinstall\.js'\]/);
  });

  it('runDoctor 가 plugin cache 또는 registered 실패 + opts.repair=true 일 때만 repair 호출', () => {
    expect(doctorSrc).toMatch(/opts\.repair\s*&&\s*\(!forgenPluginCacheOk\s*\|\|\s*!pluginRegistered\)/);
  });

  it('repair 안내문이 --repair 사용 시 "auto-repair" 로 전환', () => {
    expect(doctorSrc).toMatch(/Attempting auto-repair \(--repair\)/);
  });
});
