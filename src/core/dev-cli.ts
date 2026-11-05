/**
 * forgen dev — 개발/유지보수 명령 네임스페이스 (Wave 1 W1-3, feature-audit 2026-07-21).
 *
 * probe-workflow / migrate / regress-map 은 개발·CI·스키마 유지보수용으로,
 * 일반 사용자 표면(top-level)을 어지럽혔다. `forgen dev <sub>` 하나로 모아 사용자
 * 명령 표면을 정리한다. 각 핸들러는 기존 것을 재사용.
 *
 *   forgen dev probe-workflow arm|report|status   ADR-009 §1 훅 발화 측정
 *   forgen dev migrate [implicit-feedback|...]     one-shot 스키마 마이그레이션
 *   forgen dev regress-map [--days N --top N]      최근 fix 집중 파일
 */


function printDevHelp(): void {
  console.log(`
  forgen dev — developer / maintenance utilities

    forgen dev probe-workflow arm|report|status   Measure hook firing in dynamic-workflow subagents (ADR-009 §1)
    forgen dev migrate [target]                    One-shot schema migration
    forgen dev regress-map [--days N --top N]      Top fix-touched files
`);
}

export async function handleDev(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'probe-workflow': {
      const { handleProbeWorkflow } = await import('./probe-workflow-cli.js');
      await handleProbeWorkflow(rest);
      return;
    }
    case 'migrate': {
      const { handleMigrate } = await import('./migrate-cli.js');
      await handleMigrate(rest);
      return;
    }
    case 'regress-map': {
      const { handleRegressMap } = await import('./regress-map-cli.js');
      await handleRegressMap(rest);
      return;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printDevHelp();
      return;
    default:
      console.error(`[forgen] Unknown dev subcommand: ${sub}`);
      printDevHelp();
      process.exitCode = 1;
  }
}
