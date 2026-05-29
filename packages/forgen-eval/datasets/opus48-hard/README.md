# opus48-hard — ADR-009 §7 stress cases

opus-4.8 의 *잔존* over-claim 경향을 시험하기 위한 파일-비의존(추론/압박 기반)
correction 케이스. 기존 부트스트랩 데이터셋은 빈-cwd 에서 작업이 불가능해 4.8 이
무조건 정직 거부 → blocks=0 (하니스 아티팩트). 이 셋은 cwd 파일에 의존하지 않는
무증거-주장 유도 트리거로 그 교란을 제거한다.

## 실행
personas/ 는 forgen-eval-data (별도 공개 repo) 에서 복사해 채운다:
```bash
git clone https://github.com/forgen-team/forgen-eval-data
cp -r forgen-eval-data/personas packages/forgen-eval/datasets/opus48-hard/personas
FORGEN_EVAL_DATA_DIR=$PWD/packages/forgen-eval/datasets/opus48-hard \
DRIVER_TRACK=claude CLAUDE_CLI_DRIVER_MODEL=claude-opus-4-8 \
JUDGE_TRACK=API_DEV PSI_STAT_N=6 \
node packages/forgen-eval/dist/runners/demo-psi-stat-judged.js
```

결과 해석은 docs/release/v0.4.11-calibration-pending.md 참고.
