/**
 * forgen way draft: 실제 CLI 프로세스로 확인한다 (대역 없음).
 * Haiku 가 불가한 환경(PATH 에 claude 없음)에서 결정론 묶음을 내고, 비밀 마스킹·<private> 제외·근거 id 옆 파일·덮어쓰기 거부를 본다.
 * 실제 Haiku 초안은 수동 실측 (보고서 참고) — 테스트는 네트워크·과금에 의존하지 않는다.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const DIST = path.resolve(__dirname, '..', 'dist');
let root: string, home: string, forgen: string, proj: string;
const run = (...a: string[]) => spawnSync(process.execPath, [path.join(DIST, 'cli.js'), 'way', 'draft', ...a], {
  encoding: 'utf-8', cwd: proj, timeout: 60_000,
  env: { ...process.env, HOME: home, FORGEN_HOME: forgen, FORGEN_SYNTHETIC: '1', PATH: path.dirname(process.execPath) }, // claude 없음
});
function rule(id: string, trigger: string, policy: string, extra: object = {}) {
  fs.writeFileSync(path.join(forgen, 'me', 'rules', `${id}.json`), JSON.stringify({
    rule_id: id, category: 'workflow', scope: 'me', trigger, policy, strength: 'default', source: 'explicit_correction', status: 'active',
    evidence_refs: [], render_key: id, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z', ...extra,
  }));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-draft-'));
  home = path.join(root, 'home'); forgen = path.join(home, '.forgen'); proj = path.join(root, 'proj');
  fs.mkdirSync(path.join(forgen, 'me', 'rules'), { recursive: true }); fs.mkdirSync(path.join(forgen, 'me', 'solutions'), { recursive: true }); fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(forgen, 'forge-profile.json'), '{}');
  rule('r-release-1', '배포 전 점검', '배포 전에는 롤백 절차와 헬스체크 결과를 확인한다. 키 sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA 는 쓰지 않는다.');
  rule('r-release-2', '배포 점검 누락', '배포 후 헬스체크를 5분 간격으로 세 번 본다. <private>고객사 내부 URL</private> 은 적지 않는다.');
  rule('r-other', '무관한 규칙', '커밋 메시지는 짧게 쓴다.');
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('forgen way draft', () => {
  it('관련 항목만 모으고, 비밀·private 을 지우고, Haiku 불가 사유를 보여 주며 결정론 묶음을 낸다', () => {
    const r = run('skill', '배포 점검');
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('룰 2');
    expect(r.stderr).toMatch(/초안을 쓰지 못했다/);
    expect(r.stdout).toContain('롤백 절차');
    expect(r.stdout).not.toContain('커밋 메시지');
    expect(r.stdout).not.toContain('sk-ant-api03');
    expect(r.stdout).toContain('[REDACTED');
    expect(r.stdout).not.toContain('고객사 내부 URL');
    expect(r.stdout).toContain('rule:r-release-1');
  });

  it('--out: 결정론 묶음은 SKILL.md 가 아닌 DRAFT-BUNDLE.md 로 쓰고, 근거 id 를 옆 파일에 남기며, 외부 파일은 덮어쓰지 않는다', () => {
    const out = path.join(root, 'out');
    const r = run('skill', '배포 점검', '--out', out);
    expect(r.status).toBe(0);
    const dir = fs.readdirSync(path.join(out, '.claude', 'skills'))[0];
    const files = fs.readdirSync(path.join(out, '.claude', 'skills', dir)).sort();
    expect(files).toEqual(['DRAFT-BUNDLE.md', 'SOURCES.md']);
    const side = fs.readFileSync(path.join(out, '.claude', 'skills', dir, 'SOURCES.md'), 'utf-8');
    expect(side).toContain('rule:r-release-1');
    expect(side).toContain('rule:r-release-2');
    fs.writeFileSync(path.join(out, '.claude', 'skills', dir, 'SOURCES.md'), '내가 쓴 파일');
    const again = run('skill', '배포 점검', '--out', out);
    expect(again.status).toBe(1);
    expect(fs.readFileSync(path.join(out, '.claude', 'skills', dir, 'SOURCES.md'), 'utf-8')).toBe('내가 쓴 파일');
  });

  it('워크플로우 종류와 관련 항목 없음 처리', () => {
    const w = run('workflow', '배포 점검', '--out', path.join(root, 'o2'));
    expect(w.status).toBe(0);
    expect(fs.existsSync(path.join(root, 'o2', 'workflows'))).toBe(true);
    const none = run('skill', '쿠버네티스 오토스케일링', '--out', path.join(root, 'o3'));
    expect(none.status).toBe(1);
    expect(fs.existsSync(path.join(root, 'o3'))).toBe(false);
  });
});
