#!/usr/bin/env node
/**
 * Forgen — Auto Compound Runner
 *
 * Detached process로 실행. 이전 세션의 transcript를 분석하여:
 * 1. 재사용 가능한 솔루션 추출 (compound --solution)
 * 2. 사용자 패턴을 USER.md에 축적
 *
 * 호출: session-recovery hook 또는 spawn.ts에서 detached spawn
 * 인자: [cwd] [transcriptPath] [sessionId]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execFile, type ExecFileSyncOptions, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { createRequire } from 'node:module';
import { containsPromptInjection, filterSolutionContent } from '../hooks/prompt-injection-filter.js';
import { isSelfReferentialEcho } from './config-injector.js';
import { redactSecrets } from '../hooks/secret-filter.js';
import { stripPrivate } from '../engine/private-filter.js';
import { createEvidence, saveEvidence, promoteSessionCandidates } from '../store/evidence-store.js';
import { isHaikuCompoundEnabled, getHaikuConsentState } from './compound-consent.js';
import { digestTranscriptFile, renderDigest } from './transcript-summary.js';
import { getCursor, setCursor, markRun, enqueue, claimDue, completeEntry, acquireRunnerLock, releaseRunnerLock, transcriptSignature, resetIfReplaced, getDonePhases, setDonePhases, type Phase } from './extraction-queue.js';
import { releaseAutoCompoundInflight } from './spawn.js';
import { projectKeyFor } from '../store/rule-scope.js';
import { reopenIfReExtracted } from '../engine/compound-lifecycle.js';
import { callHaiku, probeClaudeAvailability, writeHaikuStatus, appendExtractionEvent } from './extraction-haiku.js';
import { loadProfile } from '../store/profile-store.js';
import { FORGEN_HOME, ME_DIR } from './paths.js';
import { rotateIfBig } from '../engine/lifecycle/signals.js';
import { classifyBehaviorKind, mapKindToAxisRefs } from './behavior-classifier.js';
import type { HostId } from './trust-layer-intent.js';

export async function execClaudeRetryAsync(args: string[], opts: ExecFileOptions): Promise<string> {
  const mod = createRequire(import.meta.url)('../host/exec-host.js') as typeof import('../host/exec-host.js');
  const profileMod = createRequire(import.meta.url)('../store/profile-store.js') as typeof import('../store/profile-store.js');
  const resolved = profileMod.resolveDefaultHost();
  const host: HostId = resolved === 'codex' ? 'codex' : 'claude';

  if (host === 'claude') {
    const TRANSIENT = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE/;
    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const { stdout } = await execFileAsync('claude', mod.withNestedRunClaudeArgs(args), {
          ...opts,
          env: { ...process.env, ...(opts.env ?? {}), ...mod.NESTED_RUN_ENV },
        });
        return typeof stdout === 'string' ? stdout : stdout.toString();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const match = msg.match(TRANSIENT);
        if (attempt < MAX_ATTEMPTS && match) {
          process.stderr.write(
            `[forgen-auto-compound] ${match[0]} on attempt ${attempt}/${MAX_ATTEMPTS}, retrying in 3s (auto-recovery)...\n`,
          );
          await new Promise<void>(resolve => setTimeout(resolve, 3000));
          continue;
        }
        throw e;
      }
    }
    throw new Error('unreachable');
  }

  // codex 분기 (동기 execHost 라 그냥 호출 — 이미 빠름)
  const pIdx = args.indexOf('-p');
  if (pIdx === -1 || !args[pIdx + 1]) {
    throw new Error('execClaudeRetryAsync: codex host requires -p prompt argument');
  }
  const prompt = args[pIdx + 1];
  const modelIdx = args.indexOf('--model');
  const model = modelIdx !== -1 ? args[modelIdx + 1] : undefined;
  const r = mod.execHost({
    prompt, model, host: 'codex',
    timeout: typeof opts.timeout === 'number' ? opts.timeout : 60000,
    cwd: typeof opts.cwd === 'string' ? opts.cwd : undefined,
  });
  return r.message;
}

const [,, cwd, transcriptPath, sessionId] = process.argv;

if (!cwd || !transcriptPath || !sessionId) {
  try { appendExtractionEvent({ ok: false, sessionId: String(sessionId ?? ''), error: 'missing-args (cwd/transcript/session)' }); } catch { /* 기록 실패는 무시 */ }
  process.exit(1);
}

/** 추출 없이 일찍 끝나는 경로도 사유와 함께 남긴다 — status 가 "실행은 됐는데 입력이 부족했다"를 "실행 안 됨"과 구분한다. */
function exitSkipped(reason: string): never {
  try { appendExtractionEvent({ ok: true, skipped: reason, sessionId: String(sessionId) }); } catch { /* 기록 실패는 무시 */ }
  process.exit(0);
}

// ── 세션별 러너 락: 같은 세션을 두 러너가 동시에 처리해 Haiku 를 두 번 부르거나 솔루션을 중복 저장하지 않게 한다. ──
// spawn 쪽 in-flight 표식(TTL)은 시작 시점 게이트일 뿐이다. 러너 자신이 잡는 락이 최종 방어선이고, 종료 시 락과 표식을 함께 푼다.
if (transcriptPath !== '-') {
  let locked = false;
  try { locked = acquireRunnerLock(String(sessionId)); } catch { locked = true; /* 락 인프라 실패는 막지 않는다(fail-open) */ }
  if (!locked) exitSkipped('runner-locked');
  process.on('exit', () => {
    try { releaseRunnerLock(String(sessionId)); } catch { /* 무시 */ }
    try { releaseAutoCompoundInflight(String(sessionId)); } catch { /* 무시 */ }
  });
}

const SOLUTIONS_DIR = path.join(ME_DIR, 'solutions');
const BEHAVIOR_DIR = path.join(ME_DIR, 'behavior');

/** Lightweight quality gate for auto-extracted solution files */
/** Toxicity patterns — code-context only to avoid false positives on prose */
const SOLUTION_TOXICITY_PATTERNS = [/@ts-ignore/i, /:\s*any\b/, /\/\/\s*TODO\b/];

/** Parse tags from solution frontmatter */
function parseTags(content: string): string[] {
  const match = content.match(/tags:\s*\[([^\]]*)\]/);
  if (!match) return [];
  return match[1].split(',').map(t => t.trim().replace(/"/g, '').replace(/'/g, '')).filter(Boolean);
}

/** Gate 3 (dedup): check tag overlap with existing solutions */
function findDuplicate(newContent: string, existingFiles: Map<string, string>): string | null {
  const newTags = parseTags(newContent);
  if (newTags.length === 0) return null;
  for (const [file, existingContent] of existingFiles) {
    const existingTags = parseTags(existingContent);
    if (existingTags.length === 0) continue;
    const overlap = newTags.filter(t => existingTags.includes(t));
    const overlapRatio = overlap.length / Math.max(newTags.length, existingTags.length, 1);
    if (overlapRatio >= 0.7) return file;
  }
  return null;
}

function validateSolutionFiles(dirBefore: Set<string>): number {
  let removed = 0;
  if (!fs.existsSync(SOLUTIONS_DIR)) return removed;
  try {
    // Load existing solutions for dedup (gate 3)
    const existingSolutions = new Map<string, string>();
    for (const file of dirBefore) {
      try {
        existingSolutions.set(file, fs.readFileSync(path.join(SOLUTIONS_DIR, file), 'utf-8'));
      } catch { /* skip unreadable */ }
    }

    const currentFiles = fs.readdirSync(SOLUTIONS_DIR).filter(f => f.endsWith('.md'));
    for (const file of currentFiles) {
      if (dirBefore.has(file)) continue; // existed before extraction — skip
      const filePath = path.join(SOLUTIONS_DIR, file);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        // Gate 1: file must be > 100 chars (not too short)
        if (content.length <= 100) {
          fs.unlinkSync(filePath);
          removed++;
          continue;
        }
        // Gate 2: first 500 chars must not contain toxicity patterns
        const head = content.slice(0, 500);
        if (SOLUTION_TOXICITY_PATTERNS.some(p => p.test(head))) {
          fs.unlinkSync(filePath);
          removed++;
          continue;
        }
        // Gate 3: dedup — reject if 70%+ tag overlap with existing solutions
        const dupOf = findDuplicate(content, existingSolutions);
        if (dupOf) {
          // 중복 상대가 은퇴한 솔루션이면 (D6): 내용이 비슷할 때만 복귀시키고 새 추출은 버린다.
          // 태그만 겹치고 내용이 다르면 새 추출을 버리지 않는다 (은퇴본은 매칭에서 빠져 있으므로 공존해도 된다).
          const dupName = path.basename(dupOf, '.md');
          let outcome: ReturnType<typeof reopenIfReExtracted> = 'none';
          try { outcome = reopenIfReExtracted(dupName, content); } catch { /* 무시 */ }
          if (outcome === 'different') {
            existingSolutions.set(file, content);
            continue;
          }
          fs.unlinkSync(filePath);
          removed++;
          if (outcome === 'reopened') process.stderr.write(`[forgen-auto-compound] reopened retired solution: ${dupOf}\n`);
          continue;
        }
        // Accepted — add to existing pool so subsequent new files dedup against it too
        existingSolutions.set(file, content);
      } catch (e) {
        process.stderr.write(`[forgen-auto-compound] file validation failed: ${(e as Error).message}\n`);
      }
    }
  } catch (e) {
    process.stderr.write(`[forgen-auto-compound] solution dir scan failed: ${(e as Error).message}\n`);
  }
  return removed;
}

/**
 * 기존 behavior 파일에 유사 패턴이 있으면 observedCount를 +1 증가.
 * 유사도는 같은 kind + 내용 키워드 50%+ 겹침으로 판단.
 * 누적했으면 true, 새 파일 필요하면 false 반환.
 */
function mergeOrCreateBehavior(dir: string, newContent: string, kind: string, today: string): boolean {
  if (!fs.existsSync(dir)) return false;

  const newWords = new Set(newContent.toLowerCase().split(/\s+/).filter(w => w.length >= 3));
  if (newWords.size === 0) return false;

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  for (const file of files) {
    const filePath = path.join(dir, file);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      // kind 매칭
      const kindMatch = raw.match(/^kind:\s*["']?(\w+)["']?/m);
      if (!kindMatch || kindMatch[1] !== kind) continue;

      // 내용 유사도 체크
      const existingWords = new Set(raw.toLowerCase().split(/\s+/).filter(w => w.length >= 3));
      let overlap = 0;
      for (const w of newWords) {
        if (existingWords.has(w)) overlap++;
      }
      const similarity = overlap / newWords.size;
      if (similarity < 0.5) continue;

      // 유사 패턴 발견 — observedCount 증가
      const countMatch = raw.match(/^observedCount:\s*(\d+)/m);
      const currentCount = countMatch ? parseInt(countMatch[1], 10) : 1;
      const updated = raw
        .replace(/^observedCount:\s*\d+/m, `observedCount: ${currentCount + 1}`)
        .replace(/^updated:\s*"[^"]*"/m, `updated: "${today}"`)
        .replace(/^confidence:\s*[\d.]+/m, `confidence: ${Math.min(0.95, 0.6 + (currentCount * 0.1)).toFixed(2)}`);
      fs.writeFileSync(filePath, updated);
      return true;
    } catch { }
  }
  return false;
}

// 0.4.6 perf #12 — adaptive cooldown 시그널 (declared early for hoisting).
let userPatternFound = false;

// 추출 이벤트 기록(status 흐름 표시용): Haiku 호출이 실패했는지 마지막에 함께 남긴다.
let haikuError: string | null = null;

const sid = String(sessionId);
/** 6번째 인자 'final' = 세션 종료/이전 세션 복구 경로 → 새 내용이 적어도 Haiku 를 돌린다. Stop(턴 단위)은 새 사용자 발화 3개 미만이면 건너뛴다. */
const isFinal = process.argv[6] === 'final';
const queueOnly = transcriptPath === '-';
const MIN_NEW_USER_MSGS_FOR_PARTIAL = 3;

class SkipExtraction extends Error {
  constructor(public readonly reason: string) { super(reason); }
}

function snapshotSolutions(): Set<string> {
  const s = new Set<string>();
  try {
    if (fs.existsSync(SOLUTIONS_DIR)) {
      for (const f of fs.readdirSync(SOLUTIONS_DIR)) if (f.endsWith('.md')) s.add(f);
    }
  } catch { /* ignore */ }
  return s;
}

/** 이 러너 실행의 솔루션 저장 시 Context 칸에 넣을 출처 (적용 조건은 모델이 준 값과 합친다). */
function solutionContext(condition: string): string {
  const where = path.basename(cwd) || cwd;
  const when = new Date().toISOString().slice(0, 10);
  const src = `출처: ${where} 프로젝트 세션 ${sid.slice(0, 8)} (${when}), auto-compound`;
  return condition ? `${condition}\n\n${src}` : src;
}

// ── 추출 단계 (각각 Haiku 1회). 실패는 PhaseResult 로 돌려주고 대기열/재시도는 호출자가 결정한다. ──
interface PhaseResult { ok: boolean; retriable: boolean; reason?: string; outcome?: string }

const SOLUTION_PROMPT_HEAD = `다음은 Claude Code 세션 대화 요약입니다 (사용자 발화와 어시스턴트 발화만, 시간순. 긴 세션은 교정 지점과 끝부분 위주로 중간이 생략됨).
다음 세션에서 **다른 작업에도 다시 쓸 수 있는** 교훈을 최대 3개 뽑아주세요.

각 항목을 정확히 아래 한 줄 형식으로만 출력하세요 (다른 설명·코드블록 없이):
forgen compound --solution "제목" "본문" "적용 조건" ["범위"]

작성 규칙:
- 제목: 상황을 일반화한 검색 가능한 이름 (예: "react-high-frequency-event-raf-throttle"). 특정 파일·컴포넌트·함수 이름을 제목에 쓰지 말 것.
- 본문: "이런 상황에서는 이렇게 한다" 형식, 150~400자. 행동(무엇을 한다) + 근거(왜) + 주의(깨지는 경우·함정)를 모두 넣을 것.
- 적용 조건: 이 교훈이 해당하는 상황을 한 문장으로.
- 범위(선택): 이 교훈이 이 프로젝트의 구조·관례·도메인에 묶여 있어 다른 프로젝트에서는 맞지 않으면 "이 프로젝트", 어디서나 쓸 수 있으면 생략.
- 근거는 사용자가 교정한 지점, 실패 후 해결한 지점, 판단 기준이 드러난 지점에서 찾을 것.
- 제외: 사용자의 첫 지시나 작업 목표를 그대로 옮겨 적은 것, 이번 세션에서만 의미 있는 진행 상황·일정·파일 목록, 피상적 관찰(예: "TypeScript를 사용함"), 이미 있는 솔루션과 중복.
추출할 것이 없으면 "추출할 패턴 없음"이라고만 답하세요.`;

function phaseSolution(summary: string, attempt: number, sessId: string = sid): PhaseResult {
  let existingList = '';
  const solDir = path.join(FORGEN_HOME, 'me', 'solutions');
  if (fs.existsSync(solDir)) {
    const names = fs.readdirSync(solDir).filter(f => f.endsWith('.md')).map(f => f.replace('.md', '')).slice(-30);
    if (names.length > 0) existingList = `\n\n이미 축적된 솔루션 (중복 추출 금지):\n${names.join(', ')}`;
  }
  const solutionsBefore = snapshotSolutions();
  const r = callHaiku('solution', `${SOLUTION_PROMPT_HEAD}${existingList}\n\n---\n${summary}\n---`, { cwd, attempt, sessionId: sessId });
  if (!r.ok) return { ok: false, retriable: r.retriable, reason: r.reason, outcome: r.outcome };
  const solutionOutput = r.output;

  // 모델 출력에서 `--solution "제목" "본문" ["적용 조건"]` 을 파싱해 forgen 을 직접 실행(결정론적).
  // forgen 은 이 러너와 같은 패키지의 cli.js 를 같은 node 로 직접 호출 — sparse PATH·다른 버전의 전역 forgen 의존 제거.
  const nodeBinDir = path.dirname(process.execPath);
  const cliJs = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
  const solutionArgRe = /--solution\s+"((?:[^"\\]|\\.)+)"\s+"((?:[^"\\]|\\.)+)"(?:\s+"((?:[^"\\]|\\.)*)")?(?:\s+"((?:[^"\\]|\\.)*)")?/g;
  let match: RegExpExecArray | null;
  let extractedCount = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: regex exec 루프 관용구
  while ((match = solutionArgRe.exec(solutionOutput)) !== null && extractedCount < 3) {
    const title = match[1].replace(/\\"/g, '"').trim();
    const rawContent = match[2].replace(/\\"/g, '"').trim();
    const condition = (match[3] ?? '').replace(/\\"/g, '"').trim();
    const projectOnly = (match[4] ?? '').trim() === '이 프로젝트';
    const projectKey = projectOnly ? projectKeyFor(cwd) : null;
    if (!title || rawContent.length < 20) continue;
    // 보안(argument confusion): title/content 는 untrusted 모델 출력이다. execFileSync 인자로 넘기므로
    // 셸 인젝션은 없지만 '-' 로 시작하면 forgen 의 인자 파서가 플래그로 오해석할 수 있다 → 스킵.
    if (title.startsWith('-') || rawContent.startsWith('-') || condition.startsWith('-')) {
      process.stderr.write('[forgen-auto-compound] solution: dash-leading title/content, skipping (arg-confusion guard)\n');
      continue;
    }
    // 모델 출력은 untrusted transcript 파생 — 저장 전 injection/exfil 필터(defense in depth).
    if (containsPromptInjection(`${title} ${rawContent} ${condition}`)) {
      process.stderr.write('[forgen-auto-compound] solution: injection detected in LLM output, skipping\n');
      continue;
    }
    const contentScan = filterSolutionContent(rawContent);
    if (contentScan.verdict === 'block') {
      process.stderr.write('[forgen-auto-compound] solution: content blocked by filter, skipping\n');
      continue;
    }
    try {
      execFileSync(process.execPath, [cliJs, 'compound', '--solution', title, contentScan.sanitized, '--context', solutionContext(filterSolutionContent(condition).sanitized), ...(projectKey ? ['--project', projectKey] : [])], {
        cwd,
        timeout: 20_000,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, PATH: `${nodeBinDir}${path.delimiter}${process.env.PATH ?? ''}` },
      });
      extractedCount++;
    } catch (e) {
      process.stderr.write(`[forgen-auto-compound] solution write: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  // Post-extraction quality validation: remove files that fail lightweight gates
  const removedCount = validateSolutionFiles(solutionsBefore);
  if (removedCount > 0) {
    process.stderr.write(`[forgen-auto-compound] quality gate removed ${removedCount} low-quality solution(s)\n`);
  }
  return { ok: true, retriable: false };
}

function phaseBehavior(summary: string, attempt: number, sessId: string = sid): PhaseResult {
  // 기존 behavior 파일 목록 (중복 패턴 방지)
  let existingBehaviorPatterns = '';
  if (fs.existsSync(BEHAVIOR_DIR)) {
    const behaviorFiles = fs.readdirSync(BEHAVIOR_DIR).filter(f => f.endsWith('.md')).slice(-10);
    if (behaviorFiles.length > 0) {
      const snippets = behaviorFiles.map(f => {
        try { return fs.readFileSync(path.join(BEHAVIOR_DIR, f), 'utf-8').slice(0, 200); } catch { return ''; }
      }).filter(Boolean);
      existingBehaviorPatterns = `\n\n기존 behavior 패턴 (중복 추가 금지):\n${snippets.join('\n---\n')}`;
    }
  }
  const userPrompt = `다음 대화에서 사용자의 작업 습관, 커뮤니케이션 스타일, 기술 선호도를 분석해주세요.

관찰된 패턴을 다음 형식으로 1~3개만 출력해주세요 (없으면 "관찰된 패턴 없음"):
- [카테고리] 패턴 설명 (관찰 근거)

카테고리: 커뮤니케이션/작업습관/기술선호/의사결정/워크플로우/품질안전/자율성

각 카테고리 가이드:
- "워크플로우": 반복하는 작업 순서, 판단 규칙, 조건부 접근법 (예: "테스트 먼저 → 구현 → 리팩토링 순서")
- "품질안전": 검증/테스트/안전성 관련 강한 선호 (예: "프로덕션 배포 전 Docker e2e 의무", "mock-only 검증 거부")
- "자율성": 확인/독립 결정 관련 선호 (예: "사소한 변경은 묻지 않고 진행", "큰 결정은 반드시 확인")

워크플로우 패턴이 감지되면 반드시 구체적인 순서를 포함하세요.
품질안전/자율성 패턴은 4축 개인화의 입력이므로 quality/autonomy 신호가 명확하면 반드시 해당 라벨을 사용하세요 (커뮤니케이션/작업습관 으로 흡수 금지).

기존 패턴과 중복이면 건너뛰세요.${existingBehaviorPatterns}

---
${summary}
---`;
  const r = callHaiku('behavior', userPrompt, { cwd, attempt, sessionId: sessId });
  if (!r.ok) return { ok: false, retriable: r.retriable, reason: r.reason, outcome: r.outcome };
  const userResult = r.output;

  // B4 security hardening (2026-04-09): 모델 출력도 디스크에 쓰기 전 prompt-injection 필터를 통과시킨다.
  const isInjection = userResult ? containsPromptInjection(userResult.trim()) : false;
  if (isInjection) {
    process.stderr.write(`[forgen-auto-compound] behavior: injection detected in LLM output, skipping write\n`);
  }
  // ADR-010 W1-2 캡처 사이드 에코 차단: Claude-voice 에코를 저장 전에 거른다.
  const isEcho = userResult ? isSelfReferentialEcho(userResult.trim()) : false;
  if (isEcho && !isInjection) {
    process.stderr.write(`[forgen-auto-compound] behavior: assistant-voice echo detected, skipping write\n`);
  }
  if (userResult && !isInjection && !isEcho && !userResult.includes('관찰된 패턴 없음') && userResult.trim().length > 10) {
    userPatternFound = true; // 0.4.6 perf #12 — adaptive cooldown 시그널
    fs.mkdirSync(BEHAVIOR_DIR, { recursive: true });
    const today = new Date().toISOString().split('T')[0];
    const trimmed = userResult.trim();
    const kind = classifyBehaviorKind(trimmed);
    const merged = mergeOrCreateBehavior(BEHAVIOR_DIR, trimmed, kind, today);
    if (!merged) {
      const slug = `auto-${today}-${kind}`;
      const behaviorPath = path.join(BEHAVIOR_DIR, `${slug}.md`);
      if (!fs.existsSync(behaviorPath)) {
        const content = `---\nname: "${slug}"\nversion: 1\nkind: "${kind}"\nobservedCount: 1\nconfidence: 0.6\ntags: ["auto-observed", "${kind}"]\ncreated: "${today}"\nupdated: "${today}"\nsource: "auto-compound"\n---\n\n## Content\n${trimmed}\n`;
        fs.writeFileSync(behaviorPath, content);
      }
    }
    // behavior_observation evidence 저장 (mismatch detector 신호 확대)
    const behaviorEvidence = createEvidence({
      type: 'behavior_observation',
      session_id: sid,
      source_component: 'auto-compound-runner',
      summary: trimmed.slice(0, 200),
      axis_refs: mapKindToAxisRefs(kind),
      confidence: 0.6,
      raw_payload: { kind, observedCount: 1 },
    });
    saveEvidence(behaviorEvidence);
  }
  return { ok: true, retriable: false };
}

async function phaseLearning(summary: string, attempt: number, sessId: string = sid): Promise<PhaseResult> {
  const V1_PROFILE = path.join(ME_DIR, 'forge-profile.json');
  const V1_EVIDENCE_DIR = path.join(ME_DIR, 'behavior');
  if (!fs.existsSync(V1_PROFILE)) return { ok: true, retriable: false };

  const currentProfile = loadProfile();
  let profileContext = '';
  if (currentProfile) {
    const qf = currentProfile.axes.quality_safety.facets;
    const af = currentProfile.axes.autonomy.facets;
    profileContext = `\n현재 프로필:\n- 팩: quality=${currentProfile.base_packs.quality_pack}, autonomy=${currentProfile.base_packs.autonomy_pack}\n- quality_safety facets: verification_depth=${qf.verification_depth.toFixed(2)}, stop_threshold=${qf.stop_threshold.toFixed(2)}, change_conservatism=${qf.change_conservatism.toFixed(2)}\n- autonomy facets: confirmation_independence=${af.confirmation_independence.toFixed(2)}, assumption_tolerance=${af.assumption_tolerance.toFixed(2)}, scope_expansion_tolerance=${af.scope_expansion_tolerance.toFixed(2)}, approval_threshold=${af.approval_threshold.toFixed(2)}\n`;
  }

  const learningSummaryPrompt = `다음 Claude Code 세션 대화를 분석하여 사용자의 개인화 학습 요약을 JSON으로 출력해주세요.
${profileContext}
출력 형식 (JSON만, 설명 없이):
{
  "corrections": [
    { "policy": "이런 상황에서는 이렇게 하라(구체·행동가능)", "target": "무엇에 대한 교정인가(짧은 명사구)", "kind": "prefer-from-now" 또는 "avoid-this", "axis": "quality_safety" 또는 "autonomy" 또는 "judgment_philosophy" 또는 "communication_style" }
  ],
  "observations": ["사용자의 반복 행동 패턴 목록"],
  "pack_direction": null 또는 "opposite_quality" 또는 "opposite_autonomy",
  "profile_delta": {
    "quality_safety": { "verification_depth": 0.0, "stop_threshold": 0.0, "change_conservatism": 0.0 },
    "autonomy": { "confirmation_independence": 0.0, "assumption_tolerance": 0.0, "scope_expansion_tolerance": 0.0, "approval_threshold": 0.0 },
    "judgment_philosophy": { "minimal_change_bias": 0.0, "abstraction_bias": 0.0, "evidence_first_bias": 0.0 },
    "communication_style": { "verbosity": 0.0, "structure": 0.0, "teaching_bias": 0.0 }
  }
}

규칙:
- corrections: 사용자가 어시스턴트의 행동/접근/출력을 **교정한 지점**을 찾아라. 명시 마커
  ("하지마", "그렇게 말고", "앞으로는")뿐 아니라, **직전 [Assistant] 행동 대비 [User]가
  방향을 튼 경우**도 포함:
    · 긍정 지시형("~해줘", "~돌려봐" — 어시스턴트가 안 하던 걸 요구)
    · 반사실형("~했어야 했다", "~에서 했어야 하는 거 아니야?")
    · 완곡형("~안 해도 될 것 같아", "굳이 ~해야 할까?")
    · 부정/반박형("아니", "그게 아니라", "틀렸어")
  단순 진행 지시("다음 거 하자", "옵션 A로")나 질문은 제외. 없으면 빈 배열.
  각 교정은 policy(재사용 가능한 규칙문, 20자 이상)·target·kind·axis 로 구조화.
- observations: 3회 이상 반복된 행동만. 없으면 빈 배열.
- pack_direction: 사용자가 현재 pack과 반대 방향으로 일관되게 행동했으면 opposite_quality 또는 opposite_autonomy. 아니면 null.
- profile_delta: facet 조정 제안. -0.1~+0.1 범위. 변화 없으면 0.0.
- 학습할 것이 없으면 모든 값을 빈 배열/null/0.0으로.

---
${summary}
---`;

  const r = callHaiku('learning', learningSummaryPrompt, { cwd, attempt, sessionId: sessId });
  if (!r.ok) return { ok: false, retriable: r.retriable, reason: r.reason, outcome: r.outcome };
  const learningResult = r.output;

  const jsonMatch = learningResult.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { ok: true, retriable: false };
  let parsed: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { parsed = JSON.parse(jsonMatch[0]); } catch (e) {
    process.stderr.write(`[forgen-auto-compound] session learning JSON parse: ${e instanceof Error ? e.message : String(e)}\n`);
    return { ok: true, retriable: false };
  }

  // session_summary evidence 저장 (mismatch detector용)
  if (parsed.pack_direction || parsed.corrections?.length > 0 || parsed.observations?.length > 0) {
    const evidenceId = `sess-summary-${sid.slice(0, 8)}`;
    const evidence = {
      evidence_id: evidenceId,
      type: 'session_summary',
      session_id: sid,
      timestamp: new Date().toISOString(),
      source_component: 'auto-compound-runner',
      summary: `corrections: ${parsed.corrections?.length ?? 0}, observations: ${parsed.observations?.length ?? 0}`,
      axis_refs: parsed.pack_direction ? [parsed.pack_direction.includes('quality') ? 'quality_safety' : 'autonomy'] : [],
      candidate_rule_refs: [],
      confidence: 0.7,
      raw_payload: {
        pack_direction: parsed.pack_direction,
        corrections: parsed.corrections,
        observations: parsed.observations,
      },
    };
    fs.mkdirSync(V1_EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(V1_EVIDENCE_DIR, `${evidenceId}.json`), JSON.stringify(evidence, null, 2));
  }

  // ADR-013: 채굴된 교정을 **승급 가능 Evidence** 로 emit. auto_mined → promoteSessionCandidates 가
  // **advisory-only**(차단 불가) + "auto:" 네임스페이스 + 생성나이 은퇴로 승급.
  // 안전: (a) run 당 최대 3개, (b) policy 를 injection 필터 통과, (c) policy≥20 + target 필수.
  const MAX_MINED_PER_RUN = 3;
  let minedCorrections = 0;
  for (const c of (parsed.corrections ?? []) as Array<Record<string, unknown>>) {
    if (minedCorrections >= MAX_MINED_PER_RUN) break;
    if (!c || typeof c !== 'object') continue;
    const policy = typeof c.policy === 'string' ? c.policy.trim() : '';
    const target = typeof c.target === 'string' ? c.target.trim() : '';
    const kind = c.kind === 'avoid-this' ? 'avoid-this' : 'prefer-from-now';
    const axis = typeof c.axis === 'string' ? c.axis : null;
    if (policy.length < 20 || !target) continue;
    if (containsPromptInjection(policy) || containsPromptInjection(target)) {
      process.stderr.write('[forgen-auto-compound] skipped mined correction (injection filter)\n');
      continue;
    }
    const ev = createEvidence({
      type: 'explicit_correction',
      session_id: sid,
      source_component: 'auto-compound-miner',
      summary: policy,
      axis_refs: axis ? [axis] : [],
      confidence: 0.55, // ①(실시간)보다 낮게 — 채굴 불확실성 반영
      raw_payload: { kind, target, axis_hint: axis, auto_mined: true },
    });
    saveEvidence(ev);
    minedCorrections++;
  }
  if (minedCorrections > 0) {
    process.stderr.write(`[forgen-auto-compound] mined ${minedCorrections} correction(s) (advisory-only, capped, age-retired)\n`);
  }

  // facet delta 적용 — ADR-017: raw JSON write 금지. profile-store 경유로 score 재계산.
  if (parsed.profile_delta) {
    const { loadProfile: lp, saveProfileRecomputed } = await import('../store/profile-store.js');
    const profile = lp();
    const clamp = (v: number) => Math.max(0.0, Math.min(1.0, v));
    let changed = false;
    if (profile) {
      const axes = ['quality_safety', 'autonomy', 'judgment_philosophy', 'communication_style'] as const;
      for (const axis of axes) {
        const d = parsed.profile_delta[axis];
        if (!d) continue;
        const f = profile.axes[axis].facets as unknown as Record<string, number>;
        for (const [k, v] of Object.entries(d)) {
          if (typeof v === 'number' && Math.abs(v) > 0.001 && Object.hasOwn(f, k)) { // hasOwn: 프로토타입 키 차단
            f[k] = clamp(f[k] + v);
            changed = true;
          }
        }
      }
    }
    if (profile && changed) {
      const rr = saveProfileRecomputed(profile);
      const moved = Object.entries(rr.deltas).filter(([, d]) => Math.abs(d.after - d.before) > 1e-9).map(([k, d]) => `${k} ${d.before.toFixed(2)}→${d.after.toFixed(2)}`);
      process.stderr.write(`[forgen-auto-compound] profile facets updated from session learning${moved.length ? ` (score: ${moved.join(', ')})` : ''}\n`);
    }
  }
  return { ok: true, retriable: false };
}

/**
 * 단계들을 순서대로 호출한다. 첫 실패에서 멈춘다 — 같은 환경에서 다음 호출도 같은 이유로 실패할 가능성이 높고,
 * 실패 호출마다 최대 타임아웃을 기다리면 러너가 무한정 길어진다. 남은 단계(실패한 단계 포함)를 돌려준다.
 */
async function runPhases(summary: string, phases: Phase[], attempt: number, sessId: string = sid): Promise<{ remaining: Phase[]; fail?: PhaseResult }> {
  for (let i = 0; i < phases.length; i++) {
    let r: PhaseResult;
    try {
      r = phases[i] === 'solution' ? phaseSolution(summary, attempt, sessId)
        : phases[i] === 'behavior' ? phaseBehavior(summary, attempt, sessId)
        : await phaseLearning(summary, attempt, sessId);
    } catch (e) {
      r = { ok: false, retriable: false, reason: e instanceof Error ? e.message.slice(0, 160) : String(e), outcome: 'error' };
      process.stderr.write(`[forgen-auto-compound] ${phases[i]} phase: ${r.reason}\n`);
    }
    if (!r.ok) return { remaining: phases.slice(i), fail: r };
  }
  return { remaining: [] };
}

const ALL_PHASES: Phase[] = ['solution', 'behavior', 'learning'];
let skipReason: string | null = null;
let indexFailed = false; // 인덱싱 실패 시 markRun 을 하지 않아 다음 트리거가 다시 시도한다
let extractedSolutionsCount = 0;
let promotedCount = 0;
const solutionsAtStart = snapshotSolutions();

const runStartSize = (() => { try { return fs.statSync(transcriptPath).size; } catch { return 0; } })();

try {
  // ── D9: 결정론 승급을 가장 먼저 — 메시지 수·요약 길이·Haiku·인젝션 게이트와 무관하게 세션당 최소 1회.
  //    재실행은 멱등(candidate_rule_refs 소비 마커). 짧은 세션/Haiku 불가 환경에서도 교정이 룰이 된다.
  if (!queueOnly) {
    try {
      promotedCount = promoteSessionCandidates(sid);
      if (promotedCount > 0) {
        process.stderr.write(`[forgen-auto-compound] promoted ${promotedCount} correction(s) to permanent rules\n`);
      }
    } catch (e) {
      process.stderr.write(`[forgen-auto-compound] rule promotion: ${e instanceof Error ? e.message : String(e)}\n`);
    }

    // ── D9: sessions.db 인덱싱 (증분·멱등). `claude`/`codex` 직접 실행도 여기서 기록된다.
    try {
      const { indexTranscript } = await import('./session-store.js');
      const idx = await indexTranscript(cwd, transcriptPath, sid);
      if (idx) process.stderr.write(`[forgen-auto-compound] indexed +${idx.added} message(s) into sessions.db\n`);
      else indexFailed = true;
    } catch (e) {
      indexFailed = true;
      process.stderr.write(`[forgen-auto-compound] session index: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  // transcript 가 같은 크기로 교체됐으면(앞부분 지문이 다름) 커서를 처음으로 되돌려 새 내용을 처음부터 읽는다.
  const runSig = queueOnly ? '' : transcriptSignature(transcriptPath);
  if (!queueOnly && resetIfReplaced(sid, runSig)) {
    appendExtractionEvent({ kind: 'transcript-replaced', sessionId: sid });
  }

  // ── D3/D4: 새 부분만 요약해 Haiku 추출. 어떤 건너뜀이든 아래 결정론 꼬리(클러스터링·메타·GC·ROI·수명주기)는 계속 돈다.
  let freshFailed = false;
  if (!queueOnly) {
    try {
      const consent = getHaikuConsentState();
      if (!consent.enabled) throw new SkipExtraction(`haiku-disabled:${consent.source}`);

      const cursor = getCursor(sid);
      const digest = await digestTranscriptFile(transcriptPath, cursor);
      if (digest.items.length === 0) {
        setCursor(sid, digest.endOffset); // 읽을 거리가 없는 구간(도구 결과·주입뿐)은 다시 읽지 않는다
        throw new SkipExtraction('no-new-content');
      }
      if (!isFinal && digest.userMessages < MIN_NEW_USER_MSGS_FOR_PARTIAL && digest.correctionCandidates === 0) {
        throw new SkipExtraction('partial-too-small'); // 커서는 두어 다음 번에 합쳐서 처리
      }

      const rawSummary = renderDigest(digest);
      if (rawSummary.length < 200) throw new SkipExtraction('input-too-short');

      // R5-G2 (P0 security): 외부 송신 전 API key / 토큰 / 비밀번호 / private key 를 [REDACTED:...] 로 치환.
      const { redacted: redactedSummary, hits: secretHits } = redactSecrets(rawSummary);
      if (secretHits.length > 0) {
        process.stderr.write(`[forgen-auto-compound] redacted ${secretHits.length} secret(s) before send: ${secretHits.map((s) => s.name).join(', ')}\n`);
      }
      // W2-5 (private 태그): <private> 범위를 LLM 송신·behavior write 전에 제거.
      const { cleaned: summary, hadPrivate } = stripPrivate(redactedSummary);
      if (hadPrivate) {
        process.stderr.write(`[forgen-auto-compound] excluded <private> range(s) before send (privacy)\n`);
      }
      if (summary.length < 200) throw new SkipExtraction('input-too-short-after-redaction');

      // 보안: 프롬프트 인젝션이 포함된 transcript는 분석하지 않음 (이 구간은 소비 처리 — 재시도해도 같다)
      if (containsPromptInjection(summary)) {
        setCursor(sid, digest.endOffset);
        throw new SkipExtraction('prompt-injection-blocked');
      }
      const scanResult = filterSolutionContent(summary);
      if (scanResult.verdict === 'block') {
        process.stderr.write('[forgen-auto-compound] transcript blocked by injection filter\n');
        setCursor(sid, digest.endOffset);
        throw new SkipExtraction('injection-filter-blocked');
      }
      if (scanResult.verdict === 'warn') {
        process.stderr.write(`[forgen-auto-compound] injection warning: ${scanResult.findings.map(f => f.patternId).join(', ')}\n`);
      }
      const sanitizedSummary = scanResult.sanitized;

      // 호출 가능 여부(미설치·미로그인)는 호출 전에 판정 — 모델 호출 없이 `claude auth status` 로 확인.
      if ((await import('../store/profile-store.js')).resolveDefaultHost() !== 'codex') {
        const av = probeClaudeAvailability();
        if (!av.available) {
          writeHaikuStatus({ ok: false, outcome: 'unavailable', reason: av.reason });
          throw new SkipExtraction(`haiku-unavailable:${av.reason ?? ''}`);
        }
      }

      // 같은 구간에서 이미 성공한 단계는 다시 부르지 않는다 (앞 단계만 성공하고 뒤에서 막힌 뒤 재실행되는 경우).
      const alreadyDone = getDonePhases(sid, digest.endOffset);
      const res = await runPhases(sanitizedSummary, ALL_PHASES.filter((ph) => !alreadyDone.includes(ph)), 0);
      if (res.remaining.length > 0) {
        freshFailed = true;
        haikuError = res.fail?.reason ?? 'haiku failure';
        if (res.fail?.retriable) {
          // 이 구간은 마스킹된 요약째 대기열로 — 커서를 넘긴다(유실 0). 다음 세션 시작/종료에서 재시도.
          const { dropped } = enqueue({ sessionId: sid, cwd, summary: sanitizedSummary, phases: res.remaining, error: haikuError });
          for (const d of dropped) appendExtractionEvent({ kind: 'queue-drop', sessionId: d.sessionId, reason: 'queue-limit-or-age', attempts: d.attempts });
          setCursor(sid, digest.endOffset);
          setDonePhases(sid, digest.endOffset, []);
          appendExtractionEvent({ kind: 'queued', sessionId: sid, phases: res.remaining, reason: haikuError });
        } else {
          // 미설치·미로그인: 재시도해도 같다. 커서를 두어 로그인 후 같은 구간을 처리한다.
          skipReason = `haiku-unavailable:${haikuError}`;
          setDonePhases(sid, digest.endOffset, ALL_PHASES.filter((ph) => !res.remaining.includes(ph)));
        }
      } else {
        setCursor(sid, digest.endOffset);
        setDonePhases(sid, digest.endOffset, []);
      }
    } catch (e) {
      if (e instanceof SkipExtraction) {
        skipReason = e.reason;
        process.stderr.write(`[forgen-auto-compound] extraction skipped: ${e.reason}\n`);
      } else {
        throw e;
      }
    }
  }

  // ── D4: 대기열 재시도 (러너 1회당 1건, 방금 새 호출이 실패했다면 건너뜀 — 같은 환경에서 또 기다리지 않는다)
  if (!freshFailed && isHaikuCompoundEnabled() && !(skipReason ?? '').startsWith('haiku-unavailable')) {
    try {
      const entry = claimDue();
      if (entry) {
        const res = await runPhases(entry.summary, entry.phases, entry.attempts + 1, entry.sessionId);
        const failReason = res.fail?.reason ?? 'haiku failure';
        const retriable = res.fail ? res.fail.retriable : false;
        const done = completeEntry(entry.id, res.remaining, res.remaining.length > 0 ? failReason : undefined); // 남은 단계는 보존(미설치여도 유실 없음), 시도 상한에서만 폐기
        appendExtractionEvent({ kind: 'queue-retry', sessionId: entry.sessionId, attempt: entry.attempts + 1, ok: res.remaining.length === 0, remaining: res.remaining, ...(res.remaining.length > 0 ? { reason: failReason } : {}), dropped: done.dropped });
        if (res.remaining.length > 0 && !retriable) haikuError ??= failReason;
      }
    } catch (e) {
      process.stderr.write(`[forgen-auto-compound] queue retry: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  // 처리 끝 표시 — 추출 결과가 확정된 **뒤**에만 찍는다. 동의 OFF·미로그인으로 못 넘긴 구간이 남았으면 그 사유를 함께 남겨,
  // 켜지거나 로그인하면 같은 구간을 다시 처리하게 한다 (예전엔 추출 전에 찍어 그 구간이 영영 건너뛰어졌다).
  if (!queueOnly && !indexFailed) {
    try {
      const blocked = (skipReason ?? '').startsWith('haiku-disabled') ? 'haiku-disabled'
        : (skipReason ?? '').startsWith('haiku-unavailable') ? 'haiku-unavailable'
        : null;
      markRun(sid, runStartSize, { sig: runSig, blocked });
    } catch { /* 표시 실패는 다음 트리거가 다시 돈다 */ }
  }

  // Step 4: 추출 단계에서 새로 생긴 채굴 교정까지 포함해 한 번 더 승급(멱등).
  if (!queueOnly) {
    try {
      promotedCount += promoteSessionCandidates(sid);
      if (promotedCount > 0) {
        process.stderr.write(`[forgen-auto-compound] promoted ${promotedCount} correction(s) to permanent rules (total this run)\n`);
      }
    } catch (e) {
      process.stderr.write(`[forgen-auto-compound] rule promotion: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  if (queueOnly) {
    appendExtractionEvent({ ok: !haikuError, queueOnly: true, ...(haikuError ? { error: haikuError.slice(0, 200) } : {}) });
    process.exit(0);
  }

  // Step 4b (W3-2): 교정 클러스터링 — 같은 원칙을 N회 교정해 흩어진 룰을 1개 명명 룰로
  // 통합하고 강도를 반복 신호(Laplace)로 승급. 승급 직후 같은 패스에서 실행. fail-open.
  try {
    const { runCorrectionClustering } = await import('../engine/correction-cluster-runner.js');
    const merges = await runCorrectionClustering();
    for (const m of merges) {
      process.stderr.write(
        `[forgen-auto-compound] clustered ${m.memberIds.length} correction(s) → 1 rule ` +
        `[${m.category}, strength=${m.strength}, conf=${m.confidence.toFixed(2)}] — ` +
        `undo: forgen rule unmerge-cluster ${m.mergedRuleId}\n`,
      );
    }
  } catch (e) {
    process.stderr.write(`[forgen-auto-compound] correction clustering: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  // H2: 이번 실행 전후 솔루션 차분 → Stop hook 알림용 "N개 패턴 학습됨".
  try {
    if (fs.existsSync(SOLUTIONS_DIR)) {
      for (const f of fs.readdirSync(SOLUTIONS_DIR)) {
        if (f.endsWith('.md') && !solutionsAtStart.has(f)) extractedSolutionsCount++;
      }
    }
  } catch (e) {
    process.stderr.write(`[forgen-auto-compound] solution count failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  // Step 5: meta-learning (HyperAgents-inspired self-tuning)
  try {
    const { runMetaLearning } = await import('../engine/meta-learning/runner.js');
    const metaResult = runMetaLearning(sid, cwd);
    if (metaResult.qualityScore) {
      process.stderr.write(`[forgen-meta] session quality: ${metaResult.qualityScore.overallScore}/100\n`);
    }
    if (metaResult.scopePromotions && metaResult.scopePromotions.length > 0) {
      process.stderr.write(`[forgen-meta] promoted ${metaResult.scopePromotions.length} solution(s) to universal scope\n`);
    }
  } catch (e) {
    process.stderr.write(`[forgen-meta] ${e instanceof Error ? e.message : String(e)}\n`);
  }

  // Step 5.5 (v0.4.1): state hygiene — 세션 스코프 ephemeral 파일 7일 retention
  // 자동 정리. 이전에는 `forgen doctor --prune-state` 수동만 있어서 injection-cache
  // 2343 / modified-files 431 처럼 수천 파일 누적. 몇 달 사용하면 10만+ 파일 → stat
  // 호출 느려지고 디스크 낭비. auto-compound 마다 호출되면 자연스레 정돈.
  try {
    const { pruneState } = await import('./state-gc.js');
    const report = pruneState({ dryRun: false });
    if (report.pruned > 0) {
      const mb = (report.bytesFreed / 1024 / 1024).toFixed(2);
      process.stderr.write(`[forgen-gc] pruned ${report.pruned} stale state files (${mb} MB freed)\n`);
    }
  } catch (e) {
    process.stderr.write(`[forgen-gc] state prune failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  // ADR-010 W3-1 (F2): 세션 종료마다 ROI 재판정 — surfaced≫acted_on 솔루션
  // 강등/격리. δ 가 100% injection 에서 나오므로(실측) 주입 품질 = 효과.
  try {
    const { updateRoiDemotions } = await import('../engine/roi-demotion.js');
    const roi = updateRoiDemotions();
    if (roi && (roi.demoted > 0 || roi.quarantined > 0)) {
      process.stderr.write(`[forgen-roi] low-ROI solutions: ${roi.demoted} demoted, ${roi.quarantined} quarantined\n`);
    }
  } catch (e) {
    process.stderr.write(`[forgen-roi] update failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  // Step 6 (v0.4.1): rule lifecycle 자동 실행 — rule 의 violations/bypass/drift
  // 신호에 따른 자동 강등/승격. 이전에는 CLI (`forgen rule scan --apply`) 수동
  // 호출만 있어서 구매자가 몇 주 써도 rule 정비 안 됨 → 쓸모없는 rule 이 계속
  // active. 판매 관점 심각한 "자동 학습 단절". auto-compound-runner 끝에 자동
  // 실행해 세션마다 rule 품질 유지.
  try {
    const { handleLifecycleScan } = await import('../engine/lifecycle/lifecycle-cli.js');
    // silent mode 로 돌리기 위해 stdout 을 임시 리다이렉트 (내부가 console.log 씀)
    const origLog = console.log;
    let applied = 0;
    console.log = (...args: unknown[]) => {
      const msg = args.join(' ');
      const match = msg.match(/apply(?:ied)?\s+(\d+)/i);
      if (match) applied = Number(match[1]);
    };
    try {
      await handleLifecycleScan(['--apply']);
    } finally {
      console.log = origLog;
    }
    if (applied > 0) {
      process.stderr.write(`[forgen-meta] rule lifecycle: ${applied} event(s) applied\n`);
    }
  } catch (e) {
    process.stderr.write(`[forgen-meta] lifecycle scan failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  // 완료 기록 — H2: Stop hook 알림용으로 extractedSolutions / promotedRules 포함.
  // noticeShown=false 로 시작해서 Stop hook 가 최초 1회만 surface.
  const statePath = path.join(FORGEN_HOME, 'state', 'last-auto-compound.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      sessionId: sid,
      completedAt: new Date().toISOString(),
      extractedSolutions: extractedSolutionsCount,
      promotedRules: promotedCount,
      userPatternFound, // 0.4.6 perf #12 — adaptive cooldown 시그널
      // ADR-011 B수정: 이 run 시점의 프롬프트 수 기록 → 이후 barren backoff 결정 시
      // 세션이 자라났으면(promptCount 증가) barren 을 무시하고 재추출하기 위함.
      promptCount: Number(process.argv[5] ?? 0) || 0,
      noticeShown: false,
    }),
  );
  appendExtractionEvent({ ok: !haikuError, sessionId: sid, extractedSolutions: extractedSolutionsCount, promotedRules: promotedCount, ...(skipReason ? { skipped: skipReason } : {}), ...(haikuError ? { error: haikuError.slice(0, 200) } : {}) });
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`[forgen-auto-compound] ${msg}\n`);
  try { appendExtractionEvent({ ok: false, sessionId: sid, error: msg.slice(0, 200) }); } catch { /* 기록 실패는 무시 */ }
}

