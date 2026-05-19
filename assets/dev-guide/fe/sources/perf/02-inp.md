---
title: INP (Interaction to Next Paint) — FID 대체 신 지표
source: https://web.dev/articles/inp
fetched: 2026-05-18
category: web-vitals
---

## 왜 INP인가?

FID(First Input Delay)는 첫 번째 입력의 지연만 측정했다. INP는 페이지 전체 생애주기에 걸친 **모든 인터랙션**을 관찰하고, 최댓값(outlier 제외)을 최종 점수로 사용한다.
2024년 3월 Core Web Vital로 공식 승격, FID 은퇴.

---

## 임계값

| 등급 | 값 |
|------|-----|
| **Good** | ≤ 200ms |
| **Needs Improvement** | 201 ~ 500ms |
| **Poor** | > 500ms |

기준: 모바일+데스크톱 75번째 백분위수

---

## 측정 대상 인터랙션

포함:
- 마우스 클릭
- 터치스크린 탭
- 키보드 키 입력

제외 (INP 미반영):
- 스크롤
- 호버(hover)
- 확대/축소

---

## 인터랙션 구성 3단계

```
[ 입력 이벤트 ]
    ↓
1. Input Delay       — 이벤트 핸들러 실행 전까지의 대기 시간
    ↓
2. Processing Time   — 이벤트 핸들러 콜백 실행 시간
    ↓
3. Presentation Delay — 다음 프레임 렌더링까지의 시간
```

**총 INP = Input Delay + Processing Time + Presentation Delay**

---

## JavaScript 측정

```javascript
import {onINP} from 'web-vitals';

onINP(console.log);
// metric.value: 밀리초 단위 INP 점수
// metric.attribution: 어떤 인터랙션이 원인인지 상세 정보
```

`web-vitals` 라이브러리가 백분위수 계산, BFCache 리셋, visibility-change 추적을 자동 처리한다.

---

## 최적화 방향

1. **Input Delay 줄이기**: 긴 태스크(Long Task) 분할, `scheduler.yield()` 활용
2. **Processing Time 줄이기**: 이벤트 핸들러 경량화, 메인 스레드 외부(Web Worker) 이동
3. **Presentation Delay 줄이기**: DOM 크기 최소화, Layout Thrashing 방지, `requestAnimationFrame` 적절 사용

---

## INP가 0으로 보고되지 않는 경우

- 적격 인터랙션 없음 (스크롤·호버만 발생)
- 봇 접근 (스크립트 인터랙션 없음)
- 페이지 진입 후 즉시 이탈
