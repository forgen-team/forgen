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
import { execFileSync, execFile, type ExecFileSyncOptions, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { createRequire } from 'node:module';
import { containsPromptInjection, filterSolutionContent } from '../hooks/prompt-injection-filter.js';
import { isSelfReferentialEcho } from './config-injector.js';
import { redactSecrets } from '../hooks/secret-filter.js';
import { stripPrivate } from '../engine/private-filter.js';
import { createEvidence, saveEvidence, promoteSessionCandidates } from '../store/evidence-store.js';
import { isHaikuCompoundEnabled } from './compound-consent.js';
import { summarizeTranscript } from './transcript-summary.js';
import { loadProfile } from '../store/profile-store.js';
import { FORGEN_HOME, ME_DIR } from './paths.js';
import { classifyBehaviorKind, mapKindToAxisRefs } from './behavior-classifier.js';
import type { HostId } from './trust-layer-intent.js';

/** Auto-compound에 사용할 모델 — background 추출이므로 haiku로 충분 */
const COMPOUND_MODEL = 'haiku';

/**
 * Host-aware exec retry — feat/codex-support P2-3 (Phase 2 critic fix).
 *
 * 보안 회귀 방지: Claude 분기는 *args 그대로* execFileSync 호출 → P1-S1 의
 * `--allowedTools Bash(forgen compound:*)` sandbox hardening 보존.
 * Codex 분기에서만 -p prompt 추출 → execHost (codex 는 --allowedTools 모름).
 *
 * Codex retry 정책 fix: ETIMEDOUT 시 sleep 후 retry 는 *Claude only*. Codex 는
 * 60-90s response 가 정상이라 timeout 누적 retry 가 무의미 (즉시 fail).
 */
function execClaudeRetry(args: string[], opts: ExecFileSyncOptions): string {
  const mod = createRequire(import.meta.url)('../host/exec-host.js') as typeof import('../host/exec-host.js');
  // profile.default_host 로 host 결정 (lazy load)
  const profileMod = createRequire(import.meta.url)('../store/profile-store.js') as typeof import('../store/profile-store.js');
  const resolved = profileMod.resolveDefaultHost();
  const host: HostId = resolved === 'codex' ? 'codex' : 'claude';

  if (host === 'claude') {
    // Claude 측은 기존 보안 hardening 보존: --allowedTools 등 args 그대로 전달.
    const TRANSIENT = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE/;
    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return execFileSync('claude', args, opts) as unknown as string;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const match = msg.match(TRANSIENT);
        if (attempt < MAX_ATTEMPTS && match) {
          process.stderr.write(
            `[forgen-auto-compound] ${match[0]} on attempt ${attempt}/${MAX_ATTEMPTS}, retrying in 3s (auto-recovery)...\n`,
          );
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
          continue;
        }
        if (match) {
          process.stderr.write(
            `[forgen-auto-compound] ${match[0]} after ${attempt}/${MAX_ATTEMPTS} attempts — giving up (fail-open)\n`,
          );
        }
        throw e;
      }
    }
    throw new Error('unreachable');
  }

  // host === 'codex' — prompt 만 추출 (codex 는 --allowedTools 등 미인식).
  const pIdx = args.indexOf('-p');
  if (pIdx === -1 || !args[pIdx + 1]) {
    throw new Error('execClaudeRetry: codex host requires -p prompt argument');
  }
  const prompt = args[pIdx + 1];
  const modelIdx = args.indexOf('--model');
  const model = modelIdx !== -1 ? args[modelIdx + 1] : undefined;
  const r = mod.execHost({
    prompt,
    model,
    host: 'codex',
    timeout: typeof opts.timeout === 'number' ? opts.timeout : 60000,
    cwd: typeof opts.cwd === 'string' ? opts.cwd : undefined,
  });
  return r.message;
}

/**
 * 0.4.6 perf #12 — async 변형. 3 LLM 호출 (solution / user-pattern / learning) 을
 * Promise.allSettled 로 병렬 실행하여 wall-clock 을 sum → max 로 단축 (~3x).
 *
 * 0.4.6 에서는 adaptive cooldown 으로 wasted runs 차단을 우선 적용했고, 호출부
 * full parallelization 은 0.4.7 로 분리 (refactor surface 큼 — solution call 의
 * `--allowedTools` sandbox 와 file-write 순서 invariant 검증 필요).
 *
 * 본 함수는 0.4.7 작업의 foundation 으로 박제 — export 하여 unused warning 회피.
 * 동작은 sync 버전과 동일: Claude/Codex 분기 + retry on transient.
 */
/**
 * ADR-012 D: Haiku transcript-요약 추출은 **opt-in**. 동의 없으면 '' 반환 → 각 추출 phase 는
 * fail-open(try/catch)이라 아무것도 쓰지 않고, 뒤의 `promoteSessionCandidates`(결정론·egress 0)
 * 만 남는다. "우리는 당신 몰래 API 로 보내지 않는다".
 */
let haikuOptOutNoticeShown = false;
function extractViaHaiku(args: string[], opts: ExecFileSyncOptions): string {
  if (!isHaikuCompoundEnabled()) {
    if (!haikuOptOutNoticeShown) {
      process.stderr.write(
        '[forgen-auto-compound] Haiku 추출 opt-in 비활성 — 결정론 룰 승급만 수행 ' +
        '(활성: `forgen compound consent on`)\n',
      );
      haikuOptOutNoticeShown = true;
    }
    return '';
  }
  return execClaudeRetry(args, opts);
}

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
        const { stdout } = await execFileAsync('claude', args, opts);
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
  process.exit(1);
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
function isDuplicate(newContent: string, existingFiles: Map<string, string>): boolean {
  const newTags = parseTags(newContent);
  if (newTags.length === 0) return false;
  for (const [, existingContent] of existingFiles) {
    const existingTags = parseTags(existingContent);
    if (existingTags.length === 0) continue;
    const overlap = newTags.filter(t => existingTags.includes(t));
    const overlapRatio = overlap.length / Math.max(newTags.length, existingTags.length, 1);
    if (overlapRatio >= 0.7) return true;
  }
  return false;
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
        if (isDuplicate(content, existingSolutions)) {
          fs.unlinkSync(filePath);
          removed++;
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

/** 파일 → 요약. 순수 로직은 transcript-summary 모듈(테스트 가능). */
function extractSummary(filePath: string, maxChars = 8000): string {
  return summarizeTranscript(fs.readFileSync(filePath, 'utf-8'), maxChars);
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

try {
  const rawSummary = extractSummary(transcriptPath);
  if (rawSummary.length < 200) process.exit(0);

  // R5-G2 (P0 security): transcript 를 Claude 로 송신하기 전 API key / 토큰 / 비밀번호 /
  // private key blocks 를 [REDACTED:...] 로 치환. 사용자가 채팅에 pasted 한 자격증명이
  // auto-compound 를 통해 외부 API 로 누출되는 채널 차단.
  const { redacted: redactedSummary, hits: secretHits } = redactSecrets(rawSummary);
  if (secretHits.length > 0) {
    process.stderr.write(`[forgen-auto-compound] redacted ${secretHits.length} secret(s) before send: ${secretHits.map((s) => s.name).join(', ')}\n`);
  }

  // W2-5 (private 태그, flow-reviewer SEV-2): redactSecrets(보안) 와 직교하는 프라이버시
  // 축. 이 auto-compound-runner 는 학습 코퍼스의 *주 자동 캡처 경로* — 세션 종료마다
  // 전체 트랜스크립트를 추출 LLM 으로 보내고 behavior/solution 으로 파생한다. 사용자가
  // <private> 로 표시한 범위를 LLM 송신·behavior write 전에 제거해야 "안심하고 교정"
  // 약속이 주 경로에서 지켜진다.
  const { cleaned: summary, hadPrivate } = stripPrivate(redactedSummary);
  if (hadPrivate) {
    process.stderr.write(`[forgen-auto-compound] excluded <private> range(s) before send (privacy)\n`);
  }
  if (summary.length < 200) process.exit(0);

  // 보안: 프롬프트 인젝션이 포함된 transcript는 분석하지 않음
  if (containsPromptInjection(summary)) {
    process.exit(0);
  }

  // 기존 솔루션 목록 (중복 방지)
  let existingList = '';
  const solDir = path.join(FORGEN_HOME, 'me', 'solutions');
  if (fs.existsSync(solDir)) {
    const names = fs.readdirSync(solDir).filter(f => f.endsWith('.md')).map(f => f.replace('.md', '')).slice(-30);
    if (names.length > 0) existingList = `\n\n이미 축적된 솔루션 (중복 추출 금지):\n${names.join(', ')}`;
  }

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

  // 1단계: 솔루션 추출
  // 보안: transcript 요약에 filterSolutionContent 적용하여 프롬프트 인젝션 방어
  const scanResult = filterSolutionContent(summary);
  if (scanResult.verdict === 'block') {
    process.stderr.write('[forgen-auto-compound] transcript blocked by injection filter\n');
    process.exit(0);
  }
  if (scanResult.verdict === 'warn') {
    process.stderr.write(`[forgen-auto-compound] injection warning: ${scanResult.findings.map(f => f.patternId).join(', ')}\n`);
  }
  const sanitizedSummary = scanResult.sanitized;

  // Snapshot solution files before extraction (for post-extraction validation)
  const solutionsBefore = new Set<string>();
  try {
    if (fs.existsSync(SOLUTIONS_DIR)) {
      for (const f of fs.readdirSync(SOLUTIONS_DIR)) {
        if (f.endsWith('.md')) solutionsBefore.add(f);
      }
    }
  } catch { /* ignore */ }

  // 결함2 corrected fix (2026-08-19): 이전엔 모델에게 `Bash(forgen compound:*)` 도구를 주고
  // forgen compound 를 "직접 실행"시켰으나, headless haiku 는 도구 호출이 근본적으로
  // 불안정해(라이브 확증: 동일 조건에서 실행/미실행 1↔0 오락가락) 산출이 forgen 생애
  // 통틀어 0건이었다. 이제 behavior 경로와 동일하게 — 모델은 재사용 솔루션을 텍스트로만
  // 출력하고(안정적), 러너가 파싱해 forgen 을 직접 실행한다.
  //   이점: (a) 모델에 Bash 도구를 아예 주지 않으므로 P1-S1 인젝션 표면 제거 — 모델 출력은
  //   파싱·필터를 거쳐 execFileSync 의 *인자*로만 쓰이고 셸을 거치지 않아 임의 명령 실행 불가.
  //   (b) 도구 호출 신뢰성 문제 제거. (c) forgen 을 이 러너 node 의 형제 바이너리(절대경로)로
  //   호출해 cron sparse PATH 에 forgen 이 없던 문제(라이브 확증)도 해소.
  const solutionPrompt = `다음은 이전 Claude Code 세션의 대화 요약입니다.
미래 세션에서 재사용할 수 있는 패턴/해결책/의사결정을 추출해주세요.
각 항목을 정확히 아래 한 줄 형식으로만 출력하세요 (다른 설명 없이, 코드블록도 불필요):
forgen compound --solution "제목" "설명 (무엇 + 왜 + 어떻게 적용)"

- 제목: 구체적이고 검색 가능한 이름 (예: "react-high-frequency-event-raf-throttle")
- 설명: (1) 무엇을 했는지 (2) 왜 그렇게 했는지 (3) 어떻게 적용하는지
추출할 것이 없으면 "추출할 패턴 없음"이라고만 답하세요.
최대 3개. 피상적인 관찰(예: "TypeScript를 사용함")은 제외. 기존 솔루션과 중복 금지.${existingList}

---
${sanitizedSummary.slice(0, 6000)}
---`;

  let solutionOutput = '';
  try {
    solutionOutput = extractViaHaiku(
      ['-p', solutionPrompt, '--model', COMPOUND_MODEL],
      { cwd, timeout: 90_000, encoding: 'utf-8' },
    ) || '';
  } catch (e) {
    process.stderr.write(`[forgen-auto-compound] solution extraction: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  // 모델 출력에서 `--solution "제목" "설명"` 을 파싱해 forgen 을 직접 실행(결정론적).
  // forgen 은 이 러너를 돌리는 node 의 형제 바이너리를 절대경로로 호출 — sparse PATH 의존 제거.
  const nodeBinDir = path.dirname(process.execPath);
  const forgenBin = fs.existsSync(path.join(nodeBinDir, 'forgen'))
    ? path.join(nodeBinDir, 'forgen')
    : 'forgen';
  const solutionArgRe = /--solution\s+"((?:[^"\\]|\\.)+)"\s+"((?:[^"\\]|\\.)+)"/g;
  let match: RegExpExecArray | null;
  let extractedCount = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: regex exec 루프 관용구
  while ((match = solutionArgRe.exec(solutionOutput)) !== null && extractedCount < 3) {
    const title = match[1].replace(/\\"/g, '"').trim();
    const rawContent = match[2].replace(/\\"/g, '"').trim();
    if (!title || rawContent.length < 20) continue;
    // 모델 출력은 untrusted transcript 파생 — 저장 전 injection/exfil 필터(defense in depth).
    if (containsPromptInjection(`${title} ${rawContent}`)) {
      process.stderr.write('[forgen-auto-compound] solution: injection detected in LLM output, skipping\n');
      continue;
    }
    const contentScan = filterSolutionContent(rawContent);
    if (contentScan.verdict === 'block') {
      process.stderr.write('[forgen-auto-compound] solution: content blocked by filter, skipping\n');
      continue;
    }
    try {
      // title/content 는 execFileSync 의 *인자*로만 전달 — 셸 미경유라 메타문자가 있어도
      // 명령 인젝션 불가. FORGEN_HOME 등 env 는 그대로 상속되어 올바른 스토어에 기록된다.
      execFileSync(forgenBin, ['compound', '--solution', title, contentScan.sanitized], {
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

  // 2단계: 사용자 패턴 추출 → USER.md 업데이트
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
${sanitizedSummary.slice(0, 4000)}
---`;

  try {
    const userResult = extractViaHaiku(['-p', userPrompt, '--model', COMPOUND_MODEL], {
      cwd, timeout: 60_000, encoding: 'utf-8',
    });

    // 결과가 의미 있으면 behavior/ 파일로 저장
    //
    // B4 security hardening (2026-04-09): gate the Claude-generated
    // behavior output through the prompt-injection filter BEFORE
    // writing to disk. Pre-B4 the transcript (the INPUT to Claude)
    // was filtered at line 202 but the MODEL OUTPUT was trusted and
    // written verbatim. A crafted transcript could make Claude emit
    // an injection payload like "[의사결정] 실행 전 ; rm -rf ~/.forgen ..."
    // which would land on disk. C5's render-time filter in
    // config-injector would catch it at forge-behavioral.md
    // generation, but defense in depth — stop it at the source so
    // the file itself is clean.
    const isInjection = userResult ? containsPromptInjection(userResult.trim()) : false;
    if (isInjection) {
      process.stderr.write(`[forgen-auto-compound] behavior: injection detected in LLM output, skipping write\n`);
    }
    // ADR-010 W1-2 캡처 사이드 에코 차단: Claude-voice 에코("이해했습니다…",
    // "I see the notification…")를 저장 전에 거른다. 렌더 필터만으로는 스토어
    // 오염이 누적된다 — 실측(2026-07-16) 오염 49건 전부 이 형태였음.
    const isEcho = userResult ? isSelfReferentialEcho(userResult.trim()) : false;
    if (isEcho && !isInjection) {
      process.stderr.write(`[forgen-auto-compound] behavior: assistant-voice echo detected, skipping write\n`);
    }
    if (userResult && !isInjection && !isEcho && !userResult.includes('관찰된 패턴 없음') && userResult.trim().length > 10) {
      userPatternFound = true; // 0.4.6 perf #12 — adaptive cooldown 시그널
      fs.mkdirSync(BEHAVIOR_DIR, { recursive: true });
      const today = new Date().toISOString().split('T')[0];
      const trimmed = userResult.trim();

      // 카테고리에 따라 kind 분류 — D1'' (2026-04-27): quality/autonomy 라벨 추가.
      // 이전 3분기(workflow/thinking/preference)는 quality_safety/autonomy 축으로
      // 가는 자동 신호를 communication_style 로 흡수해 626건 중 자동 추출 0건이
      // 이 두 축에 닿지 못했음. 5분기로 확장. (분류 로직은 behavior-classifier.ts)
      const kind = classifyBehaviorKind(trimmed);

      // 기존 유사 패턴이 있으면 observedCount 누적
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
        session_id: sessionId,
        source_component: 'auto-compound-runner',
        summary: trimmed.slice(0, 200),
        axis_refs: mapKindToAxisRefs(kind),
        confidence: 0.6,
        raw_payload: { kind, observedCount: 1 },
      });
      saveEvidence(behaviorEvidence);
    }
  } catch (e) {
    process.stderr.write(`[forgen-auto-compound] behavior update: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  // 3단계: 세션 학습 요약 (SessionLearningSummary) 생성
  try {
    const V1_PROFILE = path.join(ME_DIR, 'forge-profile.json');
    const V1_EVIDENCE_DIR = path.join(ME_DIR, 'behavior');

    if (fs.existsSync(V1_PROFILE)) {
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
${sanitizedSummary.slice(0, 4000)}
---`;

      const learningResult = extractViaHaiku(['-p', learningSummaryPrompt, '--model', COMPOUND_MODEL], {
        cwd, timeout: 60_000, encoding: 'utf-8',
      });

      // JSON 파싱 시도
      const jsonMatch = learningResult.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);

        // session_summary evidence 저장 (mismatch detector용)
        if (parsed.pack_direction || parsed.corrections?.length > 0 || parsed.observations?.length > 0) {
          const evidenceId = `sess-summary-${sessionId.slice(0, 8)}`;
          const evidence = {
            evidence_id: evidenceId,
            type: 'session_summary',
            session_id: sessionId,
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

        // ADR-013: 채굴된 교정을 **승급 가능 Evidence** 로 emit (기존엔 session_summary 로
        // 죽던 데드엔드). auto_mined → promoteSessionCandidates 가 **advisory-only**(차단 불가) +
        // "auto:" 네임스페이스 + 생성나이 은퇴로 승급. ①(실시간 명시 교정)과 엄격 차등.
        // 안전(리뷰 SEV-1/2): (a) run 당 최대 MAX_MINED_PER_RUN 개만(무한 룰 주입 방지),
        // (b) policy 를 injection 필터 통과(환각 payload 가 영구 룰이 되는 것 차단),
        // (c) policy≥20 + target 필수.
        const MAX_MINED_PER_RUN = 3;
        let minedCorrections = 0;
        for (const c of (parsed.corrections ?? []) as Array<Record<string, unknown>>) {
          if (minedCorrections >= MAX_MINED_PER_RUN) break; // 캡 (SEV-1 #3)
          if (!c || typeof c !== 'object') continue;
          const policy = typeof c.policy === 'string' ? c.policy.trim() : '';
          const target = typeof c.target === 'string' ? c.target.trim() : '';
          const kind = c.kind === 'avoid-this' ? 'avoid-this' : 'prefer-from-now';
          const axis = typeof c.axis === 'string' ? c.axis : null;
          if (policy.length < 20 || !target) continue;
          // 출력 sanitize (SEV-2 #5): 채굴 policy 는 미래 세션 프롬프트에 룰로 주입되므로,
          // injection payload 를 룰화하지 않도록 입력과 동일한 필터를 출력에도 적용.
          if (containsPromptInjection(policy) || containsPromptInjection(target)) {
            process.stderr.write('[forgen-auto-compound] skipped mined correction (injection filter)\n');
            continue;
          }
          const ev = createEvidence({
            type: 'explicit_correction',
            session_id: sessionId,
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

        // facet delta 적용
        if (parsed.profile_delta) {
          const profile = JSON.parse(fs.readFileSync(V1_PROFILE, 'utf-8'));
          const clamp = (v: number) => Math.max(0.0, Math.min(1.0, v));
          let changed = false;

          if (parsed.profile_delta.quality_safety) {
            const d = parsed.profile_delta.quality_safety;
            const f = profile.axes.quality_safety.facets;
            for (const [k, v] of Object.entries(d)) {
              if (typeof v === 'number' && Math.abs(v) > 0.001 && k in f) {
                f[k] = clamp(f[k] + v);
                changed = true;
              }
            }
          }
          if (parsed.profile_delta.autonomy) {
            const d = parsed.profile_delta.autonomy;
            const f = profile.axes.autonomy.facets;
            for (const [k, v] of Object.entries(d)) {
              if (typeof v === 'number' && Math.abs(v) > 0.001 && k in f) {
                f[k] = clamp(f[k] + v);
                changed = true;
              }
            }
          }
          if (parsed.profile_delta.judgment_philosophy) {
            const d = parsed.profile_delta.judgment_philosophy;
            const f = profile.axes.judgment_philosophy.facets;
            for (const [k, v] of Object.entries(d)) {
              if (typeof v === 'number' && Math.abs(v) > 0.001 && k in f) {
                f[k] = clamp(f[k] + v);
                changed = true;
              }
            }
          }
          if (parsed.profile_delta.communication_style) {
            const d = parsed.profile_delta.communication_style;
            const f = profile.axes.communication_style.facets;
            for (const [k, v] of Object.entries(d)) {
              if (typeof v === 'number' && Math.abs(v) > 0.001 && k in f) {
                f[k] = clamp(f[k] + v);
                changed = true;
              }
            }
          }

          if (changed) {
            profile.metadata.updated_at = new Date().toISOString();
            fs.writeFileSync(V1_PROFILE, JSON.stringify(profile, null, 2));
            process.stderr.write('[forgen-auto-compound] profile facets updated from session learning\n');
          }
        }
      }
    }
  } catch (e) {
    process.stderr.write(`[forgen-auto-compound] session learning: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  // Step 4: prefer-from-now / avoid-this 교정 → scope:'me' 영구 규칙 승격
  let promotedCount = 0;
  try {
    promotedCount = promoteSessionCandidates(sessionId);
    if (promotedCount > 0) {
      process.stderr.write(`[forgen-auto-compound] promoted ${promotedCount} correction(s) to permanent rules\n`);
    }
  } catch (e) {
    process.stderr.write(`[forgen-auto-compound] rule promotion: ${e instanceof Error ? e.message : String(e)}\n`);
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

  // H2: count newly extracted solutions (post-quality-gate) for Stop hook 알림.
  // solutionsBefore 스냅샷 vs 현재 디스크 상태 차분 → "N개 패턴 학습됨" 1줄.
  let extractedSolutionsCount = 0;
  try {
    if (fs.existsSync(SOLUTIONS_DIR)) {
      const current = fs.readdirSync(SOLUTIONS_DIR).filter((f) => f.endsWith('.md'));
      for (const f of current) {
        if (!solutionsBefore.has(f)) extractedSolutionsCount++;
      }
    }
  } catch (e) {
    process.stderr.write(`[forgen-auto-compound] solution count failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  // Step 5: meta-learning (HyperAgents-inspired self-tuning)
  try {
    const { runMetaLearning } = await import('../engine/meta-learning/runner.js');
    const metaResult = runMetaLearning(sessionId, cwd);
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
      sessionId,
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
} catch (e) {
  process.stderr.write(`[forgen-auto-compound] ${e instanceof Error ? e.message : String(e)}\n`);
}
