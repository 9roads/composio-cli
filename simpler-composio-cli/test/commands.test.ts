import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.js';
import { setLocalToolsProviderForTests } from '../src/local-tools.js';
import { baseEnv, createTestIO, jsonResponse, mockFetch } from './test-utils.js';

const emptySearchResponse = {
  results: [],
  toolkit_connection_statuses: [],
  tool_schemas: {},
  next_steps_guidance: [],
  error: null,
};

const toolListResponse = (slug = 'GMAIL_SEND_EMAIL', inputSchema: Record<string, unknown> = {}) => ({
  items: [
    {
      slug,
      toolkit: { slug: 'gmail', name: 'Gmail' },
      input_parameters: inputSchema,
      output_parameters: {},
      available_versions: ['20260521_00'],
      no_auth: false,
    },
  ],
  next_cursor: null,
  total_pages: 1,
  current_page: 1,
  total_items: 1,
});

describe('commands', () => {
  beforeEach(() => {
    vi.stubEnv('CI', 'false');
  });

  afterEach(() => {
    setLocalToolsProviderForTests(null);
    vi.unstubAllEnvs();
  });

  it('search calls the session search endpoint with x-api-key', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    const fetchMock = mockFetch(() => jsonResponse(emptySearchResponse));

    const code = await runCli(
      ['search', 'send an email', '--toolkits', 'gmail,github', '--session-id', 'trs_123'],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://backend.test/api/v3.1/tool_router/session/trs_123/search');
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe('test-key');
    expect(JSON.parse(String(init?.body))).toEqual({
      queries: [{ use_case: 'send an email' }],
      toolkits: ['gmail', 'github'],
    });
  });

  it('search JSON output matches the original CLI-oriented payload shape', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    const schema = {
      type: 'object',
      properties: { recipient_email: { type: 'string' } },
      required: ['recipient_email'],
    };
    const fetchMock = mockFetch(input => {
      const url = String(input);
      if (url.includes('/search')) {
        return jsonResponse({
          results: [
            {
              use_case: 'send an email',
              primary_tool_slugs: ['GMAIL_SEND_EMAIL'],
              related_tool_slugs: [],
              recommended_plan_steps: ['Send the email.'],
              reference_workbench_snippets: [{ hidden: true }],
              plan_id: 'plan_hidden',
            },
          ],
          toolkit_connection_statuses: [
            { toolkit: 'gmail', has_active_connection: true },
          ],
          tool_schemas: {
            GMAIL_SEND_EMAIL: {
              tool_slug: 'GMAIL_SEND_EMAIL',
              toolkit: 'gmail',
              description: 'Send an email',
              input_schema: schema,
            },
          },
          next_steps_guidance: [],
          error: null,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const code = await runCli(
      ['search', 'send an email', '--session-id', 'trs_123'],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const output = JSON.parse(io.stdoutText());
    expect(output).toMatchObject({
      results: [
        {
          use_case: 'send an email',
          primary_tool_slugs: ['GMAIL_SEND_EMAIL'],
          related_tool_slugs: [],
          recommended_plan_steps: ['Send the email.'],
        },
      ],
      tool_schemas: {
        primary: {
          GMAIL_SEND_EMAIL: '~/.composio/tool_definitions/GMAIL_SEND_EMAIL.json',
        },
        related_tools_path_format: '~/.composio/tool_definitions/<TOOL_SLUG>.json',
      },
      connected_toolkits: ['gmail'],
    });
    expect(output.results[0]).not.toHaveProperty('reference_workbench_snippets');
    expect(output.results[0]).not.toHaveProperty('plan_id');
    expect(output.next_steps.steps[0].command).toBe(
      'composio execute GMAIL_SEND_EMAIL --session-id trs_123 -d \'{"recipient_email":""}\''
    );
    const cached = JSON.parse(
      await readFile(path.join(home, '.composio', 'tool_definitions', 'GMAIL_SEND_EMAIL.json'), 'utf8')
    );
    expect(cached.inputSchema).toEqual(schema);
  });

  it('search --human uses the original table shape with session-scoped next steps', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    mockFetch(() =>
      jsonResponse({
        results: [
          {
            use_case: 'send an email',
            primary_tool_slugs: ['GMAIL_SEND_EMAIL'],
            related_tool_slugs: [],
            recommended_plan_steps: [],
          },
        ],
        toolkit_connection_statuses: [{ toolkit: 'gmail', has_active_connection: true }],
        tool_schemas: {
          GMAIL_SEND_EMAIL: {
            tool_slug: 'GMAIL_SEND_EMAIL',
            toolkit: 'gmail',
            description: 'Send an email',
            input_schema: {},
          },
        },
        next_steps_guidance: ['Choose the Gmail send email tool.'],
        error: null,
      })
    );

    const code = await runCli(
      ['search', 'send an email', '--session-id', 'trs_123', '--human'],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    const output = io.stdoutText();
    expect(output).toContain('Found 1 tools');
    expect(output).toContain('Slug');
    expect(output).toContain('Name');
    expect(output).toContain('Description');
    expect(output).toContain('GMAIL_SEND_EMAIL');
    expect(output).toContain('Plan:\n1. Choose the Gmail send email tool.');
    expect(output).toContain('composio execute GMAIL_SEND_EMAIL --session-id trs_123');
  });

  it('execute calls the session execute endpoint with x-api-key', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    const fetchMock = mockFetch(() => jsonResponse({ data: { ok: true }, error: null, log_id: 'log_1' }));

    const code = await runCli(
      [
        'execute',
        'GMAIL_SEND_EMAIL',
        '--session-id',
        'trs_123',
        '--skip-checks',
        '-d',
        '{ recipient_email: "a@b.com" }',
      ],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://backend.test/api/v3.1/tool_router/session/trs_123/execute');
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe('test-key');
    expect(JSON.parse(String(init?.body))).toEqual({
      tool_slug: 'GMAIL_SEND_EMAIL',
      arguments: { recipient_email: 'a@b.com' },
    });
  });

  it('execute continues to the backend when schema preflight cannot find the tool in /tools', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    const fetchMock = mockFetch((input, init) => {
      const url = String(input);
      if (url.includes('/tools')) {
        return jsonResponse({
          items: [{ slug: 'COMPOSIO_SEARCH_TOOLS', toolkit: { slug: 'composio' }, input_parameters: {} }],
          next_cursor: null,
        });
      }
      if (url.endsWith('/execute_meta')) {
        return jsonResponse({ data: { success: false, tool_schemas: {} }, error: null });
      }
      if (url.endsWith('/execute')) {
        return jsonResponse({ data: null, error: 'Input validation failed', log_id: 'log_1' });
      }
      throw new Error(`unexpected fetch: ${url} ${String(init?.body ?? '')}`);
    });

    const code = await runCli(
      [
        'execute',
        'SLACKBOT_ADD_REACTION_TO_AN_ITEM',
        '--session-id',
        'trs_123',
        '--skip-connection-check',
        '-d',
        '{}',
      ],
      io,
      baseEnv(home)
    );

    expect(code).toBe(1);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://backend.test/api/v3.1/tool_router/session/trs_123/tools?limit=500',
      'https://backend.test/api/v3.1/tool_router/session/trs_123/execute_meta',
      'https://backend.test/api/v3.1/tool_router/session/trs_123/execute',
    ]);
    expect(JSON.parse(io.stdoutText())).toEqual({
      successful: false,
      data: null,
      error: 'Input validation failed',
      logId: 'log_1',
    });
  });

  it('execute accepts stdin data and provider-level user_id arguments', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO('{"user_id":"me","max_results":1}');
    const fetchMock = mockFetch(() => jsonResponse({ data: { ok: true }, error: null, log_id: 'log_1' }));

    const code = await runCli(
      ['execute', 'GMAIL_FETCH_EMAILS', '--session-id', 'trs_123', '--skip-checks', '-d', '-'],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      tool_slug: 'GMAIL_FETCH_EMAILS',
      arguments: { user_id: 'me', max_results: 1 },
    });
  });

  it('execute exits non-zero when the backend reports a tool error', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    mockFetch(() => jsonResponse({ data: null, error: 'No active connection', log_id: 'log_1' }));

    const code = await runCli(
      [
        'execute',
        'GMAIL_SEND_EMAIL',
        '--session-id',
        'trs_123',
        '--skip-checks',
        '-d',
        '{ recipient_email: "a@b.com" }',
      ],
      io,
      baseEnv(home)
    );

    expect(code).toBe(1);
    expect(JSON.parse(io.stdoutText())).toEqual({
      successful: false,
      data: null,
      error: 'No active connection',
      logId: 'log_1',
    });
    expect(io.stderrText()).toContain('No active connection');
  });

  it('execute fast-fail connection errors use original structured stdout adapted for sessions', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    mockFetch(input => {
      const url = String(input);
      if (url.includes('/tools')) {
        return jsonResponse(
          toolListResponse('GMAIL_SEND_EMAIL', {
            type: 'object',
            properties: { recipient_email: { type: 'string' } },
            required: ['recipient_email'],
          })
        );
      }
      if (url.includes('/toolkits')) {
        return jsonResponse({
          items: [
            {
              slug: 'gmail',
              is_no_auth: false,
              connected_account: { status: 'INITIATED' },
            },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const code = await runCli(
      [
        'execute',
        'GMAIL_SEND_EMAIL',
        '--session-id',
        'trs_123',
        '-d',
        '{ recipient_email: "a@b.com" }',
      ],
      io,
      baseEnv(home)
    );

    expect(code).toBe(1);
    expect(JSON.parse(io.stdoutText())).toEqual({
      successful: false,
      error:
        'No active connection found for toolkit "gmail" in the provided Tool Router session. Create or refresh the session with that connected account, then retry.',
      slug: 'GMAIL_SEND_EMAIL',
    });
    expect(io.stderrText()).toContain('No active connection found for toolkit "gmail"');
  });

  it('proxy calls the session proxy_execute endpoint with x-api-key', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    const fetchMock = mockFetch(() => jsonResponse({ status: 200, headers: {}, data: { emailAddress: 'me@example.com' } }));

    const code = await runCli(
      [
        'proxy',
        'https://gmail.googleapis.com/gmail/v1/users/me/profile',
        '--toolkit',
        'gmail',
        '--session-id',
        'trs_123',
        '--skip-connection-check',
        '-H',
        'x-test: yes',
      ],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://backend.test/api/v3.1/tool_router/session/trs_123/proxy_execute');
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe('test-key');
    expect(JSON.parse(String(init?.body))).toEqual({
      toolkit_slug: 'gmail',
      endpoint: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      method: 'GET',
      parameters: [{ name: 'x-test', value: 'yes', type: 'header' }],
    });
    expect(JSON.parse(io.stdoutText())).toEqual({ emailAddress: 'me@example.com' });
  });

  it('proxy performs the session toolkit connection check unless skipped', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    const fetchMock = mockFetch(input => {
      const url = String(input);
      if (url.includes('/toolkits')) {
        return jsonResponse({
          items: [
            {
              slug: 'gmail',
              is_no_auth: false,
              connected_account: { status: 'ACTIVE' },
            },
          ],
        });
      }
      return jsonResponse({ status: 200, headers: {}, data: { ok: true } });
    });

    const code = await runCli(
      [
        'proxy',
        'https://gmail.googleapis.com/gmail/v1/users/me/profile',
        '--toolkit',
        'gmail',
        '--session-id',
        'trs_123',
      ],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://backend.test/api/v3.1/tool_router/session/trs_123/toolkits?toolkits=gmail&limit=50',
      'https://backend.test/api/v3.1/tool_router/session/trs_123/proxy_execute',
    ]);
  });

  it('proxy rejects methods outside the original proxy contract', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    const fetchMock = mockFetch(() => jsonResponse({ status: 200, headers: {}, data: { ok: true } }));

    const code = await runCli(
      [
        'proxy',
        'https://gmail.googleapis.com/gmail/v1/users/me/profile',
        '--toolkit',
        'gmail',
        '--session-id',
        'trs_123',
        '--skip-connection-check',
        '-X',
        'HEAD',
      ],
      io,
      baseEnv(home)
    );

    expect(code).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(io.stderrText()).toContain('Unsupported method. Use one of GET, POST, PUT, DELETE, PATCH.');
  });

  it('proxy reads piped stdin as body when -d is omitted, matching the original resolver', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO('{"message":{"raw":"abc"}}');
    const fetchMock = mockFetch(() => jsonResponse({ status: 200, headers: {}, data: { ok: true } }));

    const code = await runCli(
      [
        'proxy',
        'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
        '--toolkit',
        'gmail',
        '--session-id',
        'trs_123',
        '--skip-connection-check',
        '-X',
        'POST',
      ],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      toolkit_slug: 'gmail',
      endpoint: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
      method: 'POST',
      body: { message: { raw: 'abc' } },
    });
  });

  it('proxy emits the original structured JSON error shape on proxy failures', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    mockFetch(() =>
      jsonResponse(
        {
          error: {
            message: 'No active connection',
            slug: 'ToolRouterV2_NoActiveConnection',
          },
        },
        { status: 400, statusText: 'Bad Request' }
      )
    );

    const code = await runCli(
      [
        'proxy',
        'https://gmail.googleapis.com/gmail/v1/users/me/profile',
        '--toolkit',
        'gmail',
        '--session-id',
        'trs_123',
        '--skip-connection-check',
      ],
      io,
      baseEnv(home)
    );

    expect(code).toBe(1);
    expect(JSON.parse(io.stdoutText())).toEqual({
      successful: false,
      error:
        'No active connection found for toolkit "gmail" in the provided Tool Router session. Create or refresh the session with that connected account, then retry.',
      toolkit: 'gmail',
      endpoint: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
      slug: 'ToolRouterV2_NoActiveConnection',
    });
    expect(io.stderrText()).toContain('No active connection found for toolkit "gmail"');
  });

  it('execute --parallel preserves repeated grouped execution behavior', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    const fetchMock = mockFetch(() => jsonResponse({ data: { ok: true }, error: null, log_id: 'log_1' }));

    const code = await runCli(
      [
        'execute',
        '-p',
        '--session-id',
        'trs_123',
        '--skip-checks',
        'GMAIL_SEND_EMAIL',
        '-d',
        '{ recipient_email: "a@b.com" }',
        'GITHUB_CREATE_AN_ISSUE',
        '-d',
        '{ owner: "acme", repo: "app", title: "Bug" }',
      ],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual(
      expect.arrayContaining([
        {
          tool_slug: 'GMAIL_SEND_EMAIL',
          arguments: { recipient_email: 'a@b.com' },
        },
        {
          tool_slug: 'GITHUB_CREATE_AN_ISSUE',
          arguments: { owner: 'acme', repo: 'app', title: 'Bug' },
        },
      ])
    );
  });

  it('execute --parallel parses the original command shape when --parallel appears after the first spec', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    const fetchMock = mockFetch(() => jsonResponse({ data: { ok: true }, error: null, log_id: 'log_1' }));

    const code = await runCli(
      [
        'execute',
        'GMAIL_SEND_EMAIL',
        '-d',
        '{ recipient_email: "a@b.com" }',
        '--parallel',
        '--session-id',
        'trs_123',
        '--skip-checks',
        'GITHUB_CREATE_AN_ISSUE',
        '-d',
        '{ owner: "acme", repo: "app", title: "Bug" }',
      ],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual(
      expect.arrayContaining([
        {
          tool_slug: 'GMAIL_SEND_EMAIL',
          arguments: { recipient_email: 'a@b.com' },
        },
        {
          tool_slug: 'GITHUB_CREATE_AN_ISSUE',
          arguments: { owner: 'acme', repo: 'app', title: 'Bug' },
        },
      ])
    );
  });

  it('execute --parallel applies account selectors with original positional behavior', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    const fetchMock = mockFetch(() => jsonResponse({ data: { ok: true }, error: null, log_id: 'log_1' }));

    const code = await runCli(
      [
        'execute',
        '-p',
        '--account',
        'acct_default',
        '--session-id',
        'trs_123',
        '--skip-checks',
        'GMAIL_SEND_EMAIL',
        '-d',
        '{ recipient_email: "a@b.com" }',
        '--account',
        'acct_issue',
        'GITHUB_CREATE_AN_ISSUE',
        '-d',
        '{ owner: "acme", repo: "app", title: "Bug" }',
      ],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toEqual([
      {
        tool_slug: 'GMAIL_SEND_EMAIL',
        arguments: { recipient_email: 'a@b.com' },
        account: 'acct_default',
      },
      {
        tool_slug: 'GITHUB_CREATE_AN_ISSUE',
        arguments: { owner: 'acme', repo: 'app', title: 'Bug' },
        account: 'acct_issue',
      },
    ]);
  });

  it('execute --parallel preserves partial results when one tool fails', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    const fetchMock = mockFetch((_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.tool_slug === 'GMAIL_SEND_EMAIL') {
        return jsonResponse({ data: null, error: 'Gmail failed', log_id: 'log_1' });
      }
      return jsonResponse({ data: { issue: 1 }, error: null, log_id: 'log_2' });
    });

    const code = await runCli(
      [
        'execute',
        '-p',
        '--session-id',
        'trs_123',
        '--skip-checks',
        'GMAIL_SEND_EMAIL',
        '-d',
        '{ recipient_email: "a@b.com" }',
        'GITHUB_CREATE_AN_ISSUE',
        '-d',
        '{ owner: "acme", repo: "app", title: "Bug" }',
      ],
      io,
      baseEnv(home)
    );

    expect(code).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(io.stdoutText())).toEqual({
      successful: false,
      parallel: true,
      results: [
        {
          slug: 'GMAIL_SEND_EMAIL',
          successful: false,
          error: 'Gmail failed',
          logId: 'log_1',
        },
        {
          slug: 'GITHUB_CREATE_AN_ISSUE',
          successful: true,
          data: { issue: 1 },
          error: null,
          logId: 'log_2',
        },
      ],
    });
    expect(io.stderrText()).toContain('One or more parallel tool executions failed.');
  });

  it('execute --dry-run validates and previews without executing', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    const fetchMock = mockFetch(input => {
      expect(String(input)).toContain('/tools');
      return jsonResponse(
        toolListResponse('GMAIL_SEND_EMAIL', {
          type: 'object',
          properties: { recipient_email: { type: 'string' } },
          required: ['recipient_email'],
        })
      );
    });

    const code = await runCli(
      [
        'execute',
        'GMAIL_SEND_EMAIL',
        '--session-id',
        'trs_123',
        '--skip-connection-check',
        '--dry-run',
        '-d',
        '{ recipient_email: "a@b.com" }',
      ],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.every(([url]) => !String(url).endsWith('/execute'))).toBe(true);
    expect(JSON.parse(io.stdoutText())).toMatchObject({
      successful: true,
      dryRun: true,
      slug: 'GMAIL_SEND_EMAIL',
      sessionId: 'trs_123',
      arguments: { recipient_email: 'a@b.com' },
    });
  });

  it('execute --get-schema prints the CLI-facing schema', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    mockFetch(() =>
      jsonResponse(
        toolListResponse('GMAIL_SEND_EMAIL', {
          type: 'object',
          properties: { attachment: { type: 'string', file_uploadable: true } },
        })
      )
    );

    const code = await runCli(
      ['execute', 'GMAIL_SEND_EMAIL', '--session-id', 'trs_123', '--get-schema'],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    const output = JSON.parse(io.stdoutText());
    expect(output.slug).toBe('GMAIL_SEND_EMAIL');
    expect(output.inputSchema.properties.attachment.format).toBe('path');
  });

  it('execute --get-schema uses COMPOSIO_GET_TOOL_SCHEMAS when /tools only lists meta tools', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    const schema = {
      type: 'object',
      properties: { channel: { type: 'string' }, timestamp: { type: 'string' }, name: { type: 'string' } },
      required: ['channel', 'timestamp', 'name'],
    };
    const fetchMock = mockFetch((input, init) => {
      const url = String(input);
      if (url.includes('/tools')) {
        return jsonResponse({
          items: [{ slug: 'COMPOSIO_SEARCH_TOOLS', toolkit: { slug: 'composio' }, input_parameters: {} }],
          next_cursor: null,
        });
      }
      if (url.endsWith('/execute_meta')) {
        expect(JSON.parse(String(init?.body))).toEqual({
          slug: 'COMPOSIO_GET_TOOL_SCHEMAS',
          arguments: {
            tool_slugs: ['SLACKBOT_ADD_REACTION_TO_AN_ITEM'],
            include: ['input_schema'],
            session_id: 'trs_123',
          },
        });
        return jsonResponse({
          data: {
            success: true,
            tool_schemas: {
              SLACKBOT_ADD_REACTION_TO_AN_ITEM: {
                toolkit: 'SLACKBOT',
                tool_slug: 'SLACKBOT_ADD_REACTION_TO_AN_ITEM',
                description: 'Add a reaction',
                input_schema: schema,
              },
            },
          },
          error: null,
          log_id: 'log_1',
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const code = await runCli(
      ['execute', 'SLACKBOT_ADD_REACTION_TO_AN_ITEM', '--session-id', 'trs_123', '--get-schema'],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'https://backend.test/api/v3.1/tool_router/session/trs_123/tools?limit=500',
      'https://backend.test/api/v3.1/tool_router/session/trs_123/execute_meta',
    ]);
    const output = JSON.parse(io.stdoutText());
    expect(output.inputSchema).toEqual(schema);
    const cached = JSON.parse(
      await readFile(
        path.join(home, '.composio', 'tool_definitions', 'SLACKBOT_ADD_REACTION_TO_AN_ITEM.json'),
        'utf8'
      )
    );
    expect(cached.inputSchema).toEqual(schema);
  });

  it('execute --get-schema uses schemas cached from search when /tools does not list the slug', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const schema = {
      type: 'object',
      properties: { channel: { type: 'string' }, timestamp: { type: 'string' }, name: { type: 'string' } },
      required: ['channel', 'timestamp', 'name'],
    };
    const fetchMock = mockFetch(input => {
      const url = String(input);
      if (url.includes('/search')) {
        return jsonResponse({
          results: [
            {
              use_case: 'add slackbot reaction',
              primary_tool_slugs: ['SLACKBOT_ADD_REACTION_TO_AN_ITEM'],
              related_tool_slugs: [],
              recommended_plan_steps: [],
            },
          ],
          toolkit_connection_statuses: [{ toolkit: 'slackbot', has_active_connection: true }],
          tool_schemas: {
            SLACKBOT_ADD_REACTION_TO_AN_ITEM: {
              tool_slug: 'SLACKBOT_ADD_REACTION_TO_AN_ITEM',
              toolkit: 'slackbot',
              description: 'Add a reaction',
              input_schema: schema,
            },
          },
          next_steps_guidance: [],
          error: null,
        });
      }
      if (url.includes('/tools')) {
        return jsonResponse({
          items: [{ slug: 'COMPOSIO_SEARCH_TOOLS', toolkit: { slug: 'composio' }, input_parameters: {} }],
          next_cursor: null,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const searchCode = await runCli(
      ['search', 'add slackbot reaction', '--session-id', 'trs_123', '--human'],
      createTestIO(),
      baseEnv(home)
    );
    expect(searchCode).toBe(0);

    const io = createTestIO();
    const code = await runCli(
      ['execute', 'SLACKBOT_ADD_REACTION_TO_AN_ITEM', '--session-id', 'trs_123', '--get-schema'],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/tools'))).toHaveLength(0);
    const output = JSON.parse(io.stdoutText());
    expect(output.inputSchema).toEqual(schema);
  });

  it('execute uses schemas cached from human search instead of requiring /tools to contain the slug', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const schema = {
      type: 'object',
      properties: { channel: { type: 'string' }, timestamp: { type: 'string' }, name: { type: 'string' } },
      required: ['channel', 'timestamp', 'name'],
    };
    const fetchMock = mockFetch((input, init) => {
      const url = String(input);
      if (url.includes('/search')) {
        return jsonResponse({
          results: [
            {
              use_case: 'add slackbot reaction',
              primary_tool_slugs: ['SLACKBOT_ADD_REACTION_TO_AN_ITEM'],
              related_tool_slugs: [],
              recommended_plan_steps: [],
            },
          ],
          toolkit_connection_statuses: [{ toolkit: 'slackbot', has_active_connection: true }],
          tool_schemas: {
            SLACKBOT_ADD_REACTION_TO_AN_ITEM: {
              tool_slug: 'SLACKBOT_ADD_REACTION_TO_AN_ITEM',
              toolkit: 'slackbot',
              description: 'Add a reaction',
              input_schema: schema,
            },
          },
          next_steps_guidance: [],
          error: null,
        });
      }
      if (url.endsWith('/execute')) {
        return jsonResponse({ data: { ok: true }, error: null, log_id: 'log_1' });
      }
      throw new Error(`unexpected fetch: ${url} ${String(init?.body ?? '')}`);
    });

    const searchCode = await runCli(
      ['search', 'add slackbot reaction', '--session-id', 'trs_123', '--human'],
      createTestIO(),
      baseEnv(home)
    );
    expect(searchCode).toBe(0);

    const io = createTestIO();
    const code = await runCli(
      [
        'execute',
        'SLACKBOT_ADD_REACTION_TO_AN_ITEM',
        '--session-id',
        'trs_123',
        '--skip-connection-check',
        '-d',
        '{ channel: "C123", timestamp: "1710000000.000000", name: "thumbsup" }',
      ],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/tools'))).toHaveLength(0);
    expect(JSON.parse(io.stdoutText())).toEqual({
      successful: true,
      data: { ok: true },
      error: null,
      logId: 'log_1',
    });
    const executeCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/execute'));
    expect(executeCall).toBeDefined();
    expect(JSON.parse(String(executeCall?.[1]?.body))).toEqual({
      tool_slug: 'SLACKBOT_ADD_REACTION_TO_AN_ITEM',
      arguments: { channel: 'C123', timestamp: '1710000000.000000', name: 'thumbsup' },
    });
  });

  it('execute --parallel --get-schema returns schema entries instead of nested results', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    mockFetch(() =>
      jsonResponse({
        items: [
          {
            slug: 'GMAIL_SEND_EMAIL',
            toolkit: { slug: 'gmail' },
            input_parameters: { type: 'object', properties: { recipient_email: { type: 'string' } } },
            available_versions: ['20260521_00'],
            no_auth: false,
          },
          {
            slug: 'GITHUB_CREATE_AN_ISSUE',
            toolkit: { slug: 'github' },
            input_parameters: { type: 'object', properties: { title: { type: 'string' } } },
            available_versions: ['20260521_01'],
            no_auth: false,
          },
        ],
        next_cursor: null,
      })
    );

    const code = await runCli(
      [
        'execute',
        '-p',
        '--session-id',
        'trs_123',
        '--get-schema',
        'GMAIL_SEND_EMAIL',
        'GITHUB_CREATE_AN_ISSUE',
      ],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    const output = JSON.parse(io.stdoutText());
    expect(output).toMatchObject({
      successful: true,
      parallel: true,
      results: [
        {
          slug: 'GMAIL_SEND_EMAIL',
          successful: true,
          version: '20260521_00',
          inputSchema: { type: 'object', properties: { recipient_email: { type: 'string' } } },
        },
        {
          slug: 'GITHUB_CREATE_AN_ISSUE',
          successful: true,
          version: '20260521_01',
          inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
        },
      ],
    });
    expect(output.results[0]).not.toHaveProperty('result');
  });

  it('execute --file injects a local file path into the single file_uploadable input', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const filePath = path.join(home, 'report.pdf');
    await writeFile(filePath, 'fake pdf');
    const io = createTestIO();
    mockFetch(() =>
      jsonResponse(
        toolListResponse('GMAIL_SEND_EMAIL', {
          type: 'object',
          properties: { attachment: { type: 'string', file_uploadable: true } },
        })
      )
    );

    const code = await runCli(
      [
        'execute',
        'GMAIL_SEND_EMAIL',
        '--session-id',
        'trs_123',
        '--skip-connection-check',
        '--dry-run',
        '--file',
        filePath,
      ],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    const output = JSON.parse(io.stdoutText());
    expect(output.arguments).toEqual({ attachment: filePath });
  });

  it('execute uploads explicit file_uploadable paths from -d when a schema is cached', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const filePath = path.join(home, 'report.pdf');
    await writeFile(filePath, 'fake pdf');
    const fetchMock = mockFetch((input, init) => {
      const url = String(input);
      if (url.includes('/tools')) {
        return jsonResponse(
          toolListResponse('GMAIL_SEND_EMAIL', {
            type: 'object',
            properties: { attachment: { type: 'string', file_uploadable: true } },
          })
        );
      }
      if (url.endsWith('/files/upload/request')) {
        return jsonResponse({
          key: 'uploads/report.pdf',
          new_presigned_url: 'https://upload.test/report.pdf',
        });
      }
      if (url === 'https://upload.test/report.pdf') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/execute')) {
        return jsonResponse({ data: { ok: true }, error: null, log_id: 'log_1' });
      }
      throw new Error(`unexpected fetch: ${url} ${String(init?.body ?? '')}`);
    });

    const schemaCode = await runCli(
      ['execute', 'GMAIL_SEND_EMAIL', '--session-id', 'trs_123', '--get-schema'],
      createTestIO(),
      baseEnv(home)
    );
    expect(schemaCode).toBe(0);

    const io = createTestIO();
    const code = await runCli(
      [
        'execute',
        'GMAIL_SEND_EMAIL',
        '--session-id',
        'trs_123',
        '--skip-connection-check',
        '-d',
        `{ attachment: "${filePath}" }`,
      ],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    const executeCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/execute'));
    expect(executeCall).toBeDefined();
    const [, executeInit] = executeCall!;
    expect(JSON.parse(String(executeInit?.body))).toEqual({
      tool_slug: 'GMAIL_SEND_EMAIL',
      arguments: {
        attachment: {
          name: 'report.pdf',
          mimetype: 'application/pdf',
          s3key: 'uploads/report.pdf',
        },
      },
    });
  });

  it('execute uploads explicit file_uploadable paths from -d on a fresh schema fetch', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const filePath = path.join(home, 'report.pdf');
    await writeFile(filePath, 'fake pdf');
    const io = createTestIO();
    const fetchMock = mockFetch((input, init) => {
      const url = String(input);
      if (url.includes('/tools')) {
        return jsonResponse(
          toolListResponse('GMAIL_SEND_EMAIL', {
            type: 'object',
            properties: { attachment: { type: 'string', file_uploadable: true } },
          })
        );
      }
      if (url.endsWith('/files/upload/request')) {
        return jsonResponse({
          key: 'uploads/report.pdf',
          new_presigned_url: 'https://upload.test/report.pdf',
        });
      }
      if (url === 'https://upload.test/report.pdf') {
        return new Response('', { status: 200 });
      }
      if (url.endsWith('/execute')) {
        return jsonResponse({ data: { ok: true }, error: null, log_id: 'log_1' });
      }
      throw new Error(`unexpected fetch: ${url} ${String(init?.body ?? '')}`);
    });

    const code = await runCli(
      [
        'execute',
        'GMAIL_SEND_EMAIL',
        '--session-id',
        'trs_123',
        '--skip-connection-check',
        '-d',
        `{ attachment: "${filePath}" }`,
      ],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    const executeCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/execute'));
    expect(executeCall).toBeDefined();
    const [, executeInit] = executeCall!;
    expect(JSON.parse(String(executeInit?.body))).toEqual({
      tool_slug: 'GMAIL_SEND_EMAIL',
      arguments: {
        attachment: {
          name: 'report.pdf',
          mimetype: 'application/pdf',
          s3key: 'uploads/report.pdf',
        },
      },
    });
  });

  it('execute routes Composio meta tools through execute_meta', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    const fetchMock = mockFetch(() => jsonResponse({ data: { ok: true }, error: null, log_id: 'log_meta' }));

    const code = await runCli(
      [
        'execute',
        'COMPOSIO_MULTI_EXECUTE_TOOL',
        '--session-id',
        'trs_123',
        '--skip-checks',
        '-d',
        '{ tools: [] }',
      ],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://backend.test/api/v3.1/tool_router/session/trs_123/execute_meta');
    expect(JSON.parse(String(init?.body))).toEqual({
      slug: 'COMPOSIO_MULTI_EXECUTE_TOOL',
      arguments: { tools: [] },
    });
  });

  it('execute can read a bundled local tool schema without an external local-tools package', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    const fetchMock = mockFetch(() => {
      throw new Error('should not fetch');
    });

    const code = await runCli(
      ['execute', 'LOCAL_PEEKABOO_VERSION', '--session-id', 'trs_123', '--get-schema'],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    const output = JSON.parse(io.stdoutText());
    expect(output.slug).toBe('LOCAL_PEEKABOO_VERSION');
    expect(output.inputSchema.type).toBe('object');
  });

  it('execute preserves session connection check and schema validation without user_id', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    const fetchMock = mockFetch(input => {
      const url = String(input);
      if (url.includes('/tools')) {
        return jsonResponse(
          toolListResponse('GMAIL_SEND_EMAIL', {
            type: 'object',
            properties: { recipient_email: { type: 'string' } },
            required: ['recipient_email'],
          })
        );
      }
      if (url.includes('/toolkits')) {
        return jsonResponse({
          items: [
            {
              slug: 'gmail',
              is_no_auth: false,
              connected_account: { status: 'ACTIVE' },
            },
          ],
        });
      }
      return jsonResponse({ data: { ok: true }, error: null, log_id: 'log_1' });
    });

    const code = await runCli(
      [
        'execute',
        'GMAIL_SEND_EMAIL',
        '--session-id',
        'trs_123',
        '-d',
        '{ recipient_email: "a@b.com" }',
      ],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    const bodies = fetchMock.mock.calls
      .map(([, init]) => init?.body)
      .filter(Boolean)
      .map(body => JSON.parse(String(body)));
    expect(JSON.stringify(bodies)).not.toContain('user_id');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/toolkits'))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/execute'))).toBe(true);
  });

  it('execute redacts CI-sensitive ids like the original CLI output writer', async () => {
    vi.stubEnv('CI', 'true');
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    mockFetch(() =>
      jsonResponse({
        data: {
          id: 'obj_123',
          user_id: 'user_123',
          accountId: 'acct_123',
        },
        error: null,
        log_id: 'log_123',
      })
    );

    const code = await runCli(
      [
        'execute',
        'GMAIL_SEND_EMAIL',
        '--session-id',
        'trs_123',
        '--skip-checks',
        '-d',
        '{}',
      ],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    expect(JSON.parse(io.stdoutText())).toEqual({
      successful: true,
      data: {
        id: '<REDACTED>',
        user_id: '<REDACTED>',
        accountId: '<REDACTED>',
      },
      error: null,
      logId: 'log_<REDACTED>',
    });
  });

  it('execute stores very large successful outputs in an artifact file like the original CLI', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-artifacts-'));
    const io = createTestIO();
    const largeText = 'large output '.repeat(20000);
    mockFetch(() =>
      jsonResponse({
        data: { text: largeText },
        error: null,
        log_id: 'log_large',
      })
    );

    const code = await runCli(
      [
        'execute',
        'GMAIL_SEND_EMAIL',
        '--session-id',
        'trs_123',
        '--skip-checks',
        '-d',
        '{}',
      ],
      io,
      {
        ...baseEnv(home),
        COMPOSIO_RUN_OUTPUT_DIR: artifactDir,
      }
    );

    expect(code).toBe(0);
    const output = JSON.parse(io.stdoutText());
    expect(output).toMatchObject({
      successful: true,
      error: null,
      logId: 'log_large',
      storedInFile: true,
    });
    expect(output.tokenCount).toBeGreaterThan(10000);
    expect(output.outputFilePath).toContain(artifactDir);
    expect(JSON.parse(await readFile(output.outputFilePath, 'utf8'))).toEqual({
      successful: true,
      data: { text: largeText },
      error: null,
      logId: 'log_large',
    });
  });

  it('local tool slugs execute locally when a local tools provider is available', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'simpler-cli-'));
    const io = createTestIO();
    const fetchMock = mockFetch(() => {
      throw new Error('should not fetch');
    });
    setLocalToolsProviderForTests({
      isLocalToolSlug: slug => slug === 'LOCAL_TEST_ECHO',
      getLocalToolInputDefinition: slug => ({
        finalSlug: slug,
        toolkit: 'test',
        version: 'local',
        schema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      }),
      executeLocalToolBySlug: async (_slug, args) => ({ echoed: args.text }),
    });

    const code = await runCli(
      [
        'execute',
        'LOCAL_TEST_ECHO',
        '--session-id',
        'trs_123',
        '-d',
        '{ text: "hello" }',
      ],
      io,
      baseEnv(home)
    );

    expect(code).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(io.stdoutText())).toEqual({
      successful: true,
      data: { echoed: 'hello' },
      error: null,
      logId: '',
    });
  });
});
