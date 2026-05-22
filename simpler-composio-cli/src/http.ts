import { CliConfig } from './config.js';
import { HttpError } from './errors.js';

export type QueryValue = string | number | boolean | undefined | null;

export type ApiRequestOptions = {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  headers?: Record<string, string>;
};

const appendQuery = (url: URL, query?: Record<string, QueryValue>): void => {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
};

const parseResponseBody = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return null;

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

export const apiRequest = async <T>(
  config: CliConfig,
  options: ApiRequestOptions
): Promise<T> => {
  const url = new URL(options.path, `${config.baseUrl}/`);
  appendQuery(url, options.query);

  const response = await fetch(url, {
    method: options.method,
    redirect: 'error',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': '@composio/simpler-cli',
      'x-api-key': config.apiKey,
      ...options.headers,
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  const body = await parseResponseBody(response);
  if (!response.ok) {
    throw new HttpError(response.status, response.statusText, body);
  }

  return body as T;
};
