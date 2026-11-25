/**
 * 0.8.0 K2: 추출 프롬프트에 보여 줄 기존 솔루션 이름. 같은 교훈을 같은 이름으로 다시 쓰게 해 재관측을 잡는다.
 * 폴더 정렬 뒤쪽 30개가 아니라 요약과 태그가 많이 겹치는 순(겹침이 같으면 최근 것). 은퇴·깨진 파일은 뺀다.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractSolutionTags, parseFrontmatterOnly } from './solution-format.js';

export function nearestSolutionNames(solDir: string, summary: string, n: number): string[] {
  const want = new Set(extractSolutionTags(summary));
  const scored: Array<{ name: string; score: number; mtime: number }> = [];
  let files: string[] = [];
  try { files = fs.readdirSync(solDir).filter((x) => x.endsWith('.md')); } catch { return []; }
  for (const f of files) {
    const p = path.join(solDir, f);
    let score = 0; let mtime = 0;
    try {
      const fm = parseFrontmatterOnly(fs.readFileSync(p, 'utf-8'));
      if (!fm || fm.status === 'retired') continue;
      for (const t of fm.tags ?? []) if (want.has(t)) score++;
      mtime = fs.statSync(p).mtimeMs;
    } catch { continue; }
    scored.push({ name: f.replace(/\.md$/, ''), score, mtime });
  }
  return scored.sort((a, b) => b.score - a.score || b.mtime - a.mtime).slice(0, n).map((s) => s.name);
}

