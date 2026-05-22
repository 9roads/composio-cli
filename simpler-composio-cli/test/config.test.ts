import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.js';
import { createTestIO, mockFetch } from './test-utils.js';

describe('config and required session handling', () => {
  it('fails before network calls when COMPOSIO_API_KEY is missing', async () => {
    const io = createTestIO();
    const fetchMock = mockFetch(() => {
      throw new Error('should not fetch');
    });

    const code = await runCli(['search', 'send email', '--session-id', 'trs_123'], io, {
      COMPOSIO_BASE_URL: 'https://backend.test',
    });

    expect(code).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(io.stderrText()).toContain('COMPOSIO_API_KEY');
  });

  it.each([
    ['search', ['send email']],
    ['execute', ['GMAIL_SEND_EMAIL', '--skip-checks']],
    ['proxy', ['https://gmail.googleapis.com/gmail/v1/users/me/profile', '--toolkit', 'gmail']],
  ])('fails before network calls when %s is missing --session-id', async (command, argv) => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    const fetchMock = mockFetch(() => {
      throw new Error('should not fetch');
    });

    const code = await runCli([command, ...(argv as string[])], io, {
      COMPOSIO_API_KEY: 'test-key',
      COMPOSIO_BASE_URL: 'https://backend.test',
      HOME: home,
    });

    expect(code).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(io.stderrText()).toContain('--session-id');
  });

  it('does not read COMPOSIO_SESSION_ID as a fallback', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    const fetchMock = mockFetch(() => {
      throw new Error('should not fetch');
    });

    const code = await runCli(['search', 'send email'], io, {
      COMPOSIO_API_KEY: 'test-key',
      COMPOSIO_BASE_URL: 'https://backend.test',
      COMPOSIO_SESSION_ID: 'trs_from_env',
      HOME: home,
    });

    expect(code).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(io.stderrText()).toContain('--session-id');
  });

  it('rejects --user-id', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    const fetchMock = mockFetch(() => {
      throw new Error('should not fetch');
    });

    const code = await runCli(
      ['search', 'send email', '--session-id', 'trs_123', '--user-id', 'user_123'],
      io,
      {
        COMPOSIO_API_KEY: 'test-key',
        COMPOSIO_BASE_URL: 'https://backend.test',
        HOME: home,
      }
    );

    expect(code).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(io.stderrText()).toContain('--user-id');
  });
});
