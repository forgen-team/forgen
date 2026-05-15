/**
 * Forgen — Desktop / webhook notification helper (ADR-008 §"테마 A 알림").
 *
 * 0.4.6 신설 — rate-limit auto-resume 이 sleep 끝나고 재기동될 때 사용자에게
 * 알림을 보냄 (노트북 닫고 잘 때 끝났는지 알 수 있어야 함).
 *
 * 정책:
 *  - macOS: osascript 'display notification'
 *  - Linux: notify-send (있으면)
 *  - Windows: 생략 (PowerShell BurntToast 의존성 회피)
 *  - webhook: ~/.forgen/config.json 의 notifyWebhookUrl 설정 시 POST
 *  - fail-open: 모든 실패는 silent log
 */

import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { FORGEN_HOME } from './paths.js';
import { createLogger } from './logger.js';

const log = createLogger('notify');

interface ForgenConfig {
  notifyWebhookUrl?: string;
  notifyDesktop?: boolean; // default true
}

function loadConfig(): ForgenConfig {
  try {
    const cfgPath = path.join(FORGEN_HOME, 'config.json');
    if (!fs.existsSync(cfgPath)) return {};
    return JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as ForgenConfig;
  } catch { return {}; }
}

function escapeForOsascript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** macOS native notification via osascript. silent fail. */
function notifyDarwin(title: string, body: string): void {
  try {
    const script = `display notification "${escapeForOsascript(body)}" with title "${escapeForOsascript(title)}"`;
    const child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
    // ENOENT 등 spawn 실패는 동기 throw 가 아니라 'error' event 로 emit 됨.
    // 핸들러 없으면 unhandled 로 process crash → headless CI 회귀 가드.
    child.on('error', (e) => log.debug('osascript notification 실패 (event)', e));
    child.unref();
  } catch (e) { log.debug('osascript notification 실패', e); }
}

/** Linux notify-send. silent fail (notify-send 미설치 OK). */
function notifyLinux(title: string, body: string): void {
  try {
    const child = spawn('notify-send', [title, body], { detached: true, stdio: 'ignore' });
    // headless 환경 (CI, Docker) 에서 notify-send 부재 시 ENOENT 가 'error' event 로 emit.
    // 핸들러 없으면 unhandled 로 caller 프로세스 죽음 — rate-limit-spawn-integration
    // CI 실패의 사전 존재 원인.
    child.on('error', (e) => log.debug('notify-send 실패 (event)', e));
    child.unref();
  } catch (e) { log.debug('notify-send 실패', e); }
}

/** webhook POST (slack/discord 호환). silent fail. */
async function notifyWebhook(url: string, title: string, body: string): Promise<void> {
  try {
    // Slack / Discord 호환 — text 필드 우선, fallback 으로 content
    const payload = JSON.stringify({
      text: `*${title}*\n${body}`,
      content: `**${title}**\n${body}`, // Discord
    });
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
  } catch (e) { log.debug('webhook notify 실패', e); }
}

/**
 * 통합 알림 진입점. desktop + webhook 둘 다 시도.
 * 모든 실패는 silent — 호출 측 차단 안 함.
 */
export function sendNotification(title: string, body: string): void {
  const cfg = loadConfig();
  const desktopEnabled = cfg.notifyDesktop !== false; // default true

  if (desktopEnabled) {
    const platform = os.platform();
    if (platform === 'darwin') notifyDarwin(title, body);
    else if (platform === 'linux') notifyLinux(title, body);
    // win32: 생략
  }

  if (cfg.notifyWebhookUrl) {
    // fire-and-forget — await 하지 않음 (caller 차단 방지)
    void notifyWebhook(cfg.notifyWebhookUrl, title, body);
  }
}
