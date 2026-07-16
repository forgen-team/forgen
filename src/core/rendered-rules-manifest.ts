/**
 * Forgen v0.5.0 — Rendered Rules Manifest (ADR-010 W1-1)
 *
 * harness 가 렌더해 쓴 규칙 파일의 content-hash 원장.
 * reclaimer(`forgen migrate tenetx`)가 "forgen 이 쓴 그대로인 파일"과
 * "사용자가 편집했거나 다른 도구가 쓴 파일"을 구분하는 유일한 근거다 —
 * native /doctor 는 비용만 알지 provenance 를 모른다.
 *
 * 성능 (Rev 2): 렌더 시점에 이미 메모리에 있는 내용을 해시하므로
 * 재읽기/전체 스캔 비용이 없다. 스캔 사이드(reclaimer)만 파일을 읽는다.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

export interface ManifestEntry {
  sha256: string;
  version: string;
  ts: string;
}

export type RulesManifest = Record<string, ManifestEntry>;

export function manifestPath(home: string = os.homedir()): string {
  return path.join(home, '.forgen', 'state', 'rendered-rules-manifest.json');
}

export function sha256Of(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

export function loadManifest(home: string = os.homedir()): RulesManifest {
  try {
    const raw = fs.readFileSync(manifestPath(home), 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed as RulesManifest : {};
  } catch {
    return {};
  }
}

/**
 * 렌더 직후 호출 — 쓴 파일들의 해시를 기존 manifest 에 병합 기록.
 * 같은 경로는 최신 해시로 **덮어쓴다** (history 없음): 같은 경로에 구버전
 * 내용이 남는 시나리오는 렌더가 즉시 갱신하므로 존재하지 않고, 다른 경로의
 * 구버전 파일은 marker-only(needs-confirm) 경로로 안전 강등된다.
 */
export function recordRenderedFiles(
  files: Record<string, string>,
  version: string,
  home: string = os.homedir(),
): void {
  try {
    const p = manifestPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const manifest = loadManifest(home);
    const ts = new Date().toISOString();
    for (const [absPath, content] of Object.entries(files)) {
      manifest[absPath] = { sha256: sha256Of(content), version, ts };
    }
    fs.writeFileSync(p, JSON.stringify(manifest, null, 2) + '\n');
  } catch {
    // manifest 기록 실패는 렌더를 막지 않는다 (fail-open) —
    // 그 경우 reclaimer 가 marker-only 경로로 폴백한다.
  }
}

/** 파일 내용이 manifest 의 어떤 엔트리와도 일치하는가 (경로 키 기준) */
export function matchesManifest(absPath: string, content: string, manifest: RulesManifest): boolean {
  const entry = manifest[absPath];
  if (!entry) return false;
  return entry.sha256 === sha256Of(content);
}
