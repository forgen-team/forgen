/**
 * forgen changelog — auto-summarize changes since last release tag.
 *
 * Reads git log between the latest vX.Y.Z tag and HEAD, groups by
 * conventional commit type, and outputs a ready-to-paste changelog.
 */

import { execFileSync } from 'node:child_process';

const isTTY = process.stdout.isTTY;
const C = {
  reset: isTTY ? '\x1b[0m' : '',
  bold: isTTY ? '\x1b[1m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
};

interface CommitInfo {
  hash: string;
  type: string;
  scope: string;
  subject: string;
}

function getLatestTag(): string | null {
  try {
    return execFileSync('git', ['describe', '--tags', '--abbrev=0'], {
      encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

function getCommitsSince(tag: string | null): string[] {
  try {
    const args = tag
      ? ['log', `${tag}..HEAD`, '--oneline', '--no-merges']
      : ['log', '--oneline', '--no-merges', '-30'];
    return execFileSync('git', args, {
      encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function parseCommit(line: string): CommitInfo {
  const match = line.match(/^([a-f0-9]+)\s+(\w+)(?:\(([^)]*)\))?:\s*(.+)$/);
  if (match) {
    return { hash: match[1], type: match[2], scope: match[3] ?? '', subject: match[4] };
  }
  const parts = line.split(/\s+/, 2);
  return { hash: parts[0], type: 'other', scope: '', subject: parts.slice(1).join(' ') || line };
}

const TYPE_ORDER: Record<string, { label: string; order: number }> = {
  feat: { label: 'Features', order: 0 },
  fix: { label: 'Bug Fixes', order: 1 },
  refactor: { label: 'Refactoring', order: 2 },
  test: { label: 'Tests', order: 3 },
  ci: { label: 'CI/CD', order: 4 },
  docs: { label: 'Documentation', order: 5 },
  chore: { label: 'Maintenance', order: 6 },
  other: { label: 'Other', order: 7 },
};

export async function handleChangelog(): Promise<void> {
  const tag = getLatestTag();
  const rawCommits = getCommitsSince(tag);

  if (rawCommits.length === 0) {
    console.log(`\n  ${C.dim}No commits since ${tag ?? 'beginning'}.${C.reset}\n`);
    return;
  }

  const commits = rawCommits.map(parseCommit);
  const grouped = new Map<string, CommitInfo[]>();
  for (const c of commits) {
    const key = TYPE_ORDER[c.type] ? c.type : 'other';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)?.push(c);
  }

  const sorted = [...grouped.entries()].sort((a, b) => {
    return (TYPE_ORDER[a[0]]?.order ?? 99) - (TYPE_ORDER[b[0]]?.order ?? 99);
  });

  console.log('');
  console.log(`  ${C.bold}Changelog${C.reset}  ${C.dim}${tag ?? 'start'}..HEAD${C.reset}  ${C.dim}(${commits.length} commits)${C.reset}`);
  console.log('');

  for (const [type, items] of sorted) {
    const label = TYPE_ORDER[type]?.label ?? type;
    console.log(`  ${C.cyan}### ${label}${C.reset}`);
    for (const c of items) {
      const scope = c.scope ? `${C.yellow}(${c.scope})${C.reset} ` : '';
      console.log(`    ${C.dim}${c.hash}${C.reset} ${scope}${c.subject}`);
    }
    console.log('');
  }

  // Markdown output for copy-paste
  console.log(`  ${C.dim}── Markdown (copy-paste ready) ──${C.reset}`);
  console.log('');
  for (const [type, items] of sorted) {
    const label = TYPE_ORDER[type]?.label ?? type;
    console.log(`  ### ${label}`);
    for (const c of items) {
      const scope = c.scope ? `**${c.scope}**: ` : '';
      console.log(`  - ${scope}${c.subject}`);
    }
    console.log('');
  }
}
