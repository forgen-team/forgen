/**
 * forgen audit — 호스트 기억 감사 (docs/plans/2026-11-25-v1.0-plan.md §2.1, §4.1).
 *   forgen audit [--folder <경로>]... [--claude-dir <경로>] [--json] [--timing] [--no-model] [--no-open]
 *   forgen audit tokens [--folder <경로>]... [--claude-dir <경로>] [--json]
 *
 * 원천은 읽기만 한다. 쓰는 곳은 <FORGEN_HOME>/audit/<회차>/(manifest.json·audit.html) 뿐이고 `audit tokens` 는 아무것도 쓰지 않는다.
 * 모델 판정은 아직 없다(다음 버전). --no-model 은 지금도 받지만 결과가 같다.
 */
import { performance } from 'node:perf_hooks';
import { renderAuditHtml, shortPath, topLines } from './html.js';
import { runAudit, writeRun, type AuditResult } from './run.js';

const HELP = `  forgen audit [--folder <경로>]... [--claude-dir <경로>] [--json] [--timing] [--no-model] [--no-open]
      CLAUDE.md 층·.claude/rules·자동 메모리·AGENTS.md·forgen 룰을 읽기만 해서 결정적 검사
      (잘림·크기·토큰·같은 문장·낡음·다른 프로젝트 섞임 후보·paths: 없는 룰) → ~/.forgen/audit/<회차>/audit.html
  forgen audit tokens [--folder <경로>]... [--claude-dir <경로>] [--json]
      폴더별 세션 시작 상시 로드 토큰(층별). 아무것도 쓰지 않는다
  모델 판정(같은 뜻 중복·부딪힘·섞임 확정)과 같은 말 다시 하기 재생은 다음 버전.`;

function values(args: string[], name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => { if (a === name && args[i + 1] && !args[i + 1].startsWith('--')) out.push(args[i + 1]); });
  return out;
}

const KNOWN = new Set(['--folder', '--claude-dir', '--json', '--timing', '--no-model', '--no-open', '--help', '-h']);
const WITH_VALUE = new Set(['--folder', '--claude-dir']);

function unknownFlags(args: string[]): string[] {
  return args.filter((a, i) => a.startsWith('-') && !KNOWN.has(a) && !(i > 0 && WITH_VALUE.has(args[i - 1])));
}

const LAYER_LABEL: Record<string, string> = {
  managed: '관리형', user: '사용자', 'user-rules': '사용자 룰', import: 'import', project: '프로젝트', 'project-local': '로컬',
  agents: 'AGENTS', 'project-rules': '프로젝트 룰', 'memory-index': 'MEMORY.md', 'forgen-render': 'forgen',
};

function tokenTable(r: AuditResult): string[] {
  const out = [`폴더별 상시 로드 토큰 (로컬 근사: 영문 4자≈1 · 그 밖 1자≈0.9)`];
  for (const f of r.folders) {
    const parts = Object.entries(f.byLayer).filter(([, v]) => v).map(([k, v]) => `${LAYER_LABEL[k] ?? k} ${v}`).join(' · ');
    out.push(`  ${String(f.totalTokens).padStart(6)}  ${shortPath(f.folder)}${f.projectKey ? ` [${f.projectKey}]` : ''}`);
    out.push(`          ${parts || '(없음)'}${f.reducible.total ? `  → 줄일 몫 ${f.reducible.total} (${f.reducible.pct}%)` : ''}${f.mixCandidateTokens ? ` · 섞임 후보 ${f.mixCandidateTokens}` : ''}`);
  }
  return out;
}

export async function handleAudit(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') { console.log(HELP); return; }
  const sub = args[0] && !args[0].startsWith('-') ? args[0] : null;
  if (sub && sub !== 'tokens') {
    console.error(`[forgen] 알 수 없는 audit 하위 명령: ${sub}\n${HELP}`);
    process.exitCode = 1;
    return;
  }
  const rest = sub ? args.slice(1) : args;
  const bad = unknownFlags(rest);
  if (bad.length) {
    console.error(`[forgen] 알 수 없는 audit 옵션: ${bad.join(' ')}\n${HELP}`);
    process.exitCode = 1;
    return;
  }
  const started = performance.now();
  const claudeDir = values(rest, '--claude-dir')[0];
  const run = runAudit({ folders: values(rest, '--folder'), claudeDir });
  const json = rest.includes('--json');

  if (sub === 'tokens') {
    if (json) console.log(JSON.stringify({ schema: 'forgen-audit-tokens/1', generatedAt: run.result.generatedAt, folders: run.result.folders.map((f) => ({ folder: f.folder, projectKey: f.projectKey, totalTokens: f.totalTokens, byLayer: f.byLayer, reducible: f.reducible, mixCandidateTokens: f.mixCandidateTokens, entries: f.entries })) }, null, 2));
    else for (const l of tokenTable(run.result)) console.log(l);
    return;
  }

  const t = performance.now();
  const out = writeRun(run, renderAuditHtml);
  run.timing.page = Math.round(performance.now() - t);
  run.timing.total = Math.round(performance.now() - started);
  if (json) {
    console.log(JSON.stringify({ ...run.result, runId: out.runId, dir: out.dir, ...(rest.includes('--timing') ? { timing: run.timing } : {}) }, null, 2));
    return;
  }
  const r = run.result;
  console.log('forgen 감사 — 결정적 검사만 (모델 판정은 다음 버전, 아무것도 기기 밖으로 보내지 않음)\n');
  for (const l of topLines(r)) console.log(`  • ${l}`);
  console.log('');
  for (const l of tokenTable(r)) console.log(l);
  const c = r.checks;
  console.log(`\n검사별: 잘림 ${r.summary.truncation.truncated}/${c.truncation.length} · 200줄 넘는 지침 ${c.claudeMdOver200.length} · 같은 문장 ${c.sameSentence.length} · 낡음 ${c.stale.length} · 섞임 후보 ${c.mix.length} · paths: 없는 룰 ${c.unscopedRules.length}`);
  if (r.sources.unreadable.length || r.sources.brokenRules.length) console.log(`읽지 못한 파일 ${r.sources.unreadable.length} · 깨진 forgen 룰 ${r.sources.brokenRules.length} (건너뛰고 계속함)`);
  console.log(`읽은 원천 ${r.sources.files}개 · 회차 ${out.runId}`);
  console.log(`✓ [forgen] ${out.htmlPath}`);
  if (rest.includes('--timing')) console.log(`시간(ms): 원천 ${run.timing.sources} · forgen 렌더 ${run.timing.forgenRender} · 검사 ${run.timing.checks} · 페이지 ${run.timing.page} · 합계 ${run.timing.total}`);
  if (!rest.includes('--no-open')) {
    const { openInBrowser } = await import('../core/status-html.js');
    if (!openInBrowser(out.htmlPath)) console.log('  브라우저를 열 수 없는 환경입니다. 위 파일을 직접 여세요.');
  }
}
