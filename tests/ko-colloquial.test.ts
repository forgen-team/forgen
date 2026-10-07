import { describe, it, expect } from 'vitest';
import { normalizeColloquialKo } from '../src/engine/ko-colloquial.js';
import { extractTags } from '../src/engine/solution-format.js';

describe('normalizeColloquialKo', () => {
  it('순수 구어(지시어·접속어·종결 어미)는 드롭한다', () => {
    for (const w of ['같아', '같은데', '왜냐면', '시켜보자', '이거', '근데', '알려줘', '했는지', '거야']) {
      expect(normalizeColloquialKo(w), w).toBeNull();
    }
  });

  it('명사+구어 어미는 어간만 남긴다', () => {
    expect(normalizeColloquialKo('검증해줘')).toBe('검증');
    expect(normalizeColloquialKo('가능한')).toBe('가능한'); // 1글자 어미는 제거 안 함 — 명사(권한·역할) 보호가 우선 (critic v0.6.6)
    expect(normalizeColloquialKo('배포하는지')).toBe('배포');
  });

  it('어간 자체가 구어면 통째로 드롭한다', () => {
    expect(normalizeColloquialKo('진행해보자')).toBe('진행');
    expect(normalizeColloquialKo('진행해줘')).toBeNull();
  });

  it('어간이 2자 미만이면 어미를 떼지 않는다 (이해/제한/피해)', () => {
    for (const w of ['이해', '제한', '피해', '설치', '병합']) {
      expect(normalizeColloquialKo(w)).toBe(w);
    }
  });

  it('주제어는 그대로 둔다', () => {
    for (const w of ['설치', '플러그인', '렌더링', '아키텍처']) expect(normalizeColloquialKo(w)).toBe(w);
  });
});

describe('extractTags — 회화체 잔여물', () => {
  it('회화체 프롬프트에서 주제어만 남는다', () => {
    const tags = extractTags('이거 codex 설치가 안 되는 거 같아 왜냐면 시켜보자');
    expect(tags).toContain('codex');
    expect(tags).toContain('설치');
    for (const junk of ['같아', '왜냐면', '시켜보자', '이거']) expect(tags).not.toContain(junk);
  });

  it('잔여물이 8칸을 채우지 못해 뒤쪽 주제어가 살아남는다', () => {
    const tags = extractTags('근데 지금 이제 일단 이거 그럼 어떤 전부 계속 우리 rule 병합');
    expect(tags).toEqual(expect.arrayContaining(['rule', '병합']));
  });

  it('영문 프롬프트는 변하지 않는다', () => {
    expect(extractTags('statusline renderer budget')).toEqual(['statusline', 'renderer', 'budget']);
  });
});

describe('critic v0.6.6 회귀 — 1글자 어미가 명사를 자르지 않는다', () => {
  it('권한·역할·제한·피해 복합 명사 보존, 하자·인지 는 드롭하지 않음', async () => {
    const { normalizeColloquialKo } = await import('../src/engine/ko-colloquial.js');
    for (const w of ['접근권한', '파일권한', '최소권한', '무제한', '관리자역할', '사용자역할', '환경피해', '하자', '인지']) {
      expect(normalizeColloquialKo(w)).toBe(w);
    }
    expect(normalizeColloquialKo('검증해줘')).toBe('검증');
    expect(normalizeColloquialKo('동기화해야')).toBe('동기화');
  });
});
