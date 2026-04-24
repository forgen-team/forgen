/**
 * v0.4.1 false-positive 수정 — `rm -rf /tmp/*` 같은 임시 디렉터리 정리는 개발
 * 일상 작업. 이전 패턴 `/` 시작 전부 block 은 실 사용자 경험에서 치명적 오탐.
 * 이 테스트는 안전한 임시 경로 pass + 위험한 시스템 경로 block 회귀를 pin.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// dangerous-patterns.json 의 regex 를 런타임 그대로 읽어 테스트
function loadRmRfPattern(): RegExp {
  const patterns = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'src/hooks/dangerous-patterns.json'), 'utf-8'),
  ) as Array<{ pattern: string; description: string }>;
  const entry = patterns.find((p) => p.description === 'rm -rf on root/home path');
  if (!entry) throw new Error('rm -rf pattern not found');
  return new RegExp(entry.pattern);
}

describe('dangerous-patterns — rm -rf 경로 allowlist (v0.4.1)', () => {
  const re = loadRmRfPattern();

  it('rm -rf / 는 block (root 자체)', () => {
    expect(re.test('rm -rf /')).toBe(true);
  });

  it('rm -rf /etc 는 block (시스템 경로)', () => {
    expect(re.test('rm -rf /etc/nginx')).toBe(true);
  });

  it('rm -rf /usr 는 block', () => {
    expect(re.test('rm -rf /usr/local')).toBe(true);
  });

  it('rm -rf /Users/foo 는 block (homedir)', () => {
    expect(re.test('rm -rf /Users/jang-ujin/important')).toBe(true);
  });

  it('rm -rf ~ 는 block', () => {
    expect(re.test('rm -rf ~/.config')).toBe(true);
  });

  it('rm -rf /tmp/foo 는 pass (허용된 임시 경로)', () => {
    expect(re.test('rm -rf /tmp/foo')).toBe(false);
  });

  it('rm -rf /tmp 는 pass', () => {
    expect(re.test('rm -rf /tmp')).toBe(false);
  });

  it('rm -rf /var/folders/... 는 pass (macOS 임시)', () => {
    expect(re.test('rm -rf /var/folders/b0/x/T/tmpdir')).toBe(false);
  });

  it('rm -rf /var/tmp/... 는 pass', () => {
    expect(re.test('rm -rf /var/tmp/build')).toBe(false);
  });

  it('rm -rf /var/log 는 block (/tmp 아님)', () => {
    expect(re.test('rm -rf /var/log/system')).toBe(true);
  });

  it('rm -rf /var 는 block', () => {
    expect(re.test('rm -rf /var')).toBe(true);
  });
});
