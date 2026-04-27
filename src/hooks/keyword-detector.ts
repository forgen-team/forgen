#!/usr/bin/env node
/**
 * Forgen — Keyword Detector Hook
 *
 * Claude Code UserPromptSubmit 훅으로 등록.
 * 사용자 프롬프트에서 매직 키워드를 감지하여 해당 스킬을 주입합니다.
 *
 * stdin: JSON { prompt: string, ... }
 * stdout: JSON { result: "block"|"approve", message?: string }
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../core/logger.js';

const log = createLogger('keyword-detector');
import { readStdinJSON } from './shared/read-stdin.js';
import { isHookEnabled } from './hook-config.js';
import { truncateContent, INJECTION_CAPS } from './shared/injection-caps.js';
import { sanitizeForDetection } from './shared/sanitize.js';
// v1: prompt-learner (regex 선호 감지) 제거 — Evidence 기반으로 전환
// v1: pack-config (레거시 팩) 제거 — quality/autonomy pack으로 전환
import { ALL_MODES, FORGEN_HOME, ME_DIR, PACKS_DIR, STATE_DIR } from '../core/paths.js';
import { atomicWriteJSON } from './shared/atomic-write.js';
import { escapeAllXmlTags } from './prompt-injection-filter.js';
import { getSkillConflicts } from '../core/plugin-detector.js';
import { approve, approveWithContext, failOpenWithTracking } from './shared/hook-response.js';
import { recordHookTiming } from './shared/hook-timing.js';

/** Escape a string for safe use in XML attribute values */
function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface HookInput {
  prompt: string;
  session_id?: string;
  cwd?: string;
}

export interface KeywordMatch {
  type: 'skill' | 'inject' | 'cancel';
  keyword: string;
  skill?: string;
  prompt?: string;
  message?: string;
}

const WORKFLOW_TRACKED_INJECTS = new Set<string>();

export function shouldTrackWorkflowActivation(match: KeywordMatch): boolean {
  if (match.type === 'inject') return WORKFLOW_TRACKED_INJECTS.has(match.keyword);
  return match.type === 'skill';
}

// sanitizeForDetection은 shared/sanitize.ts에서 import

// ── 키워드 우선순위 (높은 것부터) ──
// "team", "analyze" 등 일상어와 겹치는 키워드는 명시적 접두어 필요

export const KEYWORD_PATTERNS: Array<{
  pattern: RegExp;
  keyword: string;
  type: 'skill' | 'inject' | 'cancel';
  skill?: string;
}> = [
  // 취소 — cancel-ralph 등 복합 취소를 단일 키워드보다 먼저 매칭
  { pattern: /\b(cancelforgen|stopforgen|cancel[- ]?compound)\b/i, keyword: 'cancel', type: 'cancel' },
  { pattern: /\bcancel[- ]?ralph\b|랄프\s*(?:취소|중단|종료|멈춰)/i, keyword: 'cancel-ralph', type: 'cancel' },

  // 핵심 모드 — ralph는 명시적 모드 호출만 매칭 (false positive 방지)
  { pattern: /(?:^|\n)\s*ralph\s*$|ralph\s+(?:mode|모드|해|해줘|시작|실행)/im, keyword: 'ralph', type: 'skill', skill: 'ralph' },
  { pattern: /\bautopilot\b/i, keyword: 'autopilot', type: 'skill', skill: 'autopilot' },
  { pattern: /(?:\bteam[- ]?mode\b|(?:^|\s)--team\b)/i, keyword: 'team', type: 'skill', skill: 'team' },

  // 확장 모드
  { pattern: /\b(ulw|ultrawork)\b/i, keyword: 'ultrawork', type: 'skill', skill: 'ultrawork' },
  { pattern: /\bccg\b/i, keyword: 'ccg', type: 'skill', skill: 'ccg' },
  { pattern: /\bralplan\b/i, keyword: 'ralplan', type: 'skill', skill: 'ralplan' },
  { pattern: /\bdeep[- ]?interview\b/i, keyword: 'deep-interview', type: 'skill', skill: 'deep-interview' },
  { pattern: /\bpipeline\b/i, keyword: 'pipeline', type: 'skill', skill: 'pipeline' },

  // 인젝션 모드
  { pattern: /\bultrathink\b/i, keyword: 'ultrathink', type: 'inject' },
  { pattern: /\bdeepsearch\b/i, keyword: 'deepsearch', type: 'inject' },
  { pattern: /(?:code[- ]?review|코드\s*리뷰)\s*(?:해|해줘|시작|해봐|부탁|mode|모드)/i, keyword: 'code-review', type: 'skill', skill: 'code-review' },

  // forgen 핵심 스킬
  { pattern: /\b(forge[- ]?loop|포지[- ]?루프)\b|(?:^|\s)(끝까지|don'?t\s*stop)(?:\s|$)/im, keyword: 'forge-loop', type: 'skill', skill: 'forge-loop' },
  { pattern: /(?:^|\s)ship(?:\s|$)|(?:^|\s)(배포|릴리스)\s*(?:해|해줘|하자|시작|진행)/im, keyword: 'ship', type: 'skill', skill: 'ship' },
  { pattern: /\bretro\b|(?:^|\s)(회고|돌아보기)(?:\s|$)/im, keyword: 'retro', type: 'skill', skill: 'retro' },
  { pattern: /(?:^|\s)learn\s+(?:search|prune|stats|export)|(?:^|\s)(학습\s*관리|compound\s*정리|솔루션\s*정리)/im, keyword: 'learn', type: 'skill', skill: 'learn' },
  { pattern: /\bcalibrate\b|(?:^|\s)(캘리브|프로필\s*보정|프로필\s*조정|프로필\s*확인)(?:\s|$)/im, keyword: 'calibrate', type: 'skill', skill: 'calibrate' },
];

// ── 인젝션 메시지 ──

const INJECT_MESSAGES: Record<string, string> = {
  ultrathink: `<compound-think-mode>
EXTENDED THINKING MODE ACTIVATED.
Before responding, engage in deep, thorough reasoning. Consider multiple approaches,
evaluate trade-offs, and explore edge cases. Your thinking should be comprehensive
and rigorous. Take your time — quality over speed.
</compound-think-mode>`,

  deepsearch: `<compound-deepsearch>
DEEP SEARCH MODE ACTIVATED.
Perform comprehensive codebase exploration before answering:
1. Use Glob to map the full directory structure
2. Use Grep to find all relevant patterns and references
3. Read key files to understand architecture
4. Cross-reference findings across files
5. Present a complete, evidence-based analysis
</compound-deepsearch>`,

};

// ── 스킬 파일 로드 ──

function loadSkillContent(skillName: string): string | null {
  // 스킬 파일 검색 순서: 프로젝트 .forgen > 프로젝트 .compound > 팩 > 개인 > 글로벌 > 패키지 내장
  const searchPaths = [
    path.join(process.cwd(), '.forgen', 'skills', `${skillName}.md`),
    path.join(process.cwd(), '.compound', 'skills', `${skillName}.md`),
    path.join(process.cwd(), 'skills', `${skillName}.md`),
  ];

  // v1: 레거시 팩 스킬 검색은 제거. PACKS_DIR 하위 스킬은 직접 탐색.
  try {
    if (fs.existsSync(PACKS_DIR)) {
      for (const entry of fs.readdirSync(PACKS_DIR)) {
        const packSkillPath = path.join(PACKS_DIR, entry, 'skills', `${skillName}.md`);
        searchPaths.push(packSkillPath);
      }
    }
  } catch {
    // 팩 디렉토리 접근 실패 시 무시
  }

  // 사용자 개인 스킬 경로
  searchPaths.push(path.join(ME_DIR, 'skills', `${skillName}.md`));

  // 글로벌 스킬 경로
  searchPaths.push(path.join(FORGEN_HOME, 'skills', `${skillName}.md`));

  // forgen 패키지 내장 스킬
  const pkgSkillPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', '..', 'assets', 'claude', 'commands', `${skillName}.md`
  );
  searchPaths.push(pkgSkillPath);

  for (const p of searchPaths) {
    if (fs.existsSync(p)) {
      // Security: symlink을 통한 임의 파일 읽기 방지
      try { if (fs.lstatSync(p).isSymbolicLink()) continue; } catch { continue; }
      return fs.readFileSync(p, 'utf-8');
    }
  }
  return null;
}

// ── 키워드 감지 ──

export function detectKeyword(prompt: string): KeywordMatch | null {
  // 코드 블록, URL, XML 태그 등을 제거한 순수 텍스트에서만 감지
  const sanitized = sanitizeForDetection(prompt);
  const lower = sanitized.toLowerCase();

  for (const entry of KEYWORD_PATTERNS) {
    if (entry.pattern.test(lower)) {
      // entry.keyword의 RegExp 특수문자를 이스케이프하여 안전하게 사용
      const escapedKeyword = entry.keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // g 플래그 제거: 첫 번째 매치만 제거하여 코드블록 내 동일 키워드 보존
      const extractedPrompt = prompt.replace(new RegExp(`\\b${escapedKeyword}\\b`, 'i'), '').trim();

      if (entry.type === 'cancel') {
        return { type: 'cancel', keyword: entry.keyword, message: '[Forgen] Mode cancelled.' };
      }

      if (entry.type === 'inject') {
        return {
          type: 'inject',
          keyword: entry.keyword,
          message: INJECT_MESSAGES[entry.keyword] ?? '',
        };
      }

      return {
        type: 'skill',
        keyword: entry.keyword,
        skill: entry.skill,
        prompt: extractedPrompt,
      };
    }
  }

  return null;
}

// ── 상태 관리 ──

function saveState(key: string, data: unknown): void {
  atomicWriteJSON(path.join(STATE_DIR, `${key}.json`), data);
}

function clearState(key: string): void {
  const p = path.join(STATE_DIR, `${key}.json`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

/** skill-cache 파일 모두 정리 */
function cleanSkillCaches(): void {
  if (!fs.existsSync(STATE_DIR)) return;
  try {
    for (const f of fs.readdirSync(STATE_DIR)) {
      if (f.startsWith('skill-cache-')) {
        fs.unlinkSync(path.join(STATE_DIR, f));
      }
    }
  } catch (e) { log.debug('skill-cache 파일 삭제 실패', e); }
}

// ── 메인 ──

async function main(): Promise<void> {
  const _hookStart = Date.now();
  try {
  const input = await readStdinJSON<HookInput>();
  if (!isHookEnabled('keyword-detector')) {
    console.log(approve());
    return;
  }
  if (!input?.prompt) {
    console.log(approve());
    return;
  }

  const match = detectKeyword(input.prompt);
  const sessionId = input.session_id ?? 'unknown';

  // v1: regex 기반 prompt 학습 제거. Evidence 기반으로 전환됨.

  if (!match) {
    console.log(approve());
    return;
  }

  // Cache conflict map once for the duration of this hook execution
  const skillConflicts = getSkillConflicts(input.cwd ?? process.env.FORGEN_CWD ?? process.env.COMPOUND_CWD ?? process.cwd());

  if (match.type === 'cancel') {
    const cancelCwd = input.cwd ?? process.env.FORGEN_CWD ?? process.env.COMPOUND_CWD ?? process.cwd();

    if (match.keyword === 'cancel-ralph') {
      // ralph만 취소
      clearState('ralph-state');
      const ralphLoopState = path.join(cancelCwd, '.claude', 'ralph-loop.local.md');
      try { fs.unlinkSync(ralphLoopState); } catch { /* 파일 없으면 무시 */ }
    } else {
      // 모든 모드 상태 초기화 (ralplan, deep-interview, forge-loop 등 포함)
      for (const mode of ALL_MODES) {
        clearState(`${mode}-state`);
      }
      const ralphLoopState = path.join(cancelCwd, '.claude', 'ralph-loop.local.md');
      try { fs.unlinkSync(ralphLoopState); } catch { /* 파일 없으면 무시 */ }
      // forge-loop 상태 파일도 명시적으로 삭제 (Stop 훅 차단 해제)
      const forgeLoopState = path.join(STATE_DIR, 'forge-loop.json');
      try { fs.unlinkSync(forgeLoopState); } catch { /* 파일 없으면 무시 */ }
    }
    // skill-cache 파일도 정리 (재주입 가능하도록)
    cleanSkillCaches();
    console.log(approveWithContext(match.message ?? '[Forgen] Mode cancelled.', 'UserPromptSubmit'));
    return;
  }

  if (match.type === 'inject') {
    // Plugin conflict check: inject 타입도 다른 플러그인과 충돌하면 스킵
    // (tdd, code-review 등이 OMC/superpowers와 이중 실행되는 것을 방지)
    const conflictPlugin = skillConflicts.get(match.keyword);
    if (conflictPlugin) {
      log.debug(`Skipping inject "${match.keyword}" — provided by ${conflictPlugin}`);
      console.log(approve());
      return;
    }
    if (shouldTrackWorkflowActivation(match)) {
      try { /* v1: recordModeUsage 제거 */ } catch { /* noop */ }
    }
    console.log(approveWithContext(match.message ?? `[Forgen] ${match.keyword} mode activated.`, 'UserPromptSubmit'));
    return;
  }

  // 스킬 주입
  if (match.skill) {
    // Plugin conflict check: if a plugin already provides this skill, skip injection
    const conflictPlugin = skillConflicts.get(match.skill);
    if (conflictPlugin) {
      log.debug(`Skipping keyword "${match.keyword}" — skill provided by ${conflictPlugin}`);
      console.log(approve());
      return;
    }
    // Compound: mode usage 기록
    // v1: recordModeUsage 제거
    const skillContent = loadSkillContent(match.skill);
    const effectiveCwd = input.cwd ?? process.env.FORGEN_CWD ?? process.env.COMPOUND_CWD ?? process.cwd();

    // 상태 저장
    saveState(`${match.skill}-state`, {
      active: true,
      startedAt: new Date().toISOString(),
      prompt: match.prompt,
      sessionId: input.session_id,
    });

    // ralph 스킬 활성화 시 ralph-loop 플러그인 상태 파일도 생성
    if (match.skill === 'ralph') {
      const ralphLoopDir = path.join(effectiveCwd, '.claude');
      const ralphLoopState = path.join(ralphLoopDir, 'ralph-loop.local.md');
      fs.mkdirSync(ralphLoopDir, { recursive: true });
      const frontmatter = [
        '---',
        'active: true',
        'iteration: 1',
        `session_id: ${input.session_id ?? ''}`,
        'max_iterations: 0',
        'completion_promise: "TASK COMPLETE"',
        `started_at: "${new Date().toISOString()}"`,
        '---',
        '',
        match.prompt ?? input.prompt,
      ].join('\n');
      fs.writeFileSync(ralphLoopState, frontmatter);
    }

    if (skillContent) {
      const truncatedContent = truncateContent(skillContent, INJECTION_CAPS.skillContentMax);
      console.log(approveWithContext(`<compound-skill name="${escapeXmlAttr(match.skill)}">\n${escapeAllXmlTags(truncatedContent)}\n</compound-skill>\n\nUser request: ${match.prompt}`, 'UserPromptSubmit'));
    } else {
      console.log(approveWithContext(`[Forgen] ${match.keyword} mode activated.\n\nUser request: ${match.prompt}`, 'UserPromptSubmit'));
    }
    return;
  }

  console.log(approve());
  } finally {
    recordHookTiming('keyword-detector', Date.now() - _hookStart, 'UserPromptSubmit');
  }
}

// ESM main guard: 다른 모듈에서 import 시 main() 실행 방지
// realpathSync로 symlink 해석 (플러그인 캐시가 symlink일 때 경로 불일치 방지)
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[ch-hook] ${e instanceof Error ? e.message : String(e)}\n`);
    console.log(failOpenWithTracking('keyword-detector', e));
  });
}
