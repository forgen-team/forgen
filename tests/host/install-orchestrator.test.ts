/**
 * Install orchestrator — feat/codex-support P1-3 단위 테스트
 *
 * 명시 인자 dispatch + dry-run + 잘못된 인자 에러 검증.
 * (interactive flow 는 stdin 의존이라 별도 e2e 트랙)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInstall, resolvePkgRootFromBinary } from '../../src/host/install-orchestrator.js';

let tmpHome: string;
let tmpCodex: string;
let originalCodexHome: string | undefined;
let originalHome: string | undefined;

const PKG_ROOT = process.cwd();

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'install-orch-home-'));
  tmpCodex = fs.mkdtempSync(path.join(os.tmpdir(), 'install-orch-codex-'));
  originalHome = process.env.HOME;
  originalCodexHome = process.env.CODEX_HOME;
  process.env.HOME = tmpHome;
  process.env.CODEX_HOME = tmpCodex;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCodex, { recursive: true, force: true });
});

describe('runInstall — 명시 target dispatch', () => {
  it('target=codex → Codex 만 install (claude 결과 없음)', async () => {
    const r = await runInstall({ target: 'codex', pkgRoot: PKG_ROOT, dryRun: true });
    expect(r).not.toBeNull();
    expect(r!.target).toBe('codex');
    expect(r!.codex).toBeDefined();
    expect(r!.claude).toBeUndefined();
  });

  it('target=claude → Claude 만 install', async () => {
    const r = await runInstall({ target: 'claude', pkgRoot: PKG_ROOT, dryRun: true });
    expect(r!.target).toBe('claude');
    expect(r!.claude).toBeDefined();
    expect(r!.codex).toBeUndefined();
  });

  it('target=both → 둘 다 install', async () => {
    const r = await runInstall({ target: 'both', pkgRoot: PKG_ROOT, dryRun: true });
    expect(r!.target).toBe('both');
    expect(r!.claude).toBeDefined();
    expect(r!.codex).toBeDefined();
  });

  it('잘못된 target → throw', async () => {
    await expect(runInstall({ target: 'gemini', pkgRoot: PKG_ROOT, dryRun: true })).rejects.toThrow(/Unknown install target/);
  });

  it('detection 결과가 함께 반환됨 (claude/codex availability)', async () => {
    // homeDir 격리해도 detection 은 binary 도 보므로 claude/codex 가 PATH 에 있을 수 있음
    const r = await runInstall({ target: 'codex', pkgRoot: PKG_ROOT, dryRun: true });
    expect(r!.detection).toBeDefined();
    expect(r!.detection.claude).toBeDefined();
    expect(r!.detection.codex).toBeDefined();
  });

  it('dryRun=true 면 codex hooks.json 미작성', async () => {
    const r = await runInstall({ target: 'codex', pkgRoot: PKG_ROOT, dryRun: true });
    expect(r!.codex!.hooksWritten).toBe(false);
    expect(fs.existsSync(r!.codex!.hooksPath)).toBe(false);
  });
});

describe('resolvePkgRootFromBinary', () => {
  it('dist/cli.js URL 에서 pkgRoot 복원', () => {
    const metaUrl = `file:///abs/path/forgen/dist/cli.js`;
    expect(resolvePkgRootFromBinary(metaUrl)).toBe('/abs/path/forgen');
  });
});
