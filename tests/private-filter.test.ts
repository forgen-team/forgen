import { describe, it, expect } from 'vitest';
import { stripPrivate, isFullyPrivate } from '../src/engine/private-filter.js';

describe('private-filter (W2-5)', () => {
  it('블록 <private>…</private> 범위 제거 + hadPrivate', () => {
    const r = stripPrivate('keep this <private>secret token abc</private> and this');
    expect(r.cleaned).toBe('keep this  and this');
    expect(r.hadPrivate).toBe(true);
  });

  it('다중 라인 블록 제거', () => {
    const r = stripPrivate('a\n<private>\nline1\nline2\n</private>\nb');
    expect(r.cleaned.replace(/\n+/g, '\n').trim()).toBe('a\nb');
    expect(r.hadPrivate).toBe(true);
  });

  it('라인 마커 // forgen:private / # forgen:private 제거', () => {
    const r = stripPrivate('public line\nsecret = xyz // forgen:private\nmore public\npwd=1 # forgen:private');
    expect(r.cleaned).not.toContain('secret = xyz');
    expect(r.cleaned).not.toContain('pwd=1');
    expect(r.cleaned).toContain('public line');
    expect(r.cleaned).toContain('more public');
    expect(r.hadPrivate).toBe(true);
  });

  it('대소문자 무시 (<PRIVATE>)', () => {
    expect(stripPrivate('x <PRIVATE>y</PRIVATE> z').hadPrivate).toBe(true);
  });

  it('private 없으면 원본 그대로, hadPrivate=false', () => {
    const r = stripPrivate('nothing private here');
    expect(r.cleaned).toBe('nothing private here');
    expect(r.hadPrivate).toBe(false);
  });

  it('빈/undefined 입력 안전', () => {
    expect(stripPrivate('').hadPrivate).toBe(false);
    expect(stripPrivate(undefined as unknown as string).cleaned).toBe('');
  });

  it('isFullyPrivate: 통째 private → true, 부분 → false', () => {
    expect(isFullyPrivate('<private>all of it</private>')).toBe(true);
    expect(isFullyPrivate('  <private>x</private>  \n ')).toBe(true);
    expect(isFullyPrivate('keep <private>x</private> this')).toBe(false);
    expect(isFullyPrivate('nothing private')).toBe(false);
    expect(isFullyPrivate('')).toBe(false);
  });

  // ── fail-closed 강화 (flow-reviewer SEV-2: 미닫힘/변형 태그 누출 방지) ──

  it('fail-closed: 미닫힘 <private> 는 EOF 까지 제거 (닫기 잊은 사용자 보호)', () => {
    const r = stripPrivate('public prefix <private>my secret password never closed');
    expect(r.hadPrivate).toBe(true);
    expect(r.cleaned).not.toContain('secret password');
    expect(r.cleaned.trim()).toBe('public prefix');
  });

  it('fail-closed: 미닫힘 통째 private → isFullyPrivate true', () => {
    expect(isFullyPrivate('<private>everything after with no close')).toBe(true);
  });

  it('중첩 <private> 는 바깥까지 완전 제거 (꼬리 누출 없음)', () => {
    const r = stripPrivate('a<private>x<private>y</private>z</private>b');
    expect(r.cleaned).toBe('ab');
    expect(r.cleaned).not.toContain('z');
    expect(r.cleaned).not.toContain('private');
    expect(r.hadPrivate).toBe(true);
  });

  it('공백/속성 있는 태그도 매칭 (<private > / <private foo="1">)', () => {
    expect(stripPrivate('a <private >secret</private > b').cleaned.trim()).toBe('a  b');
    const r = stripPrivate('a <private data-x="1">secret</private> b');
    expect(r.cleaned).not.toContain('secret');
    expect(r.hadPrivate).toBe(true);
  });

  it('블록주석 스타일 라인 마커 /* forgen:private 제거', () => {
    const r = stripPrivate('keep\nconst k = "x"; /* forgen:private */\nkeep2');
    expect(r.cleaned).not.toContain('const k');
    expect(r.cleaned).toContain('keep');
    expect(r.cleaned).toContain('keep2');
  });

  it('멀티 블록 모두 제거', () => {
    const r = stripPrivate('a<private>1</private>b<private>2</private>c');
    expect(r.cleaned).toBe('abc');
  });
});
