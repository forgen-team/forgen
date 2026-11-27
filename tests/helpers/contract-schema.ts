/**
 * 공개 출력 계약(docs/reference/public-contracts.md)의 JSON Schema 검사 도우미.
 * 스키마 파일은 npm 패키지에 실리는 assets/schemas/ 에 있다. 검증기는 새 의존 없이 이미 런타임 의존인
 * zod 4 의 z.fromJSONSchema 를 쓴다 — if/then/else 는 지원하지 않으므로 스키마는 oneOf·anyOf 로 쓴다.
 * 바깥 객체 스키마에 oneOf 를 섞으면 분기 조건이 무시되거나 "more than one option matched" 가 나므로, 분기마다 완결된 객체를 두고
 * 분기끼리 겹치지 않게(예: runId null ↔ 문자열) 쓴다.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const SCHEMAS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'schemas');

/** 'forgen-rate-limit/v1' → assets/schemas/forgen-rate-limit.v1.schema.json */
export function schemaPath(id: string): string {
  return path.join(SCHEMAS_DIR, `${id.replace(/\//g, '.')}.schema.json`);
}

export function loadSchema(id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(schemaPath(id), 'utf-8')) as Record<string, unknown>;
}

/** 스키마로 검사해 어긋난 곳 목록을 돌려준다(빈 배열 = 통과). */
export function schemaIssues(id: string, value: unknown): string[] {
  const r = z.fromJSONSchema(loadSchema(id) as never).safeParse(value);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}
