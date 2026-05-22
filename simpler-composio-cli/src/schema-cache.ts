import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jsonSchemaToZod } from '@composio/json-schema-to-zod';
import { z } from 'zod/v3';
import { CliConfig, Env } from './config.js';
import { CliError } from './errors.js';
import { apiRequest } from './http.js';
import { JsonSchema, normalizeFileUploadSchema } from './file-input.js';
import { getLocalToolInputDefinition } from './local-tools.js';

export type ToolInputDefinition = {
  slug: string;
  toolkit?: string;
  version: string | null;
  schemaPath: string;
  schema: JsonSchema;
  noAuth?: boolean;
};

export class ToolInputValidationError extends CliError {
  constructor(
    readonly toolSlug: string,
    readonly schemaPath: string,
    readonly issues: ReadonlyArray<string>
  ) {
    super(
      [
        `Input validation failed for ${toolSlug}.`,
        `Schema: ${schemaPath}`,
        ...issues.map(issue => `- ${issue}`),
      ].join('\n')
    );
    this.name = 'ToolInputValidationError';
  }
}

const TOOL_DEFINITIONS_DIR = 'tool_definitions';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sanitizeToolSlug = (slug: string): string => slug.replace(/[^A-Za-z0-9_.-]/g, '_');

export const resolveCacheDir = (env: Env): string => {
  if (env.COMPOSIO_CACHE_DIR?.trim()) return env.COMPOSIO_CACHE_DIR.trim();
  if (env.HOME?.trim()) return path.join(env.HOME.trim(), '.composio');
  return path.join(os.homedir(), '.composio');
};

const toolDefinitionPath = (env: Env, slug: string): string =>
  path.join(resolveCacheDir(env), TOOL_DEFINITIONS_DIR, `${sanitizeToolSlug(slug)}.json`);

const parseCachedToolDefinition = (
  parsed: Record<string, unknown>
): { version: string | null; inputSchema: JsonSchema; toolkit?: string; noAuth?: boolean } => {
  if (isRecord(parsed.inputSchema)) {
    return {
      version: typeof parsed.version === 'string' ? parsed.version : null,
      inputSchema: parsed.inputSchema,
      toolkit: typeof parsed.toolkit === 'string' ? parsed.toolkit : undefined,
      noAuth: typeof parsed.noAuth === 'boolean' ? parsed.noAuth : undefined,
    };
  }

  return { version: null, inputSchema: parsed };
};

const writeDefinition = async (
  env: Env,
  slug: string,
  definition: Omit<ToolInputDefinition, 'schemaPath'>
): Promise<ToolInputDefinition> => {
  const schemaPath = toolDefinitionPath(env, slug);
  await fs.mkdir(path.dirname(schemaPath), { recursive: true });
  await fs.writeFile(
    schemaPath,
    JSON.stringify(
      {
        version: definition.version,
        toolkit: definition.toolkit,
        noAuth: definition.noAuth,
        inputSchema: definition.schema,
      },
      null,
      2
    )
  );
  return { ...definition, schemaPath };
};

export const cacheToolInputDefinition = async (
  env: Env,
  definition: {
    slug: string;
    toolkit?: string;
    version?: string | null;
    schema: Record<string, unknown>;
    noAuth?: boolean;
  }
): Promise<ToolInputDefinition> =>
  writeDefinition(env, definition.slug, {
    slug: definition.slug,
    toolkit: definition.toolkit,
    version: definition.version ?? null,
    schema: normalizeObjectSchema(definition.schema),
    noAuth: definition.noAuth,
  });

export const getCachedToolInputDefinition = async (
  env: Env,
  slug: string
): Promise<ToolInputDefinition | null> => {
  const schemaPath = toolDefinitionPath(env, slug);
  try {
    const raw = await fs.readFile(schemaPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const cached = parseCachedToolDefinition(parsed);
    return {
      slug,
      schemaPath,
      schema: cached.inputSchema,
      version: cached.version,
      toolkit: cached.toolkit,
      noAuth: cached.noAuth,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

type SessionToolsResponse = {
  items?: Array<{
    slug?: string;
    tool_slug?: string;
    toolkit?: { slug?: string } | string;
    input_parameters?: Record<string, unknown>;
    input_schema?: Record<string, unknown>;
    available_versions?: string[];
    version?: string;
    no_auth?: boolean;
  }>;
  next_cursor?: string | null;
};

const extractToolDefinition = (
  env: Env,
  slug: string,
  item: NonNullable<SessionToolsResponse['items']>[number]
): ToolInputDefinition => {
  const inputSchema = item.input_schema ?? item.input_parameters ?? {};
  const toolkit =
    typeof item.toolkit === 'string'
      ? item.toolkit
      : typeof item.toolkit?.slug === 'string'
        ? item.toolkit.slug
        : undefined;

  return {
    slug,
    schemaPath: toolDefinitionPath(env, slug),
    schema: normalizeObjectSchema(inputSchema),
    version: item.version ?? item.available_versions?.find(Boolean) ?? null,
    toolkit,
    noAuth: item.no_auth,
  };
};

const normalizeObjectSchema = (schema: Record<string, unknown>): JsonSchema => {
  if (schema.type === 'object' || isRecord(schema.properties)) return schema;

  const looksLikeProperties = Object.values(schema).every(
    value => isRecord(value) && ('type' in value || 'description' in value || 'required' in value)
  );
  if (!looksLikeProperties) return schema;

  return {
    type: 'object',
    properties: schema,
    required: Object.entries(schema)
      .filter(([, value]) => isRecord(value) && value.required === true)
      .map(([key]) => key),
  };
};

const fetchToolInputDefinition = async (
  config: CliConfig,
  env: Env,
  sessionId: string,
  slug: string
): Promise<ToolInputDefinition> => {
  const local = await getLocalToolInputDefinition(slug);
  if (local) {
    return writeDefinition(env, local.finalSlug, {
      slug: local.finalSlug,
      toolkit: local.toolkit,
      schema: normalizeObjectSchema(local.schema),
      version: local.version,
      noAuth: true,
    });
  }

  let cursor: string | undefined;
  do {
    const response = await apiRequest<SessionToolsResponse>(config, {
      method: 'GET',
      path: `/api/v3.1/tool_router/session/${encodeURIComponent(sessionId)}/tools`,
      query: { limit: 500, cursor },
    });
    const match = response.items?.find(item => (item.slug ?? item.tool_slug) === slug);
    if (match) {
      const definition = extractToolDefinition(env, slug, match);
      return writeDefinition(env, slug, definition);
    }
    cursor = response.next_cursor ?? undefined;
  } while (cursor);

  throw new CliError(`Tool "${slug}" was not found in session ${sessionId}.`);
};

export const getOrFetchToolInputDefinition = async (
  config: CliConfig,
  env: Env,
  sessionId: string,
  slug: string,
  options: { refresh?: boolean } = {}
): Promise<ToolInputDefinition> => {
  if (!options.refresh) {
    const cached = await getCachedToolInputDefinition(env, slug);
    if (cached) return cached;
  }
  return fetchToolInputDefinition(config, env, sessionId, slug);
};

const getObjectSchemaProperties = (schema: Record<string, unknown>): ReadonlyArray<string> => {
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return [];
  }

  return Object.keys(properties as Record<string, unknown>);
};

const normalizeKey = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

const levenshteinDistance = (left: string, right: string): number => {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = new Array<number>(right.length + 1);

  for (let i = 0; i < left.length; i += 1) {
    current[0] = i + 1;
    for (let j = 0; j < right.length; j += 1) {
      const cost = left[i] === right[j] ? 0 : 1;
      current[j + 1] = Math.min(current[j]! + 1, previous[j + 1]! + 1, previous[j]! + cost);
    }
    for (let j = 0; j <= right.length; j += 1) {
      previous[j] = current[j]!;
    }
  }

  return previous[right.length]!;
};

const findClosestSchemaKey = (
  unknownKey: string,
  allowedKeys: ReadonlyArray<string>
): string | undefined => {
  const normalizedUnknownKey = normalizeKey(unknownKey);
  const candidates = allowedKeys
    .map(key => ({
      key,
      normalized: normalizeKey(key),
    }))
    .map(candidate => {
      const distance = levenshteinDistance(normalizedUnknownKey, candidate.normalized);
      const containsBonus =
        candidate.normalized.includes(normalizedUnknownKey) ||
        normalizedUnknownKey.includes(candidate.normalized)
          ? -2
          : 0;
      return {
        key: candidate.key,
        score: distance + containsBonus,
      };
    })
    .sort((left, right) => left.score - right.score);

  const best = candidates[0];
  if (!best) {
    return undefined;
  }

  const threshold = Math.max(3, Math.ceil(normalizedUnknownKey.length * 0.6));
  return best.score <= threshold ? best.key : undefined;
};

const formatUnknownKeyIssue = (
  unknownKeys: ReadonlyArray<string>,
  allowedKeys: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const allowedList = allowedKeys.join(', ');
  return unknownKeys.map(key => {
    const suggestion = findClosestSchemaKey(key, allowedKeys);
    const lines = [`<root>: Unknown key "${key}".`];
    if (suggestion) {
      lines.push(`Use "${suggestion}" instead.`);
    }
    if (allowedList) {
      lines.push(`Allowed top-level keys: ${allowedList}`);
    }
    return lines.join(' ');
  });
};

export const validateToolInputArguments = (
  slug: string,
  args: Record<string, unknown>,
  definition: ToolInputDefinition
): void => {
  const normalizedSchema = normalizeFileUploadSchema(definition.schema);
  const allowedKeys = getObjectSchemaProperties(definition.schema);
  let zodSchema: z.ZodTypeAny;

  try {
    zodSchema = jsonSchemaToZod(normalizedSchema) as z.ZodTypeAny;
  } catch (error) {
    throw new ToolInputValidationError(
      slug,
      definition.schemaPath,
      ['Could not compile the cached JSON schema into a Zod validator.']
    );
  }

  const parsed = zodSchema.safeParse(args);
  if (parsed.success) return;

  const issues = parsed.error.issues.flatMap(issue => {
    if (issue.code === 'unrecognized_keys') {
      return formatUnknownKeyIssue(issue.keys, allowedKeys);
    }
    const location = issue.path.length > 0 ? issue.path.join('.') : '<root>';
    return [`${location}: ${issue.message}`];
  });

  throw new ToolInputValidationError(slug, definition.schemaPath, issues);
};

export const formatSchemaOutput = (slug: string, definition: ToolInputDefinition): string =>
  JSON.stringify(
    {
      slug,
      version: definition.version,
      schemaPath: definition.schemaPath,
      inputSchema: normalizeFileUploadSchema(definition.schema),
    },
    null,
    2
  );
