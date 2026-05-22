import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { encodingForModel } from 'js-tiktoken';
import { Env } from './config.js';

export type ApiErrorDetails = {
  message?: string;
  code?: number;
  slug?: string;
  status?: number;
  request_id?: string;
  suggested_fix?: string;
};

export type OriginalToolTableItem = {
  slug: string;
  name?: string;
  description?: string;
  tags?: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 3)}...`;

export const extractMessage = (value: unknown, seen?: Set<unknown>): string | undefined => {
  if (typeof value === 'string') return value;

  if (isRecord(value)) {
    const visited = seen ?? new Set<unknown>();
    if (visited.has(value)) return undefined;
    visited.add(value);

    if ('cause' in value) {
      const causeMessage = extractMessage(value.cause, visited);
      if (causeMessage) return causeMessage;
    }

    if ('error' in value) {
      const innerMessage = extractMessage(value.error, visited);
      if (innerMessage) return innerMessage;
    }

    if (typeof value.message === 'string') return value.message;
  }

  if (value instanceof Error) return value.message;
  return undefined;
};

export const extractSlug = (value: unknown): string | undefined => {
  let current = value;
  const seen = new Set<unknown>();

  while (isRecord(current) && !seen.has(current)) {
    seen.add(current);

    if (typeof current.slug === 'string') return current.slug;
    if ('error' in current) {
      current = current.error;
      continue;
    }
    if ('cause' in current) {
      current = current.cause;
      continue;
    }
    break;
  }

  return undefined;
};

export const extractApiErrorDetails = (value: unknown): ApiErrorDetails | undefined => {
  const hasApiFields = (candidate: ApiErrorDetails): boolean =>
    'message' in candidate ||
    'code' in candidate ||
    'slug' in candidate ||
    'status' in candidate ||
    'request_id' in candidate;

  const hasStrongApiFields = (candidate: ApiErrorDetails): boolean =>
    typeof candidate.slug === 'string' || typeof candidate.request_id === 'string';

  const seen = new Set<unknown>();
  const queue: unknown[] = [value];
  let head = 0;
  let fallback: ApiErrorDetails | undefined;

  while (head < queue.length) {
    const current = queue[head++];
    if (!isRecord(current) || seen.has(current)) continue;
    seen.add(current);

    const candidate = current as ApiErrorDetails;
    const isWrapper = current instanceof Error;
    if (hasApiFields(candidate) && !isWrapper) {
      if (hasStrongApiFields(candidate)) return candidate;
      fallback ??= candidate;
    }

    if ('error' in current) queue.push(current.error);
    if ('cause' in current) queue.push(current.cause);
  }

  return fallback;
};

const extractNestedDetails = (value: unknown): unknown => {
  let current: unknown = value;
  const seen = new Set<unknown>();

  while (isRecord(current) && !seen.has(current)) {
    seen.add(current);

    if ('details' in current && current.details !== undefined) {
      return current.details;
    }

    if ('error' in current) {
      current = current.error;
      continue;
    }
    if ('cause' in current) {
      current = current.cause;
      continue;
    }
    break;
  }

  return undefined;
};

export const normalizeCliError = (error: unknown): unknown => {
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (isRecord(current) && !seen.has(current)) {
    seen.add(current);

    if (current instanceof Error) return current;

    if ('error' in current) {
      current = current.error;
      continue;
    }
    if ('cause' in current) {
      current = current.cause;
      continue;
    }
    break;
  }

  return current;
};

const NO_CONNECTION_SLUGS: ReadonlySet<string> = new Set([
  'ActionExecute_ConnectedAccountNotFound',
  'ToolRouterV2_NoActiveConnection',
]);

const isNoConnectionSlug = (slug: string | undefined | null): boolean =>
  slug != null && NO_CONNECTION_SLUGS.has(slug);

const isNoActiveConnectionApiError = (
  details: { code?: number; slug?: string } | undefined
): boolean => details?.code === 4302 || isNoConnectionSlug(details?.slug);

const buildSessionNoActiveConnectionMessage = (params: {
  toolkit?: string;
  toolSlug?: string;
}): string => {
  if (params.toolkit) {
    return `No active connection found for toolkit "${params.toolkit}" in the provided Tool Router session. Create or refresh the session with that connected account, then retry.`;
  }
  if (params.toolSlug) {
    const idx = params.toolSlug.indexOf('_');
    const toolkit =
      idx <= 0 ? params.toolSlug.toLowerCase() : params.toolSlug.slice(0, idx).toLowerCase();
    if (toolkit !== 'composio') {
      return `No active connection found for toolkit "${toolkit}" in the provided Tool Router session. Create or refresh the session with that connected account, then retry.`;
    }
  }
  return 'No active connection found for this tool call in the provided Tool Router session. Create or refresh the session with the required connected account, then retry.';
};

export class ComposioNoActiveConnectionError extends Error {
  readonly details: unknown;
  readonly apiDetails?: ApiErrorDetails;
  readonly toolkit?: string;
  readonly toolSlug?: string;

  constructor(params: {
    details: unknown;
    apiDetails?: ApiErrorDetails;
    toolkit?: string;
    toolSlug?: string;
  }) {
    super(
      buildSessionNoActiveConnectionMessage({
        toolkit: params.toolkit,
        toolSlug: params.toolSlug,
      })
    );
    this.name = 'ComposioNoActiveConnectionError';
    this.details = params.details;
    this.apiDetails = params.apiDetails;
    this.toolkit = params.toolkit;
    this.toolSlug = params.toolSlug;
  }
}

export const mapComposioError = (params: {
  error: unknown;
  toolkit?: string;
  toolSlug?: string;
}): {
  normalized: unknown;
  apiDetails?: ApiErrorDetails;
  slugValue?: string;
  message: string;
  override: { kind: 'no_active_connection'; error: ComposioNoActiveConnectionError } | null;
} => {
  const normalized = normalizeCliError(params.error);
  const nestedDetails = extractNestedDetails(params.error) ?? extractNestedDetails(normalized);
  const apiDetails =
    extractApiErrorDetails(params.error) ??
    extractApiErrorDetails(nestedDetails) ??
    extractApiErrorDetails(normalized) ??
    (normalized instanceof ComposioNoActiveConnectionError ? normalized.apiDetails : undefined);
  const slugValue =
    apiDetails?.slug ??
    extractSlug(nestedDetails) ??
    extractSlug(params.error) ??
    extractSlug(normalized) ??
    (normalized instanceof ComposioNoActiveConnectionError
      ? normalized.apiDetails?.slug
      : undefined);

  if (
    normalized instanceof ComposioNoActiveConnectionError ||
    isNoActiveConnectionApiError(apiDetails) ||
    isNoConnectionSlug(slugValue)
  ) {
    const mapped =
      normalized instanceof ComposioNoActiveConnectionError
        ? normalized
        : new ComposioNoActiveConnectionError({
            details: apiDetails ?? params.error,
            apiDetails,
            toolkit: params.toolkit,
            toolSlug: params.toolSlug,
          });

    return {
      normalized: mapped,
      apiDetails,
      slugValue,
      message: mapped.message,
      override: {
        kind: 'no_active_connection',
        error: mapped,
      },
    };
  }

  return {
    normalized,
    apiDetails,
    slugValue,
    message:
      extractMessage(apiDetails) ??
      extractMessage(nestedDetails) ??
      extractMessage(normalized) ??
      'Unknown error',
    override: null,
  };
};

export const redact = <const Prefix extends string = string>({
  value,
  prefix,
}: {
  value: string;
  prefix?: Prefix;
}): `${Prefix}${string}` => {
  if (process.env.CI !== 'true') return value as `${Prefix}${string}`;
  return `${prefix ?? ''}<REDACTED>` as `${Prefix}${string}`;
};

export const ciRedactReplacer = (key: string, value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  if (key === 'logId') return redact({ value, prefix: 'log_' });
  if (key === 'id' || key.endsWith('Id') || key.endsWith('_id')) {
    return redact({ value });
  }
  return value;
};

export const serializeJsonLikeOriginalCli = (value: unknown): string =>
  JSON.stringify(value, ciRedactReplacer, 2);

const EXECUTE_INLINE_OUTPUT_TOKEN_THRESHOLD = 10_000;
let executeOutputEncoder: ReturnType<typeof encodingForModel> | undefined;

const getExecuteOutputEncoder = () => {
  executeOutputEncoder ??= encodingForModel('gpt-4o');
  return executeOutputEncoder;
};

const randomToken = (length = 8): string => randomUUID().replace(/-/g, '').slice(0, length);

const sanitizeArtifactName = (value: string): string =>
  value.replace(/[^A-Z0-9_]+/gi, '_').replace(/^_+|_+$/g, '') || 'ARTIFACT';

const resolveArtifactsRoot = (env: Env): string =>
  env.COMPOSIO_SESSION_DIR?.trim() ||
  env.COMPOSIO_CACHE_DIR?.trim() ||
  path.join(os.tmpdir(), 'composio');

const SESSION_HISTORY_FILE = 'session-history.jsonl';

const resolveSessionArtifactsDirectory = (env: Env, sessionId: string): string =>
  path.join(resolveArtifactsRoot(env), sessionId);

export const appendCliSessionHistory = (params: {
  entry: Record<string, unknown>;
  env: Env;
  sessionId: string;
}): void => {
  const directoryPath = resolveSessionArtifactsDirectory(params.env, params.sessionId);
  try {
    fs.mkdirSync(directoryPath, { recursive: true });
    fs.appendFileSync(
      path.join(directoryPath, SESSION_HISTORY_FILE),
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        sessionId: params.sessionId,
        ...params.entry,
      })}\n`,
      'utf8'
    );
  } catch {
    // Best-effort: history writes must never change CLI behavior.
  }
};

const storeCliSessionArtifact = (params: {
  contents: string;
  name: string;
  extension?: string;
  directoryPath?: string;
  env: Env;
}): string | undefined => {
  const directoryPath =
    params.directoryPath || path.join(resolveArtifactsRoot(params.env), `adhoc_${randomToken(12)}`);

  try {
    fs.mkdirSync(directoryPath, { recursive: true });
    const extension = (params.extension ?? 'json').replace(/^\.+/, '') || 'json';
    const filePath = path.join(
      directoryPath,
      `${sanitizeArtifactName(params.name)}_${randomToken()}.${extension}`
    );
    fs.writeFileSync(filePath, params.contents, 'utf8');
    return filePath;
  } catch {
    return undefined;
  }
};

const shouldStoreLargeExecuteOutput = (env: Env): boolean =>
  env.COMPOSIO_CLI_INVOCATION_ORIGIN !== 'run';

export type StoredExecuteOutputSummary = {
  successful: true;
  error: null;
  logId: string;
  storedInFile: true;
  tokenCount: number;
  outputFilePath: string;
};

export const prepareExecuteOutputLikeOriginalCli = (
  toolSlug: string,
  result: { logId?: string },
  env: Env
):
  | { kind: 'inline'; json: string }
  | { kind: 'file'; summary: StoredExecuteOutputSummary } => {
  const json = serializeJsonLikeOriginalCli(result);
  const tokenCount = getExecuteOutputEncoder().encode(json).length;
  if (tokenCount <= EXECUTE_INLINE_OUTPUT_TOKEN_THRESHOLD || !shouldStoreLargeExecuteOutput(env)) {
    return { kind: 'inline', json };
  }

  const outputFilePath = storeCliSessionArtifact({
    contents: json,
    name: `${toolSlug}_OUTPUT`,
    extension: 'json',
    directoryPath: env.COMPOSIO_RUN_OUTPUT_DIR?.trim(),
    env,
  });

  return {
    kind: 'file',
    summary: {
      successful: true,
      error: null,
      logId: result.logId ?? '',
      storedInFile: true,
      tokenCount,
      outputFilePath: outputFilePath ?? '(could not write to disk)',
    },
  };
};

type SchemaPropertyEntry = {
  name: string;
  type: string;
  defaultValue?: unknown;
};

const schemaVariants = (schema: Record<string, unknown>): Record<string, unknown>[] => [
  ...((Array.isArray(schema.anyOf) ? schema.anyOf : []) as Record<string, unknown>[]),
  ...((Array.isArray(schema.oneOf) ? schema.oneOf : []) as Record<string, unknown>[]),
  ...((Array.isArray(schema.allOf) ? schema.allOf : []) as Record<string, unknown>[]),
];

const inferSchemaType = (schema: Record<string, unknown>): string => {
  if (typeof schema.type === 'string') return schema.type;
  const variants = schemaVariants(schema);
  const firstTyped = variants.find(variant => typeof variant.type === 'string');
  return typeof firstTyped?.type === 'string' ? firstTyped.type : 'unknown';
};

const extractSchemaProperties = (schema: Record<string, unknown>): SchemaPropertyEntry[] => {
  if (!isRecord(schema.properties)) return [];
  return Object.entries(schema.properties).flatMap(([name, property]) => {
    if (!isRecord(property)) return [];
    return [
      {
        name,
        type: inferSchemaType(property),
        ...(Object.prototype.hasOwnProperty.call(property, 'default')
          ? { defaultValue: property.default }
          : {}),
      },
    ];
  });
};

const defaultForSchemaType = (type: string, schemaDefault: unknown): unknown => {
  if (schemaDefault !== undefined) return schemaDefault;
  switch (type) {
    case 'string':
      return '';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return '';
  }
};

export const buildMinimalPayloadFromSchema = (
  schema: Record<string, unknown> | null | undefined
): Record<string, unknown> => {
  if (!schema || !isRecord(schema)) return {};
  const entries = extractSchemaProperties(schema);
  if (entries.length === 0) return {};

  const result: Record<string, unknown> = {};
  for (const entry of entries) {
    result[entry.name] = defaultForSchemaType(entry.type, entry.defaultValue);
  }
  return result;
};

export const formatToolsTable = (tools: ReadonlyArray<OriginalToolTableItem>): string => {
  const header = `${'Slug'.padEnd(35)} ${'Name'.padEnd(20)} Description`;
  const rows = tools.map(tool => {
    const slug = truncate(tool.slug, 35).padEnd(35);
    const name = truncate(tool.name ?? tool.slug, 20).padEnd(20);
    const description = truncate(tool.description ?? '', 50);
    return `${slug} ${name} ${description}`;
  });
  return [header, ...rows].join('\n');
};
