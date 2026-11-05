/**
 * v0.4.1 false-positive 수정 — 임시 디렉터리 정리는 개발 일상 작업. 이 테스트는 임시 경로 면제와
 * 위험한 시스템 경로 차단 회귀를 pin 한다.
 * D12-A: 판정 주체가 dangerous-patterns.json 정규식에서 command-analyzer 로 바뀌었다.
 *  - 시스템/홈/루트 재귀 삭제 = block, claude 임시(`/tmp/claude-*`, `/var/folders/`) = pass,
 *    그 외 경로 = ask(사용자 확인 요청).
 */
import { describe, it, expect } from 'vitest';
import { checkDangerousCommand } from '../src/hooks/pre-tool-use.js';

const RM = ['r', 'm', ' -', 'rf'].join('');
const act = (c: string) => checkDangerousCommand('Bash', { command: c }, '/work/proj').action;

describe('rm -rf 경로 정책 (v0.4.1 → D12-A)', () => {
  it('root / 시스템 경로 / 홈은 block', () => {
    for (const t of ['/', '/etc/nginx', '/usr/local', '~', '/var', '/var/log/system']) {
      expect(act(`${RM} ${t}`), t).toBe('block');
    }
  });
  it('홈 아래 일반 경로는 확인 요청(ask)', () => {
    expect(act(`${RM} /Users/jang-ujin/important`)).toBe('ask');
    expect(act(`${RM} ~/.config`)).toBe('ask');
  });
  it('claude 임시 경로(/tmp/claude-*, macOS /var/folders)는 pass', () => {
    expect(act(`${RM} /tmp/claude-1001/x/build`)).toBe('pass');
    expect(act(`${RM} /var/folders/b0/x/T/tmpdir`)).toBe('pass');
  });
  it('일반 /tmp·/var/tmp 하위는 확인 요청(ask) — 사용자 파일일 수 있다', () => {
    expect(act(`${RM} /tmp/foo`)).toBe('ask');
    expect(act(`${RM} /tmp`)).toBe('ask');
    expect(act(`${RM} /var/tmp/build`)).toBe('ask');
  });
});
