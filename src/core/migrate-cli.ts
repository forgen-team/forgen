/**
 * Forgen v0.4.1 — `forgen migrate` CLI
 *
 * 데이터 스키마 업그레이드를 1회성으로 돌리는 관리 명령.
 * 현재 대상:
 *   - implicit-feedback: TEST-5 category 필드 백필 (type → category inference).
 *     기본은 lazy (read 시점 백필) 이지만 집계/외부 도구가 raw jsonl 을 읽는
 *     경우 영구 재기록이 필요.
 *   - evidence-host: ~/.forgen/me/behavior/*.json 에 host 필드가 없는 파일 백필.
 */

import { migrateImplicitFeedbackLog } from '../store/implicit-feedback-store.js';
import { migrateEvidenceHost } from './migrate-evidence-host.js';
import type { HostId } from './trust-layer-intent.js';

const HELP = `
  forgen migrate — one-shot schema migrations

  Usage:
    forgen migrate implicit-feedback   category 필드가 없는 레거시 엔트리 백필 + 재기록
    forgen migrate all                 (현재는 implicit-feedback 과 동일)
    forgen migrate evidence-host       behavior/*.json 에 host 필드 백필
      --dry-run                          디스크 미수정, 카운트만 출력
      --default-host <claude|codex>      host 기본값 (default: claude)
    forgen migrate tenetx              tenetx/legacy 규칙 스프롤 회수 (ADR-010 W1-1)
      --dry-run                          회수 대상만 표시
      --yes                              marker-only(사용자 편집 가능성) 파일도 회수
      --apply-settings                   settings.json/registry 의 tenetx 항목 제거
    forgen migrate --help              이 도움말
`;

export async function handleMigrate(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    console.log(HELP);
    return;
  }

  if (sub === 'implicit-feedback' || sub === 'all') {
    console.log('[forgen migrate] implicit-feedback.jsonl 백필 시작...');
    const { migrated, dropped } = migrateImplicitFeedbackLog();
    console.log(`[forgen migrate] 백필 ${migrated}건, 드롭 ${dropped}건 — 재기록 완료.`);
    return;
  }

  if (sub === 'evidence-host') {
    const dryRun = args.includes('--dry-run');
    const hostFlagIdx = args.indexOf('--default-host');
    const rawHost = hostFlagIdx !== -1 ? args[hostFlagIdx + 1] : 'claude';
    if (rawHost !== 'claude' && rawHost !== 'codex') {
      console.error(`[forgen migrate] --default-host 는 'claude' 또는 'codex' 여야 합니다. 받은 값: ${rawHost}`);
      process.exit(1);
    }
    const defaultHost = rawHost as HostId;
    const result = migrateEvidenceHost({ defaultHost, dryRun });
    const label = dryRun ? ' (dry-run)' : '';
    console.log(`[forgen] migrated: ${result.migrated} (skipped: ${result.skipped}, total: ${result.total})${label}`);
    return;
  }

  if (sub === 'tenetx') {
    const { runReclaim, printReclaimResult } = await import('./migrate-tenetx.js');
    const result = runReclaim({
      cwd: process.cwd(),
      dryRun: args.includes('--dry-run'),
      yes: args.includes('--yes'),
      applySettings: args.includes('--apply-settings'),
    });
    printReclaimResult(result);
    return;
  }

  console.error(`[forgen migrate] unknown target: ${sub}`);
  console.error(HELP);
  process.exit(1);
}
