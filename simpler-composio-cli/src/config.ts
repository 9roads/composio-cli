import { CliError } from './errors.js';

export const DEFAULT_BASE_URL = 'https://backend.composio.dev';

export type CliConfig = {
  apiKey: string;
  baseUrl: string;
};

export type Env = Record<string, string | undefined>;

export const readConfig = (env: Env): CliConfig => {
  const apiKey = env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) {
    throw new CliError('Missing COMPOSIO_API_KEY. Set it before running this CLI.');
  }

  return {
    apiKey,
    baseUrl: (env.COMPOSIO_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
  };
};

