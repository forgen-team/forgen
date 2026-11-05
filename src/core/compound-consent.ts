/**
 * auto-compound Haiku 추출 설정 (ADR-019, ADR-012 D 대체).
 *
 * 결정론 경로(교정→룰 승급·인덱싱, egress 0)는 항상 동작한다. **Haiku 로 transcript 요약을 보내는
 * 추출**은 기본 ON 이다(2026-11-04 결정: opt-in 은 실사용자 0 으로 추출 경로가 죽어 있었다).
 * 대신 "몰래 보내지 않는다"를 지킨다: 최초 1회 사용자에게 보이는 안내(무엇이 전송되는지·끄는 법),
 * 명시적 OFF(config false / FORGEN_NO_AUTO_COMPOUND=1) 존중, 비밀 마스킹·<private> 제거.
 *
 * 우선순위: FORGEN_NO_AUTO_COMPOUND(강제 off) > FORGEN_AUTO_COMPOUND(강제 on) >
 *           config(~/.forgen/config.json.autoCompoundHaiku) > default(true).
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
  return { enabled: true, source: 'default' }; // ADR-019: 기본 ON, 최초 1회 안내
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

// ── 사용자에게 보이는 안내 (SessionStart / 래퍼 시작) ──

/**
 * 전송 범위 문구의 단일 소스 (ADR-019). 안내·`consent status`·README 가 같은 사실을 말한다:
 * 사용자 발화와 어시스턴트 발화가 들어가고(어시스턴트 발화에는 읽은 파일 내용의 일부가 섞일 수 있다),
 * 비밀키는 마스킹하고 <private> 구간은 제외한다. 내 계정의 Claude Haiku 로만 보낸다.
 */
export const HAIKU_SCOPE_TEXT =
  '세션이 끝나면 대화 요약(내 발화와 어시스턴트 발화 — 어시스턴트가 읽은 파일 내용의 일부가 섞일 수 있음; ' +
  '비밀키는 마스킹, <private> 구간은 제외)을 내 계정의 Claude Haiku 로 보내 재사용 패턴을 뽑습니다. 다른 서버로는 보내지 않습니다.';

export const HAIKU_OFF_HOWTO = '끄기: forgen compound consent off  (또는 FORGEN_NO_AUTO_COMPOUND=1)';

/** ANTHROPIC_API_KEY 가 있으면 claude 는 구독이 아니라 API 키로 과금한다. */
export function apiBillingNote(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  return 'ANTHROPIC_API_KEY 가 설정돼 있어 추출 호출이 API 과금 계정으로 청구됩니다(호출당 과금, 구독 한도가 아님). ' +
    '끄기: forgen compound consent off  (또는 FORGEN_NO_AUTO_COMPOUND=1)';
}

export const HAIKU_FIRST_NOTICE = `[Forgen] 세션 학습이 켜져 있습니다. ${HAIKU_SCOPE_TEXT} ${HAIKU_OFF_HOWTO}`;

const NOTICE_PATH = path.join(FORGEN_HOME, 'state', 'haiku-consent-notice.json');

function readNotice(): { firstShown?: string; unavailableShownOn?: string; billingShown?: string } {
  try { return JSON.parse(fs.readFileSync(NOTICE_PATH, 'utf-8')); } catch { return {}; }
}
function writeNotice(n: { firstShown?: string; unavailableShownOn?: string; billingShown?: string }): void {
  try {
    fs.mkdirSync(path.dirname(NOTICE_PATH), { recursive: true });
    fs.writeFileSync(NOTICE_PATH, JSON.stringify(n));
  } catch { /* 안내 기록 실패는 무시 */ }
}

/** 모델 호출 없이 PATH 만 훑는 값싼 확인 (SessionStart 는 지연에 민감하다). */
export function claudeOnPathSync(pathEnv: string = process.env.PATH ?? ''): boolean {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const e of exts) {
      try { fs.accessSync(path.join(dir, `claude${e}`), fs.constants.X_OK); return true; } catch { /* next */ }
    }
  }
  return false;
}

/**
 * 세션 시작 때 사용자에게 보일 한 줄(없으면 null).
 *  1) 기본값으로 켜진 채 처음 맞는 세션: 무엇이 전송되는지·끄는 법 (1회)
 *  2) 켜져 있지만 직전 호출/판정이 "호출 불가"였다면 사유 (하루 1회) — 결정론 경로는 계속 동작
 */
export async function takeSessionStartNotice(now = new Date()): Promise<string | null> {
  const c = getHaikuConsentState();
  if (!c.enabled) return null;
  const n = readNotice();
  const parts: string[] = [];
  const billing = apiBillingNote();
  if (c.source === 'default' && !n.firstShown) {
    parts.push(HAIKU_FIRST_NOTICE);
    n.firstShown = now.toISOString();
    if (billing) { parts.push(`[Forgen] ${billing}`); n.billingShown = now.toISOString(); }
  } else if (billing && !n.billingShown) {
    // 처음 안내 뒤에 API 키가 생긴 경우도 한 번은 알린다.
    parts.push(`[Forgen] ${billing}`);
    n.billingShown = now.toISOString();
  }
  try {
    const { readHaikuStatus } = await import('./extraction-haiku.js');
    const st = readHaikuStatus();
    const day = now.toISOString().slice(0, 10);
    let reason: string | undefined;
    if (!claudeOnPathSync()) reason = 'claude CLI 를 PATH 에서 찾지 못함';
    else if (st && !st.ok && st.outcome === 'unavailable') reason = st.reason ?? '원인 미상';
    if (reason && n.unavailableShownOn !== day) {
      parts.push(`[Forgen] Haiku 추출 불가: ${reason}. 교정→룰 승급과 세션 검색은 계속 동작합니다.`);
      n.unavailableShownOn = day;
    }
  } catch { /* 상태 파일 없음 */ }
  if (parts.length === 0) return null;
  writeNotice(n);
  return parts.join('\n');
}
