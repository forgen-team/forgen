/**
 * 2026-10-07 Stop 룰 재설계 — 30일 실대화 리플레이에서 드러난 결함의 회귀 방지.
 *  1) 제외 조건은 매칭된 문장에만 적용(다른 문장의 '없습니다' 가 완료 보고를 죽이던 결함)
 *  2) 룰별 발동 조건 — mock 은 '단어'가 아니라 '그걸로 검증했다' 주장, 구현먼저는 '바로 구현했다', 주제 룰은 같은 문장 결합
 *  3) critic 룰은 자기 신고 대신 최근 도구 기록(Agent/Task/Workflow)으로 판정
 *  4) 언어 룰은 한글 비율로 기계 판정
 */
import { describe, it, expect } from 'vitest';
import { evaluateStop, type SpikeRule } from '../src/hooks/stop-guard.js';
import { chooseStopTrigger, extractTopicTerms, retuneStopSpecs, classify } from '../src/engine/enforce-classifier.js';
import { DEFAULT_STOP_EXCLUDE_RE, MOCK_EXCLUDE_RE, COMPLETION_TRIGGER_V2_RE, CHUNK_EVIDENCE_RE } from '../src/hooks/shared/stop-triggers.js';
import { compileSafeRegex } from '../src/hooks/shared/safe-regex.js';
import type { Rule } from '../src/store/types.js';

const spike = (id: string, trigger: string, exclude: string | undefined, verifier: SpikeRule['verifier']): SpikeRule => ({
  id, hook: 'Stop', trigger: { response_keywords_regex: trigger, context_exclude_regex: exclude }, verifier, block_message: id, system_tag: id,
} as unknown as SpikeRule);
const selfCheck = { kind: 'self_check_prompt', params: { question: 'q' } } as SpikeRule['verifier'];

const rule = (rule_id: string, policy: string, strength: Rule['strength'] = 'default'): Rule => ({
  rule_id, category: 'quality', scope: 'me', trigger: policy.slice(0, 20), policy, strength, source: 'explicit_correction',
  status: 'active', evidence_refs: [], render_key: `k.${rule_id}`, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  enforce_via: [{ mech: 'B', hook: 'Stop', verifier: { kind: 'self_check_prompt', params: {} }, trigger_keywords_regex: '(완료했)', trigger_exclude_regex: '(없음)' }],
} as unknown as Rule);

describe('제외 조건은 매칭된 문장에만', () => {
  const r = spike('c', '(완료했|끝냈)', DEFAULT_STOP_EXCLUDE_RE, selfCheck);
  it('다른 문장의 "없습니다" 는 완료 보고를 제외시키지 않는다', () => {
    expect(evaluateStop('작업을 완료했습니다. 남은 실패는 없습니다.', [r]).action).toBe('block');
  });
  it('같은 문장의 철회·부정은 여전히 제외한다', () => {
    expect(evaluateStop('아직 완료했다고 말할 수 없습니다.', [r]).action).toBe('approve');
  });
});

describe('문장 경계 (critic SEV-1 재현 입력)', () => {
  const r = spike('c2', COMPLETION_TRIGGER_V2_RE, DEFAULT_STOP_EXCLUDE_RE, selfCheck);
  it.each([
    ['아직 안 끝났습니다. 내일 이어서 하겠습니다.', 'approve'],
    ['The migration is not yet done. Continuing tomorrow.', 'approve'],
    ['It is no longer finished. ok', 'approve'],
    ['All done. Nothing is not yet pending.', 'block'],
    ['아직 안 끝났습니다。내일 이어서', 'approve'],
    ['작업을 완료했습니다。실패는 없습니다。', 'block'],
    ['작업을 끝냈습니다.\r\n남은 실패는 없습니다.', 'block'],
    ['- 항목 A: 완료했음\n- 항목 B: 없음', 'block'],
  ])('%s → %s', (msg, want) => {
    expect(evaluateStop(msg, [r]).action).toBe(want);
  });
  it('긴 메시지도 1초 안에 판정한다', () => {
    const long = `${'커밋 관련 설명 문장입니다 '.repeat(3000)}끝.`;
    const crit = classify(rule('critT001', '매 작업 청크(커밋 단위) 완료 시마다 fresh-context critic 을 돌려라')).proposed.find((s) => s.hook === 'Stop');
    const rr = spike('ct', crit?.trigger_keywords_regex ?? '', crit?.trigger_exclude_regex, crit?.verifier as SpikeRule['verifier']);
    const t0 = Date.now();
    evaluateStop(long, [rr], ['Edit']);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('룰별 발동 조건', () => {
  it('모든 종류의 트리거·제외가 safe-regex 를 통과한다(통과 못 하면 룰이 소리 없이 죽음)', () => {
    const policies = [
      'mock/stub/fake 기반 검증으로 완료 선언 금지',
      '매 작업 청크(커밋 단위) 완료 시마다 fresh-context critic 을 돌려라',
      '기능(①원·투모션·②슛 궤적 분석·③릴리스 타이밍 측정·④슈터 유형·⑤대표 선수 매칭·⑥연습 루틴 추천)을 빼지 말 것',
      '새로 만든 기능을 처음 live로 검증할 때는 실제 프로덕션 상태에 대지 말고 FORGEN_HOME 격리 환경에서',
      '구현 먼저는 절대 하지 않는다. 합의하고 문서로 남긴 다음 구현',
      '오너에게 보내는 답변은 항상 한국어로',
      '완료 선언 전 증거를 확인하라',
    ];
    for (const p of policies) {
      const c = chooseStopTrigger(p);
      expect(compileSafeRegex(c.trigger, 'i').regex, `${c.kind} trigger: ${compileSafeRegex(c.trigger, 'i').reason}`).not.toBeNull();
      expect(compileSafeRegex(c.exclude, 'i').regex, `${c.kind} exclude`).not.toBeNull();
    }
  });
  it('언어 트리거에는 어느 분기에서든 language_ratio 판정만 붙는다 (critic SEV-1)', () => {
    for (const [policy, strength] of [['작업 완료 보고는 항상 한국어로 답하라. 영어로 답하지 말 것', 'strong'], ['오너에게 보내는 답변은 항상 한국어로', 'strong'], ['한국어로 답해라', 'default']] as const) {
      for (const s of classify(rule('lng00001', policy, strength)).proposed.filter((x) => x.hook === 'Stop')) {
        if (s.trigger_keywords_regex === '[\\s\\S]{40,}') expect(s.verifier?.kind).toBe('language_ratio');
        if (chooseStopTrigger(policy).kind === 'critic') expect(s.verifier?.kind).toBe('tool_evidence');
      }
    }
    const p = classify(rule('lng00002', '작업 완료 보고는 항상 한국어로 답하라. 영어로 답하지 말 것', 'strong')).proposed.find((x) => x.hook === 'Stop');
    const r = spike('lng', p?.trigger_keywords_regex ?? '', p?.trigger_exclude_regex, p?.verifier as SpikeRule['verifier']);
    expect(evaluateStop('작업을 마쳤습니다. 테스트와 빌드가 모두 통과했고 배포 준비가 끝났습니다.', [r]).action).toBe('approve');
  });
  it('mock 룰: 단어 언급·탈출 서술은 통과, 검증 주장만 차단', () => {
    const c = chooseStopTrigger('mock/stub/fake 기반 검증으로 완료 선언 금지');
    expect(c.kind).toBe('mock');
    const r = spike('m', c.trigger, c.exclude, selfCheck);
    expect(evaluateStop('mock 상태를 해소하는 라이브 검증까지가 완료 조건입니다.', [r]).action).toBe('approve');
    expect(evaluateStop('표의 mock 검증 금지 룰이 문제입니다.', [r]).action).toBe('approve');
    expect(evaluateStop('| 룰 | 이전 | 이후 |\n|---|---|---|\n| mock 검증 | 26 | 1 |', [r]).action).toBe('approve');
    // 의도적으로 감수한 미탐(ADR-018): 표 칸 안의 주장은 룰 이름 언급과 정규식으로 가를 수 없다.
    expect(evaluateStop('| 항목 | 결과 |\n|---|---|\n| 결제 API | mock 으로 검증 완료 |', [r]).action).toBe('approve');
    // 앵커 회귀: 문장 중간의 파이프는 표 행이 아니다.
    expect(evaluateStop('결과: | mock 으로 검증 완료했습니다.', [r]).action).toBe('block');
    expect(evaluateStop('결제 API 는 mock 으로 검증 완료했습니다.', [r]).action).toBe('block');
  });
  it('구현 먼저 금지 룰: 일반 구현 보고는 통과, "바로 구현했다" 만 차단, 결정 문서 언급 시 통과', () => {
    const c = chooseStopTrigger('구현 먼저는 절대 하지 않는다. 오너와 미리 합의하고 문서로 남긴 다음 구현한다');
    expect(c.kind).toBe('impl');
    const r = spike('i', c.trigger, c.exclude, selfCheck);
    expect(evaluateStop('구현했습니다. 테스트도 통과합니다.', [r]).action).toBe('approve');
    expect(evaluateStop('좋은 제안이라 바로 구현했어요.', [r]).action).toBe('block');
    expect(evaluateStop('결정 문서대로 바로 구현했습니다.', [r]).action).toBe('approve');
  });
  it('주제 룰: 번호 붙은 기능 이름과 빼기 제안이 같은 문장일 때만', () => {
    const policy = '오너가 완성본에 넣기로 정한 기능(①원·투모션·④슈터 유형·⑤대표 선수)을 빼는 선택지만 내밀지 말 것';
    expect(extractTopicTerms(policy)).toEqual(['원·투모션', '슈터 유형', '대표 선수']);
    expect(extractTopicTerms('측정 부채(오차 규약 통일·거리 스케일) 정리')).toEqual([]);
    const c = chooseStopTrigger(policy);
    expect(c.kind).toBe('topic');
    const r = spike('t', c.trigger, c.exclude, selfCheck);
    expect(evaluateStop('A안은 슈터 유형을 v1에서 빼고 출시합니다.', [r]).action).toBe('block');
    expect(evaluateStop('오너 라벨은 우진 투모션, 유튜브 보류입니다.', [r]).action).toBe('approve');
  });
  it('격리 룰: 실 데이터에 대고 돌렸다는 주장에만', () => {
    const c = chooseStopTrigger('새로 만든 기능을 처음 live로 검증할 때는 실제 프로덕션 상태에 직접 대고 돌리지 말고 FORGEN_HOME 격리 환경에서 먼저 검증하라');
    expect(c.kind).toBe('live');
    const r = spike('l', c.trigger, c.exclude, selfCheck);
    expect(evaluateStop('격리 홈에서 검증을 끝냈습니다.', [r]).action).toBe('approve');
    expect(evaluateStop('새 헬퍼를 프로덕션 버킷에 대고 돌렸습니다.', [r]).action).toBe('block');
  });
});

describe('critic 룰은 실행 기록으로 판정', () => {
  const policy = '매 작업 청크(커밋 단위) 완료 시마다 공격적 비판 리뷰(fresh-context critic)를 돌리고 반영하라';
  const proposal = classify(rule('crit0001', policy)).proposed.find((s) => s.hook === 'Stop');
  it('분류기가 tool_evidence 판정을 고른다', () => {
    expect(chooseStopTrigger(policy).kind).toBe('critic');
    expect(proposal?.verifier?.kind).toBe('tool_evidence');
  });
  const r = spike('crit', proposal?.trigger_keywords_regex ?? '', proposal?.trigger_exclude_regex, proposal?.verifier as SpikeRule['verifier']);
  it('커밋 보고 + 최근 Agent 호출 없음 → 차단, 있으면 통과', () => {
    const msg = '수정을 끝냈습니다 (커밋 `a1b2c3d`).';
    expect(evaluateStop(msg, [r], ['Edit', 'Bash']).action).toBe('block');
    expect(evaluateStop(msg, [r], ['Agent', 'Edit', 'Bash']).action).toBe('approve');
    expect(evaluateStop(msg, [r], ['Workflow', 'Bash']).action).toBe('approve');
  });
  it('커밋 증거 없는 상태 보고의 완료 어휘는 발동하지 않는다', () => {
    expect(evaluateStop('대기 알림일 뿐이고 결과물은 이미 정리를 마쳤습니다.', [r], []).action).toBe('approve');
  });
  it('도구 기록 자체가 없으면(기록 안 하는 호스트) 판정 불가로 통과', () => {
    expect(evaluateStop('수정을 끝냈습니다 (커밋 `a1b2c3d`).', [r], []).action).toBe('approve');
  });
  it('해시 증거는 숫자와 a-f 를 모두 포함해야 — feedback·날짜는 아님 (critic SEV-2)', () => {
    expect(evaluateStop('피드백(feedback) 반영 작업을 완료했습니다.', [r], ['Edit']).action).toBe('approve');
    expect(evaluateStop('20261007 기준 정리 완료했습니다.', [r], ['Edit']).action).toBe('approve');
    expect(new RegExp(CHUNK_EVIDENCE_RE, 'i').test('fix 6ce6b61 푸시')).toBe(true);
  });
  it('60개보다 오래된 Agent 호출은 증거로 치지 않는다', () => {
    expect(evaluateStop('배포했습니다.', [r], ['Agent', ...Array(60).fill('Edit')]).action).toBe('block');
  });
});

describe('언어 룰은 한글 비율로', () => {
  const policy = '오너에게 보내는 답변은 항상 한국어로. 영어로 답하지 말 것';
  const p = classify(rule('lang0001', policy, 'strong')).proposed.find((s) => s.hook === 'Stop');
  const r = spike('lang', p?.trigger_keywords_regex ?? '', p?.trigger_exclude_regex, p?.verifier as SpikeRule['verifier']);
  it('language_ratio 판정 — 영어 답변 차단, 코드 섞인 한국어 답변 통과', () => {
    expect(p?.verifier?.kind).toBe('language_ratio');
    expect(evaluateStop('The release is done and all tests pass on the main branch now.', [r]).action).toBe('block');
    expect(evaluateStop('배포를 마쳤습니다. 아래 명령으로 확인하세요.\n```bash\nnpm view @wooojin/forgen version --json && forgen doctor --verbose\n```', [r]).action).toBe('approve');
  });
});

describe('retuneStopSpecs', () => {
  it('바뀐 Stop 설정만 돌려주고 비활성·Stop 없는 룰은 건너뛴다', () => {
    const a = rule('aaaa0001', 'mock/stub/fake 기반 검증으로 완료 선언 금지', 'hard');
    const off = { ...rule('bbbb0001', 'mock 금지'), status: 'suppressed' } as Rule;
    const noStop = { ...rule('cccc0001', 'mock 금지'), enforce_via: [] } as unknown as Rule;
    const out = retuneStopSpecs([a, off, noStop]);
    expect(out.map((c) => c.rule.rule_id)).toEqual(['aaaa0001']);
    // 재적용하면 더 바뀌지 않는다(멱등)
    const again = { ...a, enforce_via: out[0].newStop } as Rule;
    expect(retuneStopSpecs([again])).toEqual([]);
  });
  it('mock exclude 는 테스트 맥락을 계속 제외한다', () => {
    expect(new RegExp(MOCK_EXCLUDE_RE, 'i').test('vi.mock 으로 테스트 통과')).toBe(true);
  });
});
