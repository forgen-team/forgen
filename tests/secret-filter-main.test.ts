import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockReadStdinJSON } = vi.hoisted(() => ({
  mockReadStdinJSON: vi.fn(),
}));

vi.mock('../src/hooks/shared/read-stdin.js', () => ({
  readStdinJSON: mockReadStdinJSON,
}));

let logOutput: string[];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logOutput = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logOutput.push(args.map(a => String(a)).join(' '));
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('secret-filter main()', () => {
  it('stdin이 null이면 approve', async () => {
    mockReadStdinJSON.mockResolvedValue(null);
    const { main } = await import('../src/hooks/secret-filter.js');
    await main();
    await vi.waitFor(() => {
      expect(logOutput.some(l => l.includes('"continue":true'))).toBe(true);
    });
  });

  it('Write 도구가 아니면 approve', async () => {
    mockReadStdinJSON.mockResolvedValue({
      tool_name: 'Read',
      tool_response: 'AKIAIOSFODNN7EXAMPLE',
    });
    const { main } = await import('../src/hooks/secret-filter.js');
    await main();
    await vi.waitFor(() => {
      const lastOutput = logOutput[logOutput.length - 1];
      expect(lastOutput).toContain('"continue":true');
      expect(lastOutput).not.toContain('security-warning');
    });
  });

  it('Write 도구에 시크릿이 있으면 경고', async () => {
    mockReadStdinJSON.mockResolvedValue({
      tool_name: 'Write',
      tool_input: { content: 'const key = "sk_live_1234567890abcdefghij";' },
      tool_response: '',
    });
    const { main } = await import('../src/hooks/secret-filter.js');
    await main();
    await vi.waitFor(() => {
      expect(logOutput.some(l => l.includes('compound-security-warning'))).toBe(true);
    });
  });

  it('Bash 도구의 출력에 시크릿이 있으면 경고', async () => {
    mockReadStdinJSON.mockResolvedValue({
      tool_name: 'Bash',
      tool_input: { command: 'cat credentials' },
      tool_response: 'password="mysecretpass123"',
    });
    const { main } = await import('../src/hooks/secret-filter.js');
    await main();
    await vi.waitFor(() => {
      expect(logOutput.some(l => l.includes('compound-security-warning'))).toBe(true);
    });
  });

  it('Edit 도구에 시크릿이 없으면 approve', async () => {
    mockReadStdinJSON.mockResolvedValue({
      tool_name: 'Edit',
      tool_input: { new_string: 'const greeting = "hello";' },
      tool_response: '',
    });
    const { main } = await import('../src/hooks/secret-filter.js');
    await main();
    await vi.waitFor(() => {
      const lastOutput = logOutput[logOutput.length - 1];
      expect(lastOutput).toContain('"continue":true');
      expect(lastOutput).not.toContain('security-warning');
    });
  });

  it('toolOutput 필드도 검사한다', async () => {
    mockReadStdinJSON.mockResolvedValue({
      toolName: 'Write',
      toolInput: {},
      toolOutput: 'AKIAIOSFODNN7EXAMPLE',
    });
    const { main } = await import('../src/hooks/secret-filter.js');
    await main();
    await vi.waitFor(() => {
      expect(logOutput.some(l => l.includes('compound-security-warning'))).toBe(true);
    });
  });
});
