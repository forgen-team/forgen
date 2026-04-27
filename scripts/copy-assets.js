// §7.2 자산분리 PR-2 적용 — 소스 경로 갱신 완료.
//   commands/  → assets/claude/commands/   ✅
//   agents/    → assets/claude/agents/     ✅
//   hook-registry.json → assets/shared/    ✅
//   skills/    : 빌드 산출물 (gitignored), 본 스크립트가 commands → skills 변환 (위치 유지)
//   hooks/hooks.json: 빌드 산출물 (gitignored), prepack-hooks.cjs 가 생성 (위치 유지)

import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');

// 1. dangerous-patterns.json 복사
const src = new URL('../src/hooks/dangerous-patterns.json', import.meta.url).pathname;
const dst = new URL('../dist/hooks/dangerous-patterns.json', import.meta.url).pathname;
mkdirSync(dirname(dst), { recursive: true });
cpSync(src, dst);
console.log('[build] Copied dangerous-patterns.json');

// 2. assets/claude/commands/*.md → skills/{name}/SKILL.md 생성 (Claude Code 플러그인 표준)
const commandsDir = join(PKG_ROOT, 'assets', 'claude', 'commands');
const skillsDir = join(PKG_ROOT, 'skills');
if (existsSync(commandsDir)) {
  try { rmSync(skillsDir, { recursive: true, force: true }); } catch { /* ignore */ }
  const files = readdirSync(commandsDir).filter(f => f.endsWith('.md'));
  for (const file of files) {
    const name = file.replace('.md', '');
    const raw = readFileSync(join(commandsDir, file), 'utf-8');
    const descMatch = raw.match(/description:\s*(.+)/);
    const desc = descMatch?.[1]?.trim() ?? name;
    const bodyMatch = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    const body = bodyMatch?.[1]?.trim() ?? raw;
    const skillDir = join(skillsDir, name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}\n`);
  }
  console.log(`[build] Generated ${files.length} skills from commands/`);
}
