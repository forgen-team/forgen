/**
 * forgen project — 프로젝트 키 등록부 (0.8.0 S3)
 *   forgen project add <키> <폴더...> [--alias a,b | --alias a --alias b]   폴더를 키로 묶는다(git 아닌 폴더도 됨)
 *   forgen project list                              등록된 키, 폴더, 별칭, 없는 폴더
 *   forgen project remove <키>
 *   forgen project which [폴더]                      그 폴더가 어느 키로 풀리는지
 */
import * as path from 'node:path';
import { addProjectPaths, missingRegistryPaths, PROJECT_REGISTRY_PATH, readProjectRegistry, removeProject } from '../store/project-registry.js';
import { projectKeyFor } from '../store/rule-scope.js';

function usage(): void {
  console.log(`Usage:
  forgen project add <key> <folder...> [--alias old-key,...]
  forgen project list
  forgen project remove <key>
  forgen project which [folder]`);
}

export function handleProject(args: string[]): void {
  const [sub, ...rest] = args;
  if (sub === 'add') {
    // --alias 는 여러 번(--alias a --alias b) 또는 쉼표(--alias a,b)로. 값이 빠진 --alias 는 오류 —
    // 예전에는 두 번째 --alias 의 값이 조용히 폴더 인자로 들어갔다.
    const aliases: string[] = [];
    const pos: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--alias' || a.startsWith('--alias=')) {
        const v = a === '--alias' ? rest[++i] : a.slice('--alias='.length);
        if (!v || v.startsWith('--')) { console.error('[forgen] --alias 뒤에 별칭이 필요합니다'); usage(); process.exitCode = 1; return; }
        aliases.push(...v.split(',').map((s) => s.trim()).filter(Boolean));
      } else if (a.startsWith('--')) {
        console.error(`[forgen] 알 수 없는 옵션: ${a}`); usage(); process.exitCode = 1; return;
      } else pos.push(a);
    }
    const [key, ...dirs] = pos;
    if (!key || dirs.length === 0) { usage(); process.exitCode = 1; return; }
    try {
      const reg = addProjectPaths(key, dirs, aliases);
      const e = reg.projects[key.toLowerCase()];
      console.log(`✓ [forgen] ${key.toLowerCase()}: ${e.paths.join(', ')}${e.aliases?.length ? `  (별칭: ${e.aliases.join(', ')})` : ''}`);
    } catch (err) { console.error(`[forgen] ${(err as Error).message}`); process.exitCode = 1; }
    return;
  }
  if (sub === 'list') {
    const reg = readProjectRegistry();
    const keys = Object.keys(reg.projects);
    if (!keys.length) { console.log(`등록된 프로젝트 키 없음 (${PROJECT_REGISTRY_PATH}). git 저장소 폴더 이름으로 판정합니다.`); return; }
    const missing = new Set(missingRegistryPaths().map((m) => m.path));
    for (const k of keys) {
      const e = reg.projects[k];
      console.log(`${k}${e.aliases?.length ? `  (별칭: ${e.aliases.join(', ')})` : ''}`);
      for (const p of e.paths) console.log(`  ${p}${missing.has(p) ? '  ⚠ 없음' : ''}`);
    }
    return;
  }
  if (sub === 'remove') {
    if (!rest[0]) { usage(); process.exitCode = 1; return; }
    console.log(removeProject(rest[0].toLowerCase()) ? `✓ [forgen] ${rest[0]} 삭제` : `[forgen] ${rest[0]} 없음`);
    return;
  }
  if (sub === 'which') {
    const dir = path.resolve(rest[0] ?? process.cwd());
    console.log(`${dir} → ${projectKeyFor(dir) ?? '(프로젝트 아님)'}`);
    return;
  }
  usage();
  if (sub) process.exitCode = 1;
}
