/**
 * Host detection — Phase 1 P1-1 단위 테스트
 *
 * 격리 환경에서 detectAvailableHosts() 동작 검증. 실 시스템의 claude/codex 설치
 * 여부와 무관하게 mock 시나리오 3종 (claude only / codex only / both) + edge case.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Mod = typeof import('../../src/core/host-detect.js');

async function reload(): Promise<Mod> {
  vi.resetModules();
  return (await import('../../src/core/host-detect.js')) as Mod;
}

let originalCodexHome: string | undefined;
let isolatedHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalCodexHome = process.env.CODEX_HOME;
  originalHome = process.env.HOME;
  isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'host-detect-test-'));
  process.env.HOME = isolatedHome;
});

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(isolatedHome, { recursive: true, force: true });
});

describe('detectAvailableHosts', () => {
  it('home 디렉토리 존재만으로도 available=true (binary 미설치 환경)', async () => {
    fs.mkdirSync(path.join(isolatedHome, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(isolatedHome, '.codex'), { recursive: true });
    // homedir() 는 process.env.HOME 따라가도록 보장 (Node.js 기본 동작)
    const { detectAvailableHosts } = await reload();
    const result = detectAvailableHosts();
    expect(result.claude.homeExists).toBe(true);
    expect(result.codex.homeExists).toBe(true);
    expect(result.claude.available).toBe(true);
    expect(result.codex.available).toBe(true);
    expect(result.bothAvailable).toBe(true);
    expect(result.noneAvailable).toBe(false);
  });

  it('아무 home 도 없을 때 — binary 만 의존 (실 시스템 binary 따라 결과 다를 수 있어 noneAvailable 검증만 약하게)', async () => {
    // 아무 디렉토리 안 만듦 — homeExists=false
    const { detectAvailableHosts } = await reload();
    const result = detectAvailableHosts();
    expect(result.claude.homeExists).toBe(false);
    expect(result.codex.homeExists).toBe(false);
    // binary 가 실 시스템에 있을 수 있어 noneAvailable 은 환경 의존. 단 homeExists 는 확정.
  });

  it('codex auth.json 존재 시 authPresent=true', async () => {
    const codexHome = path.join(isolatedHome, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'auth.json'), '{"token":"test"}');
    const { detectAvailableHosts } = await reload();
    const result = detectAvailableHosts();
    expect(result.codex.authPresent).toBe(true);
    expect(result.codex.homeExists).toBe(true);
  });

  it('claude 의 authPresent 는 항상 null (subscription 통합 모델)', async () => {
    fs.mkdirSync(path.join(isolatedHome, '.claude'), { recursive: true });
    const { detectAvailableHosts } = await reload();
    const result = detectAvailableHosts();
    expect(result.claude.authPresent).toBe(null);
  });

  it('CODEX_HOME env 로 codex home 재배치', async () => {
    const altCodex = path.join(isolatedHome, 'alt-codex');
    fs.mkdirSync(altCodex, { recursive: true });
    process.env.CODEX_HOME = altCodex;
    const { detectAvailableHosts } = await reload();
    const result = detectAvailableHosts();
    expect(result.codex.homePath).toBe(altCodex);
    expect(result.codex.homeExists).toBe(true);
  });

  it('result.bothAvailable / noneAvailable 는 정합성 (둘이 동시에 true 불가)', async () => {
    const { detectAvailableHosts } = await reload();
    const result = detectAvailableHosts();
    expect(result.bothAvailable && result.noneAvailable).toBe(false);
  });
});
