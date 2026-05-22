import { Readable } from 'node:stream';
import { vi } from 'vitest';
import { CliIO } from '../src/io.js';

export const createTestIO = (
  stdinText?: string
): CliIO & { stdoutText: () => string; stderrText: () => string } => {
  let stdout = '';
  let stderr = '';
  const stdin = Readable.from(stdinText === undefined ? [] : [stdinText]);
  (stdin as Readable & { isTTY?: boolean }).isTTY = stdinText === undefined;

  return {
    stdin,
    stdout: {
      write(chunk: string) {
        stdout += chunk;
        return true;
      },
    },
    stderr: {
      write(chunk: string) {
        stderr += chunk;
        return true;
      },
    },
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
};

export const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

export const mockFetch = (handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>) => {
  const fetchMock = vi.fn(handler);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

export const baseEnv = (home: string) => ({
  COMPOSIO_API_KEY: 'test-key',
  COMPOSIO_BASE_URL: 'https://backend.test',
  HOME: home,
});
