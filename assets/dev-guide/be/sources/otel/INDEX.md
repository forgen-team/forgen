---
title: OpenTelemetry 문서 인덱스
fetched: 예정 (2026-05-18 스캐폴드)
license: Apache-2.0 (https://opentelemetry.io)
priority: 4 (출처 우선순위)
---

# OpenTelemetry (OTel)

> 관찰가능성(Observability) 표준. Traces + Metrics + Logs 통합 계측.

## 출처

| URL | 설명 |
|-----|------|
| https://opentelemetry.io/docs/ | OTel 공식 문서 |
| https://opentelemetry.io/docs/languages/js/ | JavaScript/Node.js SDK |
| https://opentelemetry.io/docs/languages/go/ | Go SDK |
| https://opentelemetry.io/docs/concepts/signals/ | Signals 개념 (Traces/Metrics/Logs) |
| https://opentelemetry.io/docs/specs/otel/ | 명세 |
| https://w3c.github.io/trace-context/ | W3C TraceContext (traceparent 헤더) |

## 라이선스

Apache-2.0

## 수집일

예정 (2026-05-18 스캐폴드)

## 참조 우선순위

4 (common.md 출처 우선순위)

## 문서 목록 (수집 예정)

| 파일명 (예정) | 주제 |
|--------------|------|
| concepts-traces.md | Traces, Spans, TraceContext |
| concepts-metrics.md | Metrics — Counters, Histograms, Gauges |
| concepts-logs.md | Structured Logs + Log Correlation |
| sdk-node-setup.md | Node.js SDK 설정 + 자동 계측 |
| sdk-go-setup.md | Go SDK 설정 + 자동 계측 |
| propagation.md | Context Propagation (W3C TraceContext) |
| semantic-conventions.md | HTTP/DB 속성 명명 규칙 |
| exporters.md | OTLP, Jaeger, Prometheus exporter |

## 핵심 참조 원칙 (principles/common.md 연결)

- Traces → Observability C.3 분산 트레이스
- W3C TraceContext → C.3 traceparent 헤더 전파
- Metrics → C.2 RED Method 계측
- Semantic Conventions → 속성 이름 표준화
