import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { handleChangelog } from '../src/core/changelog-cli.js';

// 0.5.3: 실 저장소의 git 상태(HEAD 에 태그가 있으면 "No commits since")에 의존하던 테스트를
// 격리 fixture 로 전환. 릴리스 태그 직후 prepublish `npm test` 가 깨지던 원인.
let repo: string;
function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-changelog-'));
  git('init', '-q', '.');
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  git('add', '.'); git('commit', '-q', '-m', 'chore: init');
  git('tag', 'v0.0.1');
  fs.writeFileSync(path.join(repo, 'a.txt'), '2');
  git('add', '.'); git('commit', '-q', '-m', 'feat(core): add thing');
  fs.writeFileSync(path.join(repo, 'a.txt'), '3');
  git('add', '.'); git('commit', '-q', '-m', 'fix: repair thing');
});

afterAll(() => { fs.rmSync(repo, { recursive: true, force: true }); });

async function capture(): Promise<string> {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(' '));
  try { await handleChangelog({ cwd: repo }); } finally { console.log = orig; }
  return logs.join('\n');
}

describe('changelog-cli (v0.5.0)', () => {
  it('runs without error in a git repo', async () => {
    expect(await capture()).toContain('Changelog');
  });

  it('groups commits by conventional type', async () => {
    const output = await capture();
    expect(output).toMatch(/###\s+Features/);
    expect(output).toMatch(/###\s+Bug Fixes/);
  });

  it('includes markdown copy-paste section', async () => {
    expect(await capture()).toContain('Markdown');
  });
});
