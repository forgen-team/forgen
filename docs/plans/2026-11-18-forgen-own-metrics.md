# forgen 지표 자체 관리 — HTML 화면 · 룰 목록 JSON · 이력 보관 (2026-11-18, v0.7.1)

> 계기: Handoff 요청(2026-11-18). witems 는 forgen 숫자를 더 받지 않고(수신·화면 삭제, 오너 결정: 이쪽에서 같이 지움), Handoff 는 forgen 이 있으면 보여 주기만 한다.
> forgen 혼자서 다 볼 수 있어야 하고, 남이 읽을 땐 forgen 이 내준 JSON 만 보면 되게 한다.
> 상위 설계: docs/plans/2026-11-17-rule-quality-redesign.md (D8 지표 정의 — 숫자 정의는 그대로 쓴다).

## 0. 원칙

1. 숫자 정의는 `rule-health.ts` 하나. HTML·JSON·이력 모두 같은 함수에서 나온다.
2. 읽기 명령은 아무 룰 파일도 바꾸지 않는다. 이력 기록만 `state/metrics/` 아래에 쓴다.
3. 밖으로 아무것도 보내지 않는다. HTML 은 외부 스크립트·폰트·이미지 없이 파일 하나.
4. 외부가 읽는 형식에는 schema 버전을 붙이고, 필드는 추가만 한다(바꾸려면 버전을 올린다).

## 1. `forgen rule list --json` — `forgen-rule-list/v1`

지금 `forgen rule list` 는 inspect 화면(텍스트)이다. `--json` 이면 아래를 낸다. Handoff 는 이걸로 `~/.forgen/me/rules/*.json` 직접 읽기를 그만둔다.

```jsonc
{
  "schema": "forgen-rule-list/v1",
  "generatedAt": "ISO",
  "rules": [{
    "id": "uuid", "status": "active|candidate|suppressed|removed|superseded", "phase": "active|flagged|...|null",
    "category": "...", "strength": "...", "source": "explicit_correction|behavior_inference|onboarding|...",
    "origin": "user|mined|default|other",          // 화면용 출처 요약(직접/추론/기본)
    "scope": "me|session", "projects": ["key"],   // 빈 배열 = 전역
    "statement": "정책 문구", "trigger": "...", "renderKey": "...",
    "createdAt": "ISO", "updatedAt": "ISO",
    "counts": { "inject": 0, "violation": 0, "bypass": 0 },  // lifecycle 누적값
    "lastInjectAt": "ISO|null", "lastViolationAt": "ISO|null",
    "enforce": { "hasEnforceVia": true, "mode": "block|advise", "label": "차단|탐지|자문" },
    "statusHistory": [{ "at": "ISO", "from": "...", "to": "...", "reason": "...", "by": "..." }],
    "evidence": [{ "id": "...", "at": "ISO|null", "kind": "user|mined|other", "summary": "..." }],
    "supersededBy": "id|null", "reviewedAt": "ISO|null"
  }]
}
```

- 대상: `~/.forgen/me/rules`(모든 status). `--archive` 를 주면 `rules-archive`(정리된 옛 removed 룰)도 넣고 `archived: true` 표시. 현재 폴더의 프로젝트 룰(`.forgen/rules`)은 넣지 않는다(실행 위치에 따라 결과가 달라지면 안 됨 — `--health` 와 같은 기준). 상위 schema_version 룰은 건너뛴다.
- 근거 교정: `evidence_refs` 의 증거 파일 timestamp·요약(`raw_payload.user_quote` → `summary`, 200자). 못 읽으면 `at:null, summary:null`. 룰당 최대 20개(최신 순), 넘으면 `evidenceTruncated: n`.
- `accept_count` 는 넣지 않는다(기록 경로 없음).

## 2. 이력 보관 — `state/metrics/daily/YYYY-MM-DD.json` (`forgen-daily/v1`)

**왜 필요한가**: 일별 숫자의 원천 중 일부는 오래 남지 않는다 — checks.jsonl 7일, violations.jsonl 은 10MB 회전 + 회전본 3개·60일. 증거·룰 status_history·lifecycle 로그는 남는다. 닫힌 날의 숫자를 그날 고정해 두면 원천이 지워져도 값이 남고 재계산으로 흔들리지 않는다.

**파일 하나 = UTC 하루(닫힌 날만)**
```jsonc
{ "schema": "forgen-daily/v1", "day": "2026-11-17", "writtenAt": "ISO", "forgenVersion": "0.7.1",
  "source": "closed|backfill",   // closed: 그날이 끝난 뒤 원천이 온전할 때 계산. backfill: 첫 실행 때 과거 날 일괄 계산(원천이 이미 일부 사라졌을 수 있음)
  "totals": { RuleHealthDay 와 같은 필드 },
  "rules": { "asOf": "ISO", "columns": ["id","status","phase","inject","violation","bypass"], "rows": [[...], ...] } | null }
```
- **언제 쓰나**: 세션 시작(session-recovery) 때 하루 1회 시도 — 마지막으로 쓴 날 다음 날부터 어제까지 빠진 날을 채운다. 실패해도 세션에 영향 없음(best-effort, 잠금 `state/metrics/daily.lock`, O_EXCL). `forgen status --health` 실행 때도 같은 함수를 부른다(세션 없이 CLI 만 쓰는 사용자).
- **룰 스냅샷**: 누적 카운터는 과거 시점 값을 알 수 없으므로 **쓰는 순간의 값**을 `asOf` 와 함께 넣는다. 빠진 날이 여러 날이면 가장 최근 날(어제)에만 스냅샷을 넣고 나머지는 `rules: null`. 대상은 me 룰 중 status active·candidate·flagged 와 무관하게 현재 파일 전부(행 수 ~400 × 6열, 하루 ~30KB).
- **첫 실행 backfill**: 원천이 있는 범위(가장 오래된 증거·lifecycle 로그 날짜, 최대 365일 전)까지 `source:"backfill"` 로 채운다. 차단·자문·우회처럼 회전으로 사라진 날은 0 으로 나올 수 있다 — `source` 로 구분.
- **보관 기간**: 400일. 쓸 때 400일보다 오래된 파일을 지운다. (365일 조회 + 여유)
- **정의가 바뀌면**: 파일에 `definition: N`(rule-health 정의 번호, 지금 1)을 넣는다. 읽을 때 번호가 다르면 그 날은 원천으로 다시 계산하고, 원천이 없으면 저장값을 쓰되 `stale: true` 표시.

**`--health --days N` 이 이력을 쓰는 방식**
- `--days` 상한을 90 → 365 로.
- `days[]`: 오늘은 늘 원천 계산. 닫힌 날은 저장 파일이 있으면 그 값, 없으면 원천 계산. 각 날에 `source: "live"|"closed"|"backfill"` 필드 추가.
- `flow`·`top`·`rules` 는 지금처럼 원천 기준(정의 변경 없음). 단 `flow` 중 일별 표와 같은 의미의 합계(교정·생성·은퇴·승급·차단·자문·우회)는 지금도 원천 기준이라 오래된 창에서는 `days[]` 합계보다 작을 수 있다 → 문서화하고 `flow.windowNote` 없이 README 에 적는다. (바꾸면 기존 Handoff 해석이 달라짐)
- 새 필드 `history: { retentionDays: 400, oldestDay: "YYYY-MM-DD"|null }`.
- 룰별 하루 스냅숏은 `--health` 에 넣지 않는다(크다). `forgen status --history --json [--days N] [--rule <id>]` → `forgen-rule-history/v1`: `{ days: [{ day, asOf, rows }] }`.

## 3. `forgen status --html [--out <경로>]`

- 데이터: `forgen-rule-list/v1` + `forgen-rule-health/v1`(기본 90일) + 일별 이력을 한 JSON 으로 만들어 `<script type="application/json">` 에 넣는다. `<` → `<`, ` / ` 이스케이프(스크립트 종료·주입 방지). 화면은 인라인 JS 로 그린다(외부 리소스 0, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'` meta).
- 탭 4개: **룰**(표: 분류·강도·출처·상태·막는 방식·누적 적용/어김/우회·마지막 적용·범위 — 열 정렬, 상태·출처·분류 필터, 문구 검색, 행 클릭 → 상세: 정책 문구·근거 교정·상태 이력) / **건강**(흐름·대기열·많이 막은 룰·일별 표, 일별 막대 SVG 직접 그림) / **추론 후보** / **이력**(일별 표 365일까지).
- 텍스트는 전부 `textContent` 로 넣는다(룰 문구에 HTML 이 있어도 실행 안 됨). 라이트·다크 둘 다.
- 기본 출력: `~/.forgen/state/report/forgen-status.html`(권한 600) 후 열기 — macOS `open`, Windows `cmd /c start ""`, Linux `xdg-open`(DISPLAY·WAYLAND_DISPLAY 없으면 열지 않고 경로만 출력). `--out` 이면 그 경로에 쓰고 열지 않음. 열기 실패는 경로 출력으로 대신.

## 4. witems 정리 (오너 결정: 이쪽에서 같이)

- forgen 0.7.1 배포 뒤: project-setup-server 의 forgen 지표 수신 API·저장 코드, web 의 handoff-metrics 위젯·화면 삭제. DB 테이블(`forgen_daily_metrics`, `forgen_rule_snapshots`)은 `pg_dump` 백업을 떠 두고 **남긴다**(삭제는 오너에게 따로 묻기). Handoff 가 이미 보내지 않는지 확인 후 배포. nginx 는 `nginx -s reload` 만.

## 5. 깨질 수 있는 것

- Handoff 가 아직 파일을 직접 읽는 동안: 룰 파일 형식은 그대로라 영향 없음.
- 세션 시작 지연: 일별 기록은 하루 1회, 닫힌 날 계산은 원천 읽기(수십 ms~수백 ms). 첫 backfill 은 최대 365일 계산이라 길 수 있음 → 세션 시작에서는 **최대 7일만** 채우고, 나머지 backfill 은 `forgen status --health`/`--html`/`--history` 실행 때 한다.
- 디스크: 400 × ~30KB ≈ 12MB 상한.

## 6. 테스트

- rule-list: 모든 status·근거 교정·archive·상위 schema 건너뜀, schema 고정.
- daily: 빠진 날 채우기·오늘 제외·idempotent·보관 정리·definition 불일치 재계산·잠금 경합 시 건너뜀·스냅샷은 마지막 날에만.
- health: 저장값 우선·`source` 필드·`--days 365`.
- html: 데이터 이스케이프(`</script>` 가 든 정책 문구), 외부 URL 0개(정규식 검사), `--out` 저장.
