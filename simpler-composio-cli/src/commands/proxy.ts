import { rejectUnsupportedUserIdOption, requireSessionId, takeOptionValue } from '../args.js';
import { Env, readConfig } from '../config.js';
import { CliError, HttpError } from '../errors.js';
import { apiRequest } from '../http.js';
import { CliIO, writeLine } from '../io.js';
import { runConnectedToolkitFailFastForToolkit } from '../connection-checks.js';
import { parseJsonIsh, resolveTextInput } from '../json-input.js';
import { mapComposioError } from '../original-compat.js';

type ProxyOptions = {
  endpoint?: string;
  sessionId?: string;
  toolkit?: string;
  method: string;
  headers: string[];
  data?: string;
  skipConnectionCheck: boolean;
};

type ProxyResponse = {
  status?: number | null;
  data?: unknown;
  headers?: Record<string, unknown> | null;
  binary_data?: unknown;
};

const SUPPORTED_PROXY_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);

export const normalizeProxyMethod = (value: string): string => {
  const normalized = value.trim().toUpperCase();
  if (!SUPPORTED_PROXY_METHODS.has(normalized)) {
    throw new CliError('Unsupported method. Use one of GET, POST, PUT, DELETE, PATCH.');
  }
  return normalized;
};

export const parseProxyHeader = (value: string): { name: string; value: string } => {
  const index = value.indexOf(':');
  if (index <= 0) {
    throw new CliError(`Invalid header "${value}". Use "Name: value".`);
  }

  const name = value.slice(0, index).trim();
  const headerValue = value.slice(index + 1).trim();
  if (!name) {
    throw new CliError(`Invalid header "${value}". Missing header name.`);
  }

  return { name, value: headerValue };
};

export const parseProxyBody = (raw: string): unknown => {
  try {
    return parseJsonIsh(raw);
  } catch {
    return raw;
  }
};

const formatProxyOutput = (result: ProxyResponse): string => {
  if (result.binary_data) {
    return JSON.stringify(
      {
        status: result.status ?? null,
        headers: result.headers ?? {},
        binary_data: result.binary_data,
      },
      null,
      2
    );
  }

  if (typeof result.data === 'string') return result.data;
  if (result.data === undefined || result.data === null) return '';
  return JSON.stringify(result.data, null, 2);
};

const formatProxyErrorOutput = (params: {
  error: string;
  toolkit: string;
  endpoint: string;
  slug?: string;
}): string =>
  JSON.stringify(
    {
      successful: false,
      error: params.error,
      toolkit: params.toolkit,
      endpoint: params.endpoint,
      slug: params.slug ?? null,
    },
    null,
    2
  );

const writeProxyErrorAndThrow = (params: {
  error: unknown;
  io: CliIO;
  toolkit: string;
  endpoint: string;
}): never => {
  const error = params.error instanceof HttpError ? params.error.body : params.error;
  const mapped = mapComposioError({ error, toolkit: params.toolkit });
  writeLine(
    params.io.stdout,
    formatProxyErrorOutput({
      error: mapped.message,
      toolkit: params.toolkit,
      endpoint: params.endpoint,
      slug: mapped.slugValue,
    })
  );
  throw new CliError(mapped.message);
};

export const parseProxyArgs = (args: string[]): ProxyOptions => {
  const options: ProxyOptions = {
    method: 'GET',
    headers: [],
    skipConnectionCheck: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? '';
    rejectUnsupportedUserIdOption(token);

    if (token === '--session-id' || token.startsWith('--session-id=')) {
      const [value, next] = takeOptionValue(args, i, '--session-id');
      options.sessionId = value;
      i = next;
      continue;
    }

    if (token === '--toolkit' || token === '-t' || token.startsWith('--toolkit=')) {
      const [value, next] = takeOptionValue(args, i, '--toolkit');
      options.toolkit = value;
      i = next;
      continue;
    }

    if (token === '--method' || token === '-X' || token.startsWith('--method=')) {
      const [value, next] = takeOptionValue(args, i, '--method');
      options.method = value;
      i = next;
      continue;
    }

    if (token === '--header' || token === '-H' || token.startsWith('--header=')) {
      const [value, next] = takeOptionValue(args, i, '--header');
      options.headers.push(value);
      i = next;
      continue;
    }

    if (token === '--data' || token === '-d' || token.startsWith('--data=')) {
      const [value, next] = takeOptionValue(args, i, '--data');
      options.data = value;
      i = next;
      continue;
    }

    if (token === '--skip-connection-check') {
      options.skipConnectionCheck = true;
      continue;
    }

    if (token.startsWith('-')) {
      throw new CliError(`Unknown option for proxy: ${token}`);
    }

    if (options.endpoint) {
      throw new CliError(`Unexpected argument for proxy: ${token}`);
    }
    options.endpoint = token;
  }

  return options;
};

export const runProxy = async (args: string[], io: CliIO, env: Env): Promise<void> => {
  const options = parseProxyArgs(args);
  const sessionId = requireSessionId(options.sessionId);
  const config = readConfig(env);

  if (!options.endpoint) throw new CliError('Missing <url> for proxy.');
  const endpoint = options.endpoint;
  const toolkit = options.toolkit?.trim().toLowerCase();
  if (!toolkit) throw new CliError('Missing --toolkit <text>.');

  try {
    await runConnectedToolkitFailFastForToolkit({
      config,
      sessionId,
      toolkit,
      skip: options.skipConnectionCheck,
    });
  } catch (error) {
    return writeProxyErrorAndThrow({ error, io, toolkit, endpoint });
  }

  const rawBody = await resolveTextInput(options.data, io, { readPipedStdin: true });
  const body = rawBody === undefined ? undefined : parseProxyBody(rawBody);
  const parameters = options.headers.map(header => {
    const parsed = parseProxyHeader(header);
    return {
      name: parsed.name,
      value: parsed.value,
      type: 'header' as const,
    };
  });

  const response = await apiRequest<ProxyResponse>(config, {
    method: 'POST',
    path: `/api/v3.1/tool_router/session/${encodeURIComponent(sessionId)}/proxy_execute`,
    body: {
      toolkit_slug: toolkit,
      endpoint,
      method: normalizeProxyMethod(options.method),
      ...(body !== undefined ? { body } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
    },
  }).catch(error =>
    writeProxyErrorAndThrow({ error, io, toolkit, endpoint })
  );

  const output = formatProxyOutput(response);
  if (output) writeLine(io.stdout, output);
};
