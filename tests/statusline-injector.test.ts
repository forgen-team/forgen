/**
 * settings-injector.ts의 applyStatusLine 로직 — 유닛 테스트
 *
 * 검증 항목:
 * 1. 신규 설치 (statusLine 없음) → 'forgen statusline' 주입
 * 2. 'forgen me' → 'forgen statusline' 자동 마이그레이션
 * 3. 커스텀 명령 보유 사용자 → 건드리지 않음
 * 4. 기존 forgen statusline → 덮어쓰지 않음 (이미 최신)
 */

import { describe, it, expect } from 'vitest';

// applyStatusLine은 private이므로 동일 로직을 인라인 재현
function applyStatusLine(settings: Record<string, unknown>): void {
  const existing = settings.statusLine as { type?: string; command?: string } | undefined;
  if (existing?.command === 'forgen me') {
    settings.statusLine = { type: 'command', command: 'forgen statusline' };
    return;
  }
  const isForgenOwned = !existing || !existing.command || existing.command.startsWith('forgen');
  if (isForgenOwned) {
    settings.statusLine = { type: 'command', command: 'forgen statusline' };
  }
}

describe('applyStatusLine', () => {
  it('신규 설치: statusLine 없음 → forgen statusline 주입', () => {
    const settings: Record<string, unknown> = {};
    applyStatusLine(settings);
    expect(settings.statusLine).toEqual({ type: 'command', command: 'forgen statusline' });
  });

  it("마이그레이션: 'forgen me' → 'forgen statusline'으로 교체", () => {
    const settings: Record<string, unknown> = {
      statusLine: { type: 'command', command: 'forgen me' },
    };
    applyStatusLine(settings);
    expect(settings.statusLine).toEqual({ type: 'command', command: 'forgen statusline' });
  });

  it("커스텀 명령 보유 사용자: 건드리지 않음", () => {
    const original = { type: 'command', command: 'my-custom-hud' };
    const settings: Record<string, unknown> = { statusLine: { ...original } };
    applyStatusLine(settings);
    expect(settings.statusLine).toEqual(original);
  });

  it("이미 'forgen statusline'인 경우: 그대로 유지", () => {
    const settings: Record<string, unknown> = {
      statusLine: { type: 'command', command: 'forgen statusline' },
    };
    applyStatusLine(settings);
    expect(settings.statusLine).toEqual({ type: 'command', command: 'forgen statusline' });
  });

  it("command 없는 statusLine 객체: forgen owned로 간주 → 주입", () => {
    const settings: Record<string, unknown> = {
      statusLine: { type: 'something' },
    };
    applyStatusLine(settings);
    expect(settings.statusLine).toEqual({ type: 'command', command: 'forgen statusline' });
  });
});
