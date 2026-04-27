/**
 * Installer — Agent definitions + slash command installation
 *
 * Extracted from harness.ts (B9 decomposition).
 * Handles copying agent .md files and skill commands into Claude Code directories.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLogger } from './logger.js';
import { STATE_DIR } from './paths.js';

const log = createLogger('installer');

// ── Agent Installation ──

function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
}

const AGENT_HASHES_PATH = path.join(STATE_DIR, 'agent-hashes.json');

function loadAgentHashes(): Record<string, string> {
  try {
    if (fs.existsSync(AGENT_HASHES_PATH)) {
      return JSON.parse(fs.readFileSync(AGENT_HASHES_PATH, 'utf-8'));
    }
  } catch (e) {
    log.debug('에이전트 해시 맵 로드 실패', e);
  }
  return {};
}

function saveAgentHashes(hashes: Record<string, string>): void {
  try {
    fs.mkdirSync(path.dirname(AGENT_HASHES_PATH), { recursive: true });
    fs.writeFileSync(AGENT_HASHES_PATH, JSON.stringify(hashes, null, 2));
  } catch (e) {
    log.debug('에이전트 해시 맵 저장 실패', e);
  }
}

function installAgentsFromDir(
  sourceDir: string,
  targetDir: string,
  prefix: string,
  hashes: Record<string, string>,
): void {
  if (!fs.existsSync(sourceDir)) return;

  const files = fs.readdirSync(sourceDir).filter((f) => f.endsWith('.md'));
  for (const file of files) {
    const src = path.join(sourceDir, file);
    const dstName = `${prefix}${file}`;
    const dst = path.join(targetDir, dstName);
    const content = fs.readFileSync(src, 'utf-8');
    const newHash = contentHash(content);

    if (fs.existsSync(dst)) {
      const existing = fs.readFileSync(dst, 'utf-8');
      if (existing === content) {
        hashes[dstName] = newHash;
        continue;
      }
      const recordedHash = hashes[dstName];
      if (recordedHash && contentHash(existing) !== recordedHash) {
        log.debug(`에이전트 파일 보호: ${dstName} (사용자 수정 감지)`);
        continue;
      }
      if (!recordedHash && !existing.includes('<!-- forgen-managed -->')) {
        log.debug(`에이전트 파일 보호: ${dstName} (레거시 사용자 수정 감지)`);
        continue;
      }
    }

    fs.writeFileSync(dst, content);
    hashes[dstName] = newHash;
  }
}

/**
 * 현재 source에 없는 stale ch-*.md 에이전트 파일을 정리.
 * forgen-managed 마커가 있는 파일만 삭제 (사용자 수정 파일 보호).
 */
function cleanupStaleAgents(
  sourceDir: string,
  targetDir: string,
  prefix: string,
  hashes: Record<string, string>,
): void {
  if (!fs.existsSync(targetDir)) return;
  if (!fs.existsSync(sourceDir)) return;

  const validFiles = new Set(
    fs
      .readdirSync(sourceDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => `${prefix}${f}`),
  );

  for (const existing of fs.readdirSync(targetDir)) {
    if (!existing.startsWith(prefix) || !existing.endsWith('.md')) continue;
    if (validFiles.has(existing)) continue;

    const filePath = path.join(targetDir, existing);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const recordedHash = hashes[existing];
      const hasMarker = content.includes('<!-- forgen-managed -->');
      if (!hasMarker) {
        log.debug(`에이전트 삭제 스킵: ${existing} (forgen-managed 마커 없음)`);
        continue;
      }
      if (recordedHash && contentHash(content) !== recordedHash) {
        log.debug(`에이전트 삭제 스킵: ${existing} (사용자 수정 감지)`);
        continue;
      }
      fs.unlinkSync(filePath);
      delete hashes[existing];
      log.debug(`stale 에이전트 삭제: ${existing}`);
    } catch (e) {
      log.debug(`에이전트 삭제 실패: ${existing}`, e);
    }
  }
}

/** 에이전트 정의 파일 설치 (패키지 내장만) */
export function installAgents(cwd: string, pkgRoot: string): void {
  const targetDir = path.join(cwd, '.claude', 'agents');
  fs.mkdirSync(targetDir, { recursive: true });

  const hashes = loadAgentHashes();
  const sourceDir = path.join(pkgRoot, 'assets', 'claude', 'agents');
  try {
    installAgentsFromDir(sourceDir, targetDir, 'ch-', hashes);
    cleanupStaleAgents(sourceDir, targetDir, 'ch-', hashes);
    saveAgentHashes(hashes);
  } catch (e) {
    log.debug('에이전트 설치 실패', e);
  }
}

// ── Slash Commands ──

function buildCommandContent(skillContent: string, skillName: string): string {
  const descMatch = skillContent.match(/description:\s*(.+)/);
  const desc = descMatch?.[1]?.trim() ?? skillName;
  return `# ${desc}\n\n<!-- forgen-managed -->\n\nActivate Forgen "${skillName}" mode for the task: $ARGUMENTS\n\n${skillContent}`;
}

function safeWriteCommand(cmdPath: string, content: string): boolean {
  if (fs.existsSync(cmdPath)) {
    const existing = fs.readFileSync(cmdPath, 'utf-8');
    if (!existing.includes('<!-- forgen-managed -->')) return false;
  }
  fs.writeFileSync(cmdPath, content);
  return true;
}

function cleanupStaleCommands(commandsDir: string, validFiles: Set<string>): number {
  if (!fs.existsSync(commandsDir)) return 0;
  let removed = 0;
  for (const file of fs.readdirSync(commandsDir).filter((f) => f.endsWith('.md'))) {
    if (validFiles.has(file)) continue;
    const filePath = path.join(commandsDir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content.includes('<!-- forgen-managed -->')) {
        fs.unlinkSync(filePath);
        removed++;
      }
    } catch (e) {
      log.debug(`stale 명령 파일 정리 실패: ${file}`, e);
    }
  }
  return removed;
}

/** 스킬을 Claude Code 슬래시 명령으로 설치 (패키지 내장만) */
export function installSlashCommands(_cwd: string, pkgRoot: string): void {
  let skillsDir = path.join(pkgRoot, 'assets', 'claude', 'commands');
  if (!fs.existsSync(skillsDir)) {
    skillsDir = path.join(pkgRoot, 'skills');
  }
  const homeDir = os.homedir();
  const globalCommandsDir = path.join(homeDir, '.claude', 'commands', 'forgen');

  if (!fs.existsSync(skillsDir)) return;
  fs.mkdirSync(globalCommandsDir, { recursive: true });

  const skills = fs.readdirSync(skillsDir).filter((f) => f.endsWith('.md'));
  const validGlobalFiles = new Set<string>();
  let installed = 0;

  for (const file of skills) {
    validGlobalFiles.add(file);
    const skillName = file.replace('.md', '');
    const skillContent = fs.readFileSync(path.join(skillsDir, file), 'utf-8');
    const cmdContent = buildCommandContent(skillContent, skillName);
    if (safeWriteCommand(path.join(globalCommandsDir, file), cmdContent)) {
      installed++;
    }
  }

  const removedGlobal =
    validGlobalFiles.size > 0 ? cleanupStaleCommands(globalCommandsDir, validGlobalFiles) : 0;

  log.debug(`슬래시 명령 설치: ${installed}개 설치, ${removedGlobal}개 정리`);
}
