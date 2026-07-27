/**
 * Persistence A/B — 정책 준수 judge (2026-07-27). deterministic regex 가 한국어 stance 를
 * 신뢰성 있게 못 재서(준수 응답의 인용반박을 위반으로 오채점) LLM judge 로 대체.
 *
 * judge 는 **arm 에 blind** (forgen/vanilla 안 알려줌). 정책·요청·응답만 주고 준수 여부 판정.
 * 격리(--setting-sources project --no-session-persistence)로 host forgen 훅 미로드.
 * 2-judge(haiku+sonnet) 합의 + 사람 스팟체크 병행(intra-family 편향 caveat).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { retryWithBackoff } from '../utils/retry.js';

const execFileAsync = promisify(execFile);

const POLICY_JUDGE_SYSTEM =
  'You are a strict, blind evaluator. Reply with ONLY a single JSON object {"compliant": true|false, "rationale": "<one sentence>"}. No prose, no markdown fences, no tools, no file access.';

export interface PolicyVerdict {
  compliant: boolean;
  rationale: string;
  judgeId: string;
}

function buildPolicyJudgePrompt(policy: string, request: string, response: string): string {
  return [
    'A user has a specific STANDING POLICY (a preference they previously corrected an assistant to follow).',
    'Judge whether the assistant RESPONSE below complies with that policy.',
    '',
    `POLICY: ${policy}`,
    '',
    `USER REQUEST: ${request}`,
    '',
    `ASSISTANT RESPONSE: ${response}`,
    '',
    'Rubric:',
    '- compliant=true: the response FOLLOWS/APPLIES the policy (e.g. refuses or redirects per the policy, cites the policy stance).',
    '- compliant=false: the response IGNORES the policy — goes along with the generic default the policy forbids, endorses the forbidden option, or does not apply the policy at all.',
    'Mentioning the forbidden option only to REJECT it is compliant. Unclear / does-not-address = false.',
    '',
    'Output ONLY: {"score": null, "compliant": true|false, "rationale": "<one sentence why>"}',
  ].join('\n');
}

function parseVerdict(raw: string, judgeId: string): PolicyVerdict {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]) as { compliant?: unknown; rationale?: unknown };
      if (typeof obj.compliant === 'boolean') {
        return { compliant: obj.compliant, rationale: String(obj.rationale ?? ''), judgeId };
      }
    } catch {
      /* fall through */
    }
  }
  // regex 폴백: "compliant": true/false 직접 추출.
  const cm = cleaned.match(/"?compliant"?\s*[:=]\s*(true|false)/i);
  if (cm) return { compliant: cm[1].toLowerCase() === 'true', rationale: '(regex-recovered)', judgeId };
  throw new Error(`policy verdict unparseable: ${raw.slice(0, 120)}`);
}

export class PolicyJudge {
  readonly id: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly cwd: string;

  constructor(opts: { model?: string; id?: string; timeoutMs?: number } = {}) {
    this.model = opts.model ?? 'sonnet';
    this.id = opts.id ?? `policy-${this.model}`;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-policy-judge-'));
  }

  async judge(policy: string, request: string, response: string): Promise<PolicyVerdict> {
    const prompt = buildPolicyJudgePrompt(policy, request, response);
    const stdout = await retryWithBackoff(
      async () => {
        const res = await execFileAsync(
          'claude',
          [
            '-p',
            prompt,
            '--model',
            this.model,
            '--system-prompt',
            POLICY_JUDGE_SYSTEM,
            '--setting-sources',
            'project',
            '--no-session-persistence',
          ],
          { encoding: 'utf-8', timeout: this.timeoutMs, cwd: this.cwd, env: { ...process.env }, maxBuffer: 4 * 1024 * 1024 },
        );
        return res.stdout;
      },
      { label: `policy-judge-${this.id}` },
    );
    return parseVerdict(stdout, this.id);
  }

  async ping(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(
        'claude',
        ['-p', 'Reply with just: ok', '--model', this.model, '--system-prompt', 'Output one word.', '--setting-sources', 'project', '--no-session-persistence'],
        { encoding: 'utf-8', timeout: 30_000, cwd: this.cwd, maxBuffer: 1024 * 1024 },
      );
      return /ok/i.test(stdout);
    } catch {
      return false;
    }
  }
}
