import { CliError } from './errors.js';

export const takeOptionValue = (args: string[], index: number, option: string): [string, number] => {
  const token = args[index];
  const eq = token?.indexOf('=') ?? -1;
  if (token && eq > -1) {
    return [token.slice(eq + 1), index];
  }

  const value = args[index + 1];
  if (value === undefined) {
    throw new CliError(`Missing value for ${option}`);
  }
  return [value, index + 1];
};

export const parseIntegerOption = (value: string, option: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new CliError(`${option} must be an integer.`);
  }
  return parsed;
};

export const clampLimit = (value: number): number => {
  if (value < 1) return 1;
  if (value > 1000) return 1000;
  return value;
};

export const requireSessionId = (sessionId: string | undefined): string => {
  const trimmed = sessionId?.trim();
  if (!trimmed) {
    throw new CliError('Missing --session-id <session_id>. Every command requires an existing Tool Router session id.');
  }
  return trimmed;
};

export const rejectUnsupportedUserIdOption = (token: string): void => {
  if (token === '--user-id' || token.startsWith('--user-id=')) {
    throw new CliError('Unsupported option --user-id. This CLI only accepts --session-id.');
  }
};
