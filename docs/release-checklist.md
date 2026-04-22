# Forgen Release Checklist

모든 릴리즈는 이 체크리스트를 통과해야 태깅/배포 가능.

## 전제

- [ ] 브랜치: `main` 에서 분기한 release branch (예: `release/v0.4.0`)
- [ ] 작업 트리 clean (`git status --short` 빈 결과)
- [ ] 대상 버전 결정 (semver)

## 코드 품질

- [ ] `npm run build` 성공 (tsc + copy-assets + chmod)
- [ ] `npx tsc --noEmit` clean (경고 0)
- [ ] `npm test` 전체 pass (회귀 기준 변동, `npm test` 출력의 `Tests passed` 를 CHANGELOG 에 기록)
- [ ] `node dist/cli.js doctor` `✓ All diagnostics passed`

## Self-gate (ADR-003)

- [ ] `node scripts/self-gate.cjs` — 정적 스캔 전부 pass (mock-in-production, secrets-leak, enforce_via-missing, release-artifact)
- [ ] `node scripts/self-gate-runtime.cjs` — 6 hook scenarios pass
- [ ] `.forgen-release/e2e-report.json` 생성 (`{ passed: true, mock_detected: false }`)
- [ ] (tag 후) `node scripts/self-gate-release.cjs` — version/tag/CHANGELOG/dist/e2e-report 전부 일치

## 문서

- [ ] `CHANGELOG.md` 에 `## [<버전>] - <YYYY-MM-DD>` 섹션 추가 및 주요 변경 기록
- [ ] 신규 CLI 가 있으면 `src/cli.ts printHelp` + `README.md` 업데이트
- [ ] 신규 ADR 은 `Status: Accepted (<날짜>)` + implementation evidence 링크
- [ ] breaking change 있으면 migration 안내

## 버전 + 태그

- [ ] `package.json` `version` 필드를 대상 버전으로 bump
- [ ] commit: `chore(release): v<버전>` (release commit 식별자)
- [ ] tag: `git tag v<버전>` (semver prefix)
- [ ] `git push --follow-tags` — CI 의 self-gate 워크플로우가 tag 단계에서 `self-gate-release.cjs` 실행

## 발행

- [ ] `npm publish` (pre-packaged dist/ 포함 확인)
- [ ] GitHub Release 노트 — CHANGELOG 해당 섹션 copy
- [ ] ADR 표에서 해당 릴리즈가 landing 한 Status 확인

## Post-release

- [ ] 이슈 트래커에 release 관련 우산 이슈 close
- [ ] ADR 에 "Shipped in v<버전>" 추가 (필요 시)
- [ ] 릴리즈 후 48시간 모니터링 (drift.jsonl 이상 증가 여부, doctor 경고)

## Maintainer 예외

릴리즈가 self-gate 의 특정 check 를 일시 우회해야 할 때:

- [ ] PR 에 `self-gate-override` 라벨 (maintainer 2인 승인 필수)
- [ ] 라벨 사용 이유 PR 본문에 명시 (감사 로그용)
- [ ] 다음 릴리즈에서 우회 원인 복구

**주의**: `self-gate-override` 라벨은 보안 완화가 아니라 **허용 가능한 일시적 빌드 깨짐** 용 (예: upstream 의존성 일시 breakage). 보안 check (secrets-leak 등) 는 우회 대상 아님.
