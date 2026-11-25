/**
 * 첫 감사 때 기억 전체의 지문 (docs/plans/2026-11-25-v1.0-plan.md §2.2 끝, §9 0.9.0).
 * "후" 구간에서 기억의 그때 모습을 시점 추정 없이 되살리는 근거: 파일마다 해시·크기, 줄마다 정규화 문장의 짧은 해시.
 * 한 번만 쓴다 — <FORGEN_HOME>/audit/fingerprint-*.json 이 하나라도 있으면 아무것도 하지 않는다. 원천은 읽기만 한다.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { FORGEN_HOME } from '../core/paths.js';
import { normalizeSentence } from './checks.js';

export const FINGERPRINT_SCHEMA = 'forgen-audit-fingerprint/1' as const;

export interface FingerprintFile { path: string; bytes: number; sha256: string; lines: Array<[number, string]>; error?: string }

const h = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

export function fingerprintFile(p: string): FingerprintFile {
  try {
    const buf = fs.readFileSync(p);
    const lines: Array<[number, string]> = [];
    buf.toString('utf-8').split('\n').forEach((l, i) => {
      const n = normalizeSentence(l);
      if (n) lines.push([i + 1, h(n).slice(0, 12)]);
    });
    return { path: p, bytes: buf.length, sha256: h(buf), lines };
  } catch (e) {
    return { path: p, bytes: 0, sha256: '', lines: [], error: (e as NodeJS.ErrnoException).code ?? String(e) };
  }
}

export function existingFingerprint(dir = path.join(FORGEN_HOME, 'audit')): string | null {
  try { return fs.readdirSync(dir).filter((n) => /^fingerprint-.*\.json$/.test(n)).sort()[0] ?? null; } catch { return null; }
}

/** 처음이면 지문을 쓰고 경로를, 이미 있으면 null 을 돌려준다. */
export function writeFingerprintIfFirst(files: string[], now = new Date(), forgenVersion = ''): string | null {
  const dir = path.join(FORGEN_HOME, 'audit');
  if (existingFingerprint(dir)) return null;
  const uniq = [...new Set(files)].sort();
  const body = { schema: FINGERPRINT_SCHEMA, generatedAt: now.toISOString(), forgenVersion, files: uniq.map(fingerprintFile) };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = path.join(dir, `fingerprint-${now.toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(p, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  return p;
}
