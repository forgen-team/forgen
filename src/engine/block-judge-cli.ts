#!/usr/bin/env node
/**
 * block-judge-cli — detached 자동 판정 프로세스 진입점 (ADR-017 D1).
 * 사용: node dist/engine/block-judge-cli.js <violation_id>
 * 훅이 spawn 하며 결과는 verdicts.jsonl 에만 남긴다. 어떤 경우에도 exit 0.
 */
import { judgeViolation } from './block-judge.js';

const id = process.argv[2];
if (!id) process.exit(0);
judgeViolation(id).then(() => process.exit(0)).catch(() => process.exit(0));
