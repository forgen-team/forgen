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
//
// Build-time injection: --with-codex 공유 snippet 을 모든 스킬 body 끝에 append.
// source 파일은 깨끗하게 유지하면서 10개 전체 스킬에 cross-model review 옵션 부여.
// install-claude.ts 의 slash command 생성 경로도 동일 snippet 을 append 한다.
const WITH_CODEX_SNIPPET = `

---

## \`--with-codex\` flag (cross-model review)

If \`$ARGUMENTS\` contains any of \`--with-codex\`, \`--코덱스\`, \`with codex\`, \`코덱스 검토\`, \`코덱스로 검토\`,
then after completing the primary skill work, perform a cross-model review pass:

1. Save your primary output text to a temp file (e.g., \`/tmp/forgen-with-codex-$(date +%s).md\`).
2. Invoke codex via Bash:
   \`\`\`bash
   codex exec --json --ignore-user-config --ignore-rules --ephemeral \\
     -s read-only -c approval_policy="never" --skip-git-repo-check \\
     "$(printf 'You are a second-opinion reviewer for another AI assistant\\\\u0027s output. Read the work product below and report ONLY:\\n1. Defects, gaps, or risks the original work missed\\n2. Specific disagreements with the original\\n3. Topics that should have been covered but were not\\n\\nOutput format: prioritized bullet list (max 15 items, severity-sorted, no prose intro). If you find nothing material, say "No critical issues found."\\n\\n<work>\\n%s\\n</work>' "$(cat /tmp/forgen-with-codex-*.md)")"
   \`\`\`
3. Append the codex output under heading \`## Codex Cross-Review (--with-codex)\` in your final response.
4. If codex flags critical issues, briefly acknowledge + suggest follow-up.
5. If \`codex: command not found\`, note in response and skip the review pass (do not fail).

OPT-IN per invocation. Without the flag, skip this entire section.
`;

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
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}${WITH_CODEX_SNIPPET}\n`,
    );
  }
  console.log(`[build] Generated ${files.length} skills from commands/ (with --with-codex snippet)`);
}
