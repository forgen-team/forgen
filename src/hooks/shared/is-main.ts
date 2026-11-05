import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 이 모듈이 node 의 진입점으로 실행됐는가.
 *
 * `import.meta.url === \`file://${argv[1]}\`` 는 쓰지 않는다. URL 은 공백·한글을 인코딩하고
 * argv[1] 은 심링크를 풀지 않아서, 설치 경로에 이런 문자가 있거나 심링크를 거치면 항상 false 가 되고
 * hook 이 출력 없이 끝난다(룰 강제가 조용히 사라짐).
 */
export function isMainModule(metaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  try {
    return fs.realpathSync(path.resolve(argv1)) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
