/**
 * auto-compound Haiku 추출 동의 (ADR-012 D 티어드).
 *
 * 결정론 경로(교정→룰 승급·notepad 주입, egress 0)는 항상 동작하고, **Haiku 로 transcript
 * 요약을 전송하는 추출만** 이 동의로 게이트한다(default opt-in=off). "우리는 당신 몰래
 * API 로 보내지 않는다".
 *
 * 우선순위: FORGEN_NO_AUTO_COMPOUND(강제 off) > FORGEN_AUTO_COMPOUND(강제 on) >
 *           config(~/.forgen/config.json.autoCompoundHaiku) > default(false).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FORGEN_HOME } from './paths.js';

export type ConsentSource = 'env-off' | 'env-on' | 'config' | 'default';
export interface ConsentState {
  enabled: boolean;
  source: ConsentSource;
}

/** 순수: env + config 값으로 Haiku 동의 해석 (테스트 가능). */
export function resolveHaikuConsent(
  env: { no?: string; on?: string },
  configValue: boolean | undefined,
): ConsentState {
  if (env.no === '1') return { enabled: false, source: 'env-off' };
  if (env.on === '1') return { enabled: true, source: 'env-on' };
  if (typeof configValue === 'boolean') return { enabled: configValue, source: 'config' };
  return { enabled: false, source: 'default' }; // ADR-012: opt-in
}

const CONFIG_PATH = path.join(FORGEN_HOME, 'config.json');

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function getHaikuConsentState(): ConsentState {
  const cfg = readConfig();
  const configValue =
    typeof cfg.autoCompoundHaiku === 'boolean' ? (cfg.autoCompoundHaiku as boolean) : undefined;
  return resolveHaikuConsent(
    { no: process.env.FORGEN_NO_AUTO_COMPOUND, on: process.env.FORGEN_AUTO_COMPOUND },
    configValue,
  );
}

/** 러너가 Haiku 전송 전에 확인. */
export function isHaikuCompoundEnabled(): boolean {
  return getHaikuConsentState().enabled;
}

/** 동의 저장(config.json 병합). env override 는 건드리지 않음. */
export function setHaikuCompoundConsent(enabled: boolean): void {
  const cfg = readConfig();
  cfg.autoCompoundHaiku = enabled;
  fs.mkdirSync(FORGEN_HOME, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
}
