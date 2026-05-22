export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly body: unknown
  ) {
    super(formatHttpErrorMessage(status, statusText, body));
    this.name = 'HttpError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const extractMessage = (body: unknown): string | undefined => {
  if (!isRecord(body)) return undefined;
  const direct = body.message ?? body.error;
  if (typeof direct === 'string') return direct;

  if (isRecord(body.error)) {
    const nested = body.error.message;
    if (typeof nested === 'string') return nested;

    if (isRecord(body.error.error)) {
      const deep = body.error.error.message;
      if (typeof deep === 'string') return deep;
    }
  }

  return undefined;
};

const formatHttpErrorMessage = (status: number, statusText: string, body: unknown): string => {
  const message = extractMessage(body);
  if (message) return `HTTP ${status}: ${message}`;
  return `HTTP ${status}${statusText ? ` ${statusText}` : ''}`;
};

