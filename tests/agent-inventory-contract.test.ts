/**
 * Invariant: agent 인벤토리 단일 source 정렬 (W3)
 *
 * 자기증거: v0.4.1 까지 README.md 는 "12 built-in", `agents/` 디렉토리는 13개,
 * `tests/e2e/docker/verify-v3.sh` 는 13 expected — 3 자리에서 다른 수치.
 *
 * 본 invariant 는 agents/ 디렉토리를 단일 source 로 강제. README/verify 가
 * 디스크 인벤토리와 일치해야 한다.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const AGENTS_DIR = path.join(REPO_ROOT, 'assets', 'claude', 'agents');

function getAgentNames(): string[] {
  return fs.readdirSync(AGENTS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace(/\.md$/, ''))
    .sort();
}

describe('Invariant: agent 인벤토리 단일 source (W3)', () => {
  it('agents/ 디렉토리 .md 파일 수 = 디스크 진실', () => {
    const names = getAgentNames();
    expect(names.length).toBeGreaterThan(0);
    // 본 테스트가 깨지면 "ch-solution-evolver 처럼 새 agent 가 추가됨" 의미.
    // README + verify-v3.sh 도 함께 갱신했는지 review 필수.
    expect(names.length, `현재 ${names.length}개 agent: ${names.join(', ')}`).toBe(13);
  });

  it('README.md 의 "N built-in agents" 가 agents/ 개수와 일치', () => {
    const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf-8');
    const m = readme.match(/(\d+)\s+built-in\s+agents/);
    expect(m, 'README.md 에 "N built-in agents" 헤더 필요').not.toBeNull();
    const claimed = parseInt(m![1], 10);
    expect(claimed, `README claim ${claimed} vs disk ${getAgentNames().length}`).toBe(getAgentNames().length);
  });

  it('verify-v3.sh 가 agents/ 개수와 일치', () => {
    const script = fs.readFileSync(path.join(REPO_ROOT, 'tests/e2e/docker/verify-v3.sh'), 'utf-8');
    const m = script.match(/AGENT_COUNT["\s]*=["\s]*"(\d+)"/);
    expect(m, 'verify-v3.sh 에 AGENT_COUNT 값 비교 필요').not.toBeNull();
    const claimed = parseInt(m![1], 10);
    expect(claimed, `verify-v3.sh ${claimed} vs disk ${getAgentNames().length}`).toBe(getAgentNames().length);
  });

  it('각 agent .md 파일이 frontmatter name 가짐', () => {
    for (const slug of getAgentNames()) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, `${slug}.md`), 'utf-8');
      const m = content.match(/^\s*name:\s*(\S+)/m);
      expect(m, `${slug}.md 에 frontmatter name 필요`).not.toBeNull();
    }
  });
});
