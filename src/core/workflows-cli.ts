/**
 * forgen workflows — dynamic-workflow 템플릿 설치/조회 (ADR-009 §3).
 *
 * dynamic workflows 는 플러그인 매니페스트로 번들할 수 없고(research preview,
 * `.claude/workflows/` 에만 저장됨), forgen 은 철학을 인코딩한 canonical 템플릿을
 * `assets/claude/workflows/*.js` 로 동봉한다. 이 명령이 그것을 사용자의
 * `.claude/workflows/` 로 복사한다 → `/<name>` 으로 실행 가능.
 *
 * forgen-verify 에이전트(verify 스테이지용)는 플러그인 `agents` 키로 자동 배포되므로
 * 별도 설치가 필요 없다.
 *
 *   forgen workflows install            ~/.claude/workflows/ (개인, 모든 프로젝트)
 *   forgen workflows install --project  <cwd>/.claude/workflows/ (저장소 공유)
 *   forgen workflows list               동봉 템플릿 + 설치 여부
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const isTTY = process.stdout.isTTY;
const C = {
  reset: isTTY ? '\x1b[0m' : '',
  bold: isTTY ? '\x1b[1m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  green: isTTY ? '\x1b[32m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
};

/** forgen pkg root 의 assets/claude/workflows 디렉토리. invoke-agent 와 동일 walk-up. */
export function findTemplatesDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const pkgJson = path.join(dir, 'package.json');
    if (fs.existsSync(pkgJson)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf-8'));
        if (pkg.name === '@wooojin/forgen') {
          const candidate = path.join(dir, 'assets', 'claude', 'workflows');
          if (fs.existsSync(candidate)) return candidate;
        }
      } catch { /* fallthrough */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('forgen workflows: pkg root + assets/claude/workflows/ not found');
}

/** 템플릿 파일명(.js) 목록. 실패 시 []. */
export function listTemplates(templatesDir: string): string[] {
  try {
    return fs.readdirSync(templatesDir).filter((f) => f.endsWith('.js')).sort();
  } catch {
    return [];
  }
}

export interface InstallResult {
  installed: string[];
  targetDir: string;
}

/** 템플릿을 targetDir 로 복사 (DI — 테스트 주입용). 기존 파일은 덮어쓴다. */
export function installWorkflows(templatesDir: string, targetDir: string): InstallResult {
  fs.mkdirSync(targetDir, { recursive: true });
  const installed: string[] = [];
  for (const file of listTemplates(templatesDir)) {
    fs.copyFileSync(path.join(templatesDir, file), path.join(targetDir, file));
    installed.push(file);
  }
  return { installed, targetDir };
}

function resolveTargetBase(projectScope: boolean): string {
  return projectScope ? process.cwd() : os.homedir();
}

export async function handleWorkflows(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';
  const projectScope = args.includes('--project');

  let templatesDir: string;
  try {
    templatesDir = findTemplatesDir();
  } catch {
    console.log(`\n  ${C.dim}워크플로우 템플릿을 찾을 수 없습니다 (forgen 설치 확인).${C.reset}\n`);
    process.exitCode = 1;
    return;
  }

  if (sub === 'install') {
    const targetDir = path.join(resolveTargetBase(projectScope), '.claude', 'workflows');
    const { installed } = installWorkflows(templatesDir, targetDir);
    if (installed.length === 0) {
      console.log(`\n  ${C.dim}동봉된 템플릿이 없습니다.${C.reset}\n`);
      return;
    }
    console.log(`\n  ${C.green}✓${C.reset} ${installed.length} workflow templates → ${C.cyan}${targetDir}${C.reset}`);
    for (const f of installed) console.log(`      /${f.replace(/\.js$/, '')}`);
    console.log(`\n  ${C.dim}Claude Code 에서 /<name> 으로 실행. verify 스테이지는 forgen-verify 에이전트 사용.${C.reset}\n`);
    return;
  }

  if (sub === 'list') {
    const templates = listTemplates(templatesDir);
    const homeDir = path.join(os.homedir(), '.claude', 'workflows');
    const projDir = path.join(process.cwd(), '.claude', 'workflows');
    console.log(`\n  ${C.bold}forgen workflow templates${C.reset}\n`);
    for (const f of templates) {
      const name = f.replace(/\.js$/, '');
      const inHome = fs.existsSync(path.join(homeDir, f));
      const inProj = fs.existsSync(path.join(projDir, f));
      const where = [inHome && 'user', inProj && 'project'].filter(Boolean).join('+') || 'not installed';
      console.log(`    ${inHome || inProj ? C.green + '✓' + C.reset : C.dim + '·' + C.reset} /${name}  ${C.dim}(${where})${C.reset}`);
    }
    console.log(`\n  ${C.dim}install: forgen workflows install [--project]${C.reset}\n`);
    return;
  }

  console.log(`
  ${C.bold}forgen workflows${C.reset} — dynamic-workflow 템플릿 (ADR-009 §3)

  Usage:
    forgen workflows install [--project]   템플릿을 .claude/workflows/ 로 복사
    forgen workflows list                  동봉 템플릿 + 설치 여부
`);
}
