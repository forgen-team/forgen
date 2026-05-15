/**
 * notify.ts fail-safe — notifier binary 부재 시 process crash 안 함.
 *
 * 사전 존재 버그 (v0.4.7 까지): spawn('notify-send' / 'osascript') 실패는
 * 'error' event 로 emit 되는데 핸들러가 없어 unhandled. headless CI 또는
 * 알림 도구 미설치 환경에서 rate-limit-spawn-integration 등이 ENOENT 로
 * 죽었음. v0.4.8 fix: child.on('error', ...) 핸들러 추가.
 */
import { describe, it, expect } from 'vitest';
import { sendNotification } from '../src/core/notify.js';

describe('notify fail-safe — missing notifier binary', () => {
  it('PATH 비워도 sendNotification 이 throw 하지 않음 (동기)', () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    try {
      expect(() => sendNotification('test', 'body')).not.toThrow();
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it('PATH 비워도 비동기 spawn error event 가 unhandled crash 를 일으키지 않음', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '';
    let unhandled: Error | null = null;
    const handler = (err: Error): void => { unhandled = err; };
    process.on('uncaughtException', handler);
    try {
      sendNotification('test', 'body');
      // 'error' event 가 next tick 에 emit — 충분히 대기.
      await new Promise((r) => setTimeout(r, 150));
      expect(unhandled).toBeNull();
    } finally {
      process.removeListener('uncaughtException', handler);
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
});
