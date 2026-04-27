/**
 * Invariant: 단일 source 계약 검증 (W5)
 *
 * 자기증거: 본 forge-loop 가 hook count 를 4 자리에 21 로 하드코딩 → W5 antipattern
 * 강화. 이 invariant 는 그 회귀를 시스템 레벨에서 차단.
 *
 * 단일 source:
 *   - hook count: HOOK_REGISTRY (TS) ↔ hooks/hook-registry.json (JSON)
 *   - agent count: agents/*.md (디스크)
 *
 * 본 테스트가 깨지면 단일 source 가 동기화되지 않은 것 — 모든 자리가
 * source 를 read 하는지 점검.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HOOK_REGISTRY } from '../src/hooks/hook-registry.js';

const REPO_ROOT = path.resolve(__dirname, '..');

describe('Invariant: 단일 source — hook count (W5)', () => {
  it('HOOK_REGISTRY (TS) length === hook-registry.json (JSON) length', () => {
    const jsonData = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'hooks', 'hook-registry.json'), 'utf-8'),
    );
    expect(Array.isArray(jsonData)).toBe(true);
    expect(HOOK_REGISTRY.length).toBe(jsonData.length);
  });

  it('테스트에 하드코딩된 hook count 가 없음 (W5 antipattern 가드)', () => {
    // tests/ 내에서 toBe(20|21) hook count 패턴 grep — 의도된 false-positive 제외
    const testsDir = path.join(REPO_ROOT, 'tests');
    const offenders: Array<{ file: string; line: number; text: string }> = [];

    function scan(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { scan(full); continue; }
        if (!entry.name.endsWith('.test.ts')) continue;
        const content = fs.readFileSync(full, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // hook count 의미의 하드코딩만 — context 로 hook/registry 키워드 동반
          if (/HOOK_REGISTRY\.length\)?\.toBe\(\d+\)/.test(line)) {
            offenders.push({ file: path.relative(REPO_ROOT, full), line: i + 1, text: line.trim() });
          }
          // hooks.json description 의 \d+\/N active 패턴에서 N 이 리터럴 숫자
          if (/\\d\+\\\/\d+ active/.test(line)) {
            offenders.push({ file: path.relative(REPO_ROOT, full), line: i + 1, text: line.trim() });
          }
        }
      }
    }
    scan(testsDir);

    // 본 invariant 자체의 self-reference 도 제외 (이 파일)
    const filtered = offenders.filter(o => !o.file.endsWith('contract-single-source.test.ts'));

    expect(
      filtered,
      `하드코딩된 hook count 발견 (W5 antipattern):\n${filtered.map(o => `  ${o.file}:${o.line}  ${o.text}`).join('\n')}`,
    ).toEqual([]);
  });
});

describe('Invariant: 단일 source — agent count (W3 → W5)', () => {
  it('agents/ 디렉토리 = README + verify-v3.sh', () => {
    const agentsDir = path.join(REPO_ROOT, 'agents');
    const agentCount = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md')).length;

    const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf-8');
    const readmeMatch = readme.match(/(\d+)\s+built-in\s+agents/);
    expect(readmeMatch).not.toBeNull();
    expect(parseInt(readmeMatch![1], 10)).toBe(agentCount);

    const verifyScript = fs.readFileSync(path.join(REPO_ROOT, 'tests/e2e/docker/verify-v3.sh'), 'utf-8');
    const verifyMatch = verifyScript.match(/AGENT_COUNT["\s]*=["\s]*"(\d+)"/);
    expect(verifyMatch).not.toBeNull();
    expect(parseInt(verifyMatch![1], 10)).toBe(agentCount);
  });
});
