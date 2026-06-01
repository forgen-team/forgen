#!/usr/bin/env node
/**
 * Forgen — PostToolUse: Secret Filter Hook
 *
 * 도구 실행 결과에서 API 키, 토큰, 비밀번호 등 민감 정보 노출을 감지합니다.
 * 차단하지 않고 경고 메시지만 출력합니다.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HookError } from '../core/errors.js';
import { readStdinJSON } from './shared/read-stdin.js';
import { isHookEnabled } from './hook-config.js';
import { approve, approveWithWarning, failOpenWithTracking } from './shared/hook-response.js';

interface PostToolInput {
  tool_name?: string;
  toolName?: string;
  tool_input?: Record<string, unknown>;
  toolInput?: Record<string, unknown>;
  tool_response?: string;
  toolOutput?: string;
  session_id?: string;
}

export interface SecretPattern {
  name: string;
  pattern: RegExp;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'API Key', pattern: /(sk|pk|api[_-]?key)[_-][\w\-.]{20,}/i },
  { name: 'AWS Access Key', pattern: /AKIA[\w]{16}/ },
  { name: 'Token/Bearer/JWT', pattern: /(token|bearer|jwt)[=:\s]["']?[\w\-.]{20,}/i },
  { name: 'Password', pattern: /(password|passwd|pwd)\s*[=:]\s*["']?[^\s"']{8,}/i },
  { name: 'Private Key', pattern: /-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----/ },
  { name: 'Connection String', pattern: /(mongodb|postgres|mysql|redis):\/\/\w+:[^@]+@/ },
  // 2026-04-21 follow-up audit #B: vendor-specific prefixes the generic
  // `(sk|pk|api-key)[_-]` pattern does NOT match. Real-world leaks
  // overwhelmingly use these formats.
  { name: 'GitHub Token', pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { name: 'Google API Key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack Token', pattern: /\bxox[abpors]-[A-Za-z0-9-]{10,}/ },
];

/**
 * 텍스트에서 민감 정보 패턴을 찾아 `[REDACTED:<NAME>]` 로 치환 (순수 함수).
 *
 * R5-G2: auto-compound-runner 가 사용자 transcript 를 Claude (Haiku) 로 송신하기 전
 * 적용. `detectSecrets` 는 감지만, 이 함수는 실제 문자열에서 대체.
 */
export function redactSecrets(text: string): { redacted: string; hits: SecretPattern[] } {
  const hits: SecretPattern[] = [];
  let out = text;
  for (const sp of SECRET_PATTERNS) {
    // regex 복제 (global flag 없이 repeated test 되는 경우 lastIndex 안전)
    const re = new RegExp(sp.pattern.source, (sp.pattern.flags.includes('g') ? sp.pattern.flags : `${sp.pattern.flags}g`));
    if (re.test(out)) {
      hits.push(sp);
      const re2 = new RegExp(sp.pattern.source, (sp.pattern.flags.includes('g') ? sp.pattern.flags : `${sp.pattern.flags}g`));
      out = out.replace(re2, `[REDACTED:${sp.name}]`);
    }
  }
  return { redacted: out, hits };
}

/** 텍스트에서 민감 정보 패턴 감지 (순수 함수) */
export function detectSecrets(text: string): SecretPattern[] {
  const found: SecretPattern[] = [];
  for (const sp of SECRET_PATTERNS) {
    if (sp.pattern.test(text)) {
      found.push(sp);
    }
  }
  return found;
}

export async function main(): Promise<void> {
  const data = await readStdinJSON<PostToolInput>();

  if (!isHookEnabled('secret-filter')) {
    console.log(approve());
    return;
  }
  if (!data) {
    console.log(approve());
    return;
  }

  const toolName = data.tool_name ?? data.toolName ?? '';
  const toolResponse = data.tool_response ?? data.toolOutput ?? '';
  const toolInput = data.tool_input ?? data.toolInput ?? {};

  // Write/Edit/Bash 도구만 검사
  if (!['Write', 'Edit', 'Bash'].includes(toolName)) {
    console.log(approve());
    return;
  }

  // 도구 입력 + 출력 모두 검사
  const inputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput);
  const textToScan = `${inputStr}\n${toolResponse}`;

  const secrets = detectSecrets(textToScan);
  if (secrets.length > 0) {
    const names = secrets.map(s => s.name).join(', ');
    console.log(approveWithWarning(`<compound-security-warning>\n[Forgen] ⚠ Sensitive information exposure detected: ${names}\nThe output may contain secrets. Please review.\n</compound-security-warning>`));
    return;
  }

  console.log(approve());
}

// ESM main guard: import 시 main() 실행 방지 (context-guard 와 동일 패턴).
// secret-filter 는 redactSecrets 등을 다른 hook (context-guard) 이 import 하므로,
// guard 없이 top-level main() 을 호출하면 import 부작용으로 main() 이 실행되어
// stdout 에 유령 {"continue":true} 가 1줄 추가된다. 그 결과 import 한 hook 의
// stdout 이 JSON 2줄이 되어 Claude Code 파싱 실패 → raw JSON 이 터미널에 노출됨.
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    const hookErr = new HookError(e instanceof Error ? e.message : String(e), {
      hookName: 'secret-filter', eventType: 'PostToolUse', cause: e,
    });
    process.stderr.write(`[ch-hook] ${hookErr.name}: ${hookErr.message}\n`);
    console.log(failOpenWithTracking('secret-filter', e));
  });
}
