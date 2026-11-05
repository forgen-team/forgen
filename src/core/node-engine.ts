/** package.json engines.node 와 같게 유지(테스트가 대조). 미달이어도 실행은 막지 않고 경고만 한다. */
export const MIN_NODE_MAJOR = 22;

export function nodeEngineWarning(version: string = process.versions.node): string | null {
  const major = Number(version.split('.')[0]);
  if (!Number.isFinite(major) || major >= MIN_NODE_MAJOR) return null;
  return `[forgen] WARNING: Node ${version} is below the supported range (>=${MIN_NODE_MAJOR}). Some features may fail; switch with: nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}`;
}
