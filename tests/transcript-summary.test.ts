import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { summarizeTranscript, extractText, extractCodexText, digestTranscriptFile, renderDigest } from '../src/core/transcript-summary.js';

const j = (o: unknown) => JSON.stringify(o);

describe('summarizeTranscript — 실 Claude 스키마 회귀 (2026-08-04 버그)', () => {
  it('실버그: message.content(문자열)를 읽는다 — 이전엔 top-level content 만 읽어 전 턴 누락', () => {
    // 실제 Claude Code transcript 형태: text 가 message.content 에 중첩.
    const raw = [
      j({ type: 'user', message: { role: 'user', content: '이 결제 모듈 대충 최소한으로만 만들어줘' } }),
      j({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '최소 구현했습니다' }] } }),
      j({ type: 'user', message: { role: 'user', content: '앞으로 이런 건 대충 닫지 말고 깊게 구현해줘' } }),
    ].join('\n');
    const out = summarizeTranscript(raw);
    expect(out).toContain('[User] 이 결제 모듈');
    expect(out).toContain('[Assistant] 최소 구현');
    expect(out).toContain('[User] 앞으로 이런 건');
    expect(out.length).toBeGreaterThan(40);
  });

  it('message.content 가 text 블록 배열이어도 추출', () => {
    const raw = j({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '한글 커밋 써줘' }, { type: 'tool_result', content: 'x' }] } });
    expect(summarizeTranscript(raw)).toContain('[User] 한글 커밋 써줘');
  });

  it('top-level content fallback 보존 (queue-operation 등)', () => {
    const raw = j({ type: 'queue-operation', content: '대기 중인 프롬프트' });
    expect(summarizeTranscript(raw)).toContain('[User] 대기 중인 프롬프트');
  });

  it('Codex 스키마도 여전히 동작', () => {
    const raw = j({ type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: '코덱스 유저턴' }] } });
    expect(summarizeTranscript(raw)).toContain('[User] 코덱스 유저턴');
  });

  it('빈/비정형 라인은 skip, 유효 턴 없으면 빈 문자열', () => {
    const raw = ['', 'not json', j({ type: 'summary' })].join('\n');
    expect(summarizeTranscript(raw)).toBe('');
  });

  it('예산은 읽은 길이가 아니라 남긴 길이 기준 — 긴 입력이어도 끝 구간과 중간 교정이 요약에 든다 (옛 조기 종료 버그의 약속 기준 교체)', () => {
    const long = 'a'.repeat(600);
    const rows: string[] = [];
    for (let i = 0; i < 300; i++) rows.push(j({ type: 'user', message: { role: 'user', content: `${i}번째 일반 지시 ${long}` } }));
    rows.splice(150, 0, j({ type: 'user', message: { role: 'user', content: '그게 아니라 중간 교정입니다 이렇게 하지 마' } }));
    rows.push(j({ type: 'user', message: { role: 'user', content: '마지막 지시 끝 구간 표지' } }));
    const out = summarizeTranscript(rows.join('\n'), 8000);
    expect(out.length).toBeLessThanOrEqual(8000 + 200); // 남긴 길이 예산
    expect(out).toContain('중간 교정입니다');
    expect(out).toContain('끝 구간 표지');
  });

  it('주입 텍스트는 요약에 들지 않는다 (스킬 본문, 명령 표식, caveat, system-reminder, 서브에이전트 보고)', () => {
    const rows = [
      j({ type: 'user', isMeta: true, message: { role: 'user', content: 'Base directory for this skill: /x\n# 스킬 본문' } }),
      j({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>' } }),
      j({ type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat: ...</local-command-caveat>' } }),
      j({ type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>done</task-notification>' } }),
      j({ type: 'user', message: { role: 'user', content: 'Another Claude session sent a message:\n<agent-message>보고</agent-message>' } }),
      j({ type: 'user', message: { role: 'user', content: 'Stop hook feedback: [forgen] 차단' } }),
      j({ type: 'user', isSidechain: true, message: { role: 'user', content: '서브에이전트 프롬프트' } }),
      j({ type: 'user', message: { role: 'user', content: '진짜 사용자 발화입니다 <system-reminder>주입된 리마인더</system-reminder>' } }),
      j({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: '도구 결과 텍스트' }] } }),
    ];
    const out = summarizeTranscript(rows.join('\n'));
    expect(out).toContain('진짜 사용자 발화입니다');
    for (const bad of ['스킬 본문', 'clear', 'Caveat', 'task-notification', '보고', 'Stop hook', '서브에이전트 프롬프트', '주입된 리마인더', '도구 결과 텍스트']) {
      expect(out).not.toContain(bad);
    }
  });

  it('Codex 의 AGENTS.md/환경 주입은 제외하고 실제 프롬프트만', () => {
    const rows = [
      j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /x\n규칙...' }] } }),
      j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } }),
      j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '코덱스 실제 질문' }] } }),
      j({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '코덱스 답' }] } }),
    ];
    const out = summarizeTranscript(rows.join('\n'));
    expect(out).toContain('코덱스 실제 질문');
    expect(out).toContain('코덱스 답');
    expect(out).not.toContain('AGENTS.md');
    expect(out).not.toContain('environment_context');
  });

  it('queue-operation 과 user 이중 기록은 한 번만', () => {
    const rows = [
      j({ type: 'queue-operation', operation: 'enqueue', content: '대기열에 들어간 같은 문장' }),
      j({ type: 'user', message: { role: 'user', content: '대기열에 들어간 같은 문장' } }),
    ];
    const out = summarizeTranscript(rows.join('\n'));
    expect(out.match(/대기열에 들어간/g)?.length).toBe(1);
  });

  it('교정 후보는 예산이 빠듯해도 일반 발화보다 먼저 남는다', () => {
    const filler = 'x'.repeat(190);
    const rows: string[] = [];
    for (let i = 0; i < 200; i++) rows.push(j({ type: 'user', message: { role: 'user', content: `일반 ${i} ${filler}` } }));
    rows.splice(100, 0, j({ type: 'user', message: { role: 'user', content: '앞으로는 이 방식 절대 쓰지 말고 다시 해' } }));
    const out = summarizeTranscript(rows.join('\n'), 2500);
    expect(out).toContain('앞으로는 이 방식 절대');
  });

  it('extractText/extractCodexText 유닛', () => {
    expect(extractText('str')).toBe('str');
    expect(extractText([{ type: 'text', text: 'a' }, { type: 'tool_result' }])).toBe('a');
    expect(extractText(null)).toBe('');
    expect(extractCodexText([{ type: 'input_text', text: 'c' }])).toBe('c');
  });
});

describe('digestTranscriptFile — 스트림 + 바이트 커서', () => {
  it('커서 이후의 새 부분만 읽고, 쓰는 중인 마지막 줄(깨진 JSON)은 커서에 넣지 않는다', async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ts-cursor-')), 's.jsonl');
    const l1 = j({ type: 'user', message: { role: 'user', content: '첫 발화 알파' } });
    const l2 = j({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '응답 베타' }] } });
    fs.writeFileSync(f, `${l1}\n${l2}\n`);
    const d1 = await digestTranscriptFile(f, 0);
    expect(renderDigest(d1)).toContain('알파');
    expect(d1.endOffset).toBe(fs.statSync(f).size);

    const l3 = j({ type: 'user', message: { role: 'user', content: '새 발화 감마' } });
    fs.appendFileSync(f, `${l3}\n${l3.slice(0, 20)}`); // 마지막은 쓰다 만 줄
    const d2 = await digestTranscriptFile(f, d1.endOffset);
    const out2 = renderDigest(d2);
    expect(out2).toContain('감마');
    expect(out2).not.toContain('알파');
    expect(d2.endOffset).toBe(d1.endOffset + Buffer.byteLength(l3) + 1); // 깨진 줄 앞까지만

    const d3 = await digestTranscriptFile(f, d2.endOffset + 0);
    expect(d3.items.length).toBe(0);
  });

  it('파일이 커서보다 작아지면(교체) 처음부터', async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ts-cursor-')), 's.jsonl');
    fs.writeFileSync(f, `${j({ type: 'user', message: { role: 'user', content: '교체된 내용' } })}\n`);
    const d = await digestTranscriptFile(f, 10_000_000);
    expect(renderDigest(d)).toContain('교체된 내용');
  });
});
