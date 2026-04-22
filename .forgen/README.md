# forgen self-dogfood — L1 Hard Rules

이 디렉토리는 ADR-003 Phase 1 "자기 적용" — forgen 저장소에서 Claude Code 를 쓸 때 forgen 자신의 L1 규칙이 실제 hook 으로 발화하도록 하는 committed 설정.

## L1 규칙 (hard, 승급 불가)

| Rule ID | 정책 | Mech | Hook |
|---------|------|------|------|
| `L1-e2e-before-done` | Docker e2e 증거 없이 완료 선언 금지 | A | Stop |
| `L1-no-mock-as-proof` | mock/stub/fake 기반 검증 완료 선언 금지 | B | Stop |
| `L1-no-rm-rf-unconfirmed` | 사용자 confirm 없는 rm -rf 금지 | A | PreToolUse |
| `L1-no-secret-commit` | API key 패턴 커밋/푸시 금지 | A | PostToolUse |

## 활성화 (v0.4.0 부터 자동)

프로젝트 로컬 `.forgen/rules/*.json` 은 **v0.4.0 부터 자동 로드됩니다**. `forgen` 을 이 저장소 cwd 에서 실행하면 `loadActiveRules` 가 `~/.forgen/me/rules/` 와 이 디렉토리를 병합해 로드하며, 같은 `rule_id` 가 있으면 프로젝트 rules 가 우선합니다 (git 이 정책 진실).

### 검증

```bash
# Live smoke — 완료 선언이 실제로 block 되는지 (evidence 없을 때)
echo '{"session_id":"live","stop_hook_active":true,"last_assistant_message":"구현 완료했습니다."}' | \
  HOME=/tmp FORGEN_CWD=$(pwd) FORGEN_SPIKE_RULES=/tmp/empty.json \
  node dist/hooks/stop-guard.js
# → {"continue":true,"decision":"block","reason":"L1-e2e-before-done: ...","systemMessage":"rule:L1-e2e-before-done"}
```

### 비활성화

```bash
# 테스트 / 격리 환경에서 프로젝트 rule 자동 로드를 끄려면
FORGEN_DISABLE_PROJECT_RULES=1 forgen ...
```

## 검증 (self-gate)

```bash
node scripts/self-gate.cjs           # 정적
node scripts/self-gate-runtime.cjs   # hook smoke 6 시나리오
```

CI 는 `.github/workflows/self-gate.yml` 이 push/PR 마다 자동 실행.
