import { clampLimit, parseIntegerOption, rejectUnsupportedUserIdOption, requireSessionId, takeOptionValue } from '../args.js';
import { CliConfig, Env, readConfig } from '../config.js';
import { CliError } from '../errors.js';
import { apiRequest } from '../http.js';
import { CliIO, writeLine } from '../io.js';
import { cacheToolInputDefinition, resolveCacheDir, ToolInputDefinition } from '../schema-cache.js';
import {
  appendCliSessionHistory,
  buildMinimalPayloadFromSchema,
} from '../original-compat.js';

type SearchOptions = {
  queries: string[];
  sessionId?: string;
  toolkits?: string;
  limit: number;
};

type SearchToolSchema = {
  tool_slug?: string;
  toolkit?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  version?: string;
  no_auth?: boolean;
};

type SearchResultRecord = {
  use_case: string;
  primary_tool_slugs: string[];
  related_tool_slugs: string[];
  recommended_plan_steps?: string[];
  reference_workbench_snippets?: unknown;
  plan_id?: string;
};

type SearchResponseRecord = {
  results: SearchResultRecord[];
  toolkit_connection_statuses?: Array<{
    toolkit: string;
    has_active_connection: boolean;
    status_message?: string;
  }>;
  tool_schemas: Record<string, SearchToolSchema>;
  next_steps_guidance?: string[];
  error?: string | null;
};

type SearchJsonPayload = {
  results: Array<Omit<SearchResultRecord, 'reference_workbench_snippets' | 'plan_id'>>;
  tool_schemas: {
    primary: Record<string, string>;
    related_tools_path_format: string;
  };
  connected_toolkits: string[];
  error?: string;
  next_steps: {
    guidance: string;
    steps: Array<{ action: string; command: string }>;
  };
};

const TOOL_SCHEMA_PATH_FORMAT = '~/.composio/tool_definitions/<TOOL_SLUG>.json';

const parseToolkitList = (toolkits: string | undefined): string[] | undefined => {
  const parsed = toolkits
    ?.split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  return parsed && parsed.length > 0 ? parsed : undefined;
};

const toHomeRelativePath = (cacheDir: string, absolutePath: string): string =>
  absolutePath.startsWith(cacheDir) ? absolutePath.replace(cacheDir, '~/.composio') : absolutePath;

const buildSearchNextSteps = (params: {
  firstSlug?: string;
  firstDataArg: string;
  sessionId: string;
}): Array<{ action: string; command: string }> => {
  if (!params.firstSlug) return [];
  return [
    {
      action: 'Execute a tool',
      command: `composio execute ${params.firstSlug} --session-id ${params.sessionId} ${params.firstDataArg}`,
    },
  ];
};

export const parseSearchArgs = (args: string[]): SearchOptions => {
  const options: SearchOptions = {
    queries: [],
    limit: 10,
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

    if (token === '--toolkits' || token.startsWith('--toolkits=')) {
      const [value, next] = takeOptionValue(args, i, '--toolkits');
      options.toolkits = value;
      i = next;
      continue;
    }

    if (token === '--limit' || token.startsWith('--limit=')) {
      const [value, next] = takeOptionValue(args, i, '--limit');
      options.limit = clampLimit(parseIntegerOption(value, '--limit'));
      i = next;
      continue;
    }

    if (token.startsWith('-')) {
      throw new CliError(`Unknown option for search: ${token}`);
    }

    options.queries.push(token);
  }

  return options;
};

const collectLimitedSlugs = (
  result: SearchResultRecord,
  toolSchemas: Record<string, SearchToolSchema>,
  toolkitSet: Set<string> | undefined,
  limit: number
): { primary: string[]; related: string[]; all: string[] } => {
  const seen = new Set<string>();
  const all: string[] = [];
  const primary: string[] = [];
  const related: string[] = [];

  const maybeAdd = (slug: string, target: string[]): void => {
    if (seen.has(slug) || all.length >= limit) return;
    const schema = toolSchemas[slug];
    if (!schema) return;
    const toolkit = schema.toolkit?.toLowerCase();
    if (toolkitSet && (!toolkit || !toolkitSet.has(toolkit))) return;
    seen.add(slug);
    all.push(slug);
    target.push(slug);
  };

  result.primary_tool_slugs.forEach(slug => maybeAdd(slug, primary));
  result.related_tool_slugs.forEach(slug => maybeAdd(slug, related));
  return { primary, related, all };
};

const limitSearchResponse = (
  response: SearchResponseRecord,
  toolkitList: string[] | undefined,
  limit: number
): SearchResponseRecord => {
  const toolkitSet = toolkitList ? new Set(toolkitList) : undefined;
  const selectedSlugs = new Set<string>();

  const results = response.results.map(result => {
    const selected = collectLimitedSlugs(result, response.tool_schemas, toolkitSet, limit);
    selected.all.forEach(slug => selectedSlugs.add(slug));
    const { reference_workbench_snippets: _snippets, plan_id: _planId, ...rest } = result;
    return {
      ...rest,
      primary_tool_slugs: selected.primary,
      related_tool_slugs: selected.related,
    };
  });

  const tool_schemas = Object.fromEntries(
    Object.entries(response.tool_schemas).filter(([slug]) => selectedSlugs.has(slug))
  );

  return {
    ...response,
    results,
    tool_schemas,
    toolkit_connection_statuses: toolkitSet
      ? response.toolkit_connection_statuses?.filter(status =>
          toolkitSet.has(status.toolkit.toLowerCase())
        )
      : response.toolkit_connection_statuses,
  };
};

const stripSearchResultMetadata = (
  result: SearchResultRecord
): Omit<SearchResultRecord, 'reference_workbench_snippets' | 'plan_id'> => {
  const {
    reference_workbench_snippets: _referenceWorkbenchSnippets,
    plan_id: _planId,
    ...rest
  } = result;
  return rest;
};

const firstSearchToolSlug = (response: SearchResponseRecord): string | undefined => {
  for (const result of response.results) {
    const slug = [...result.primary_tool_slugs, ...result.related_tool_slugs].find(
      candidate => response.tool_schemas[candidate]
    );
    if (slug) return slug;
  }
  return undefined;
};

const responseHasTools = (response: SearchResponseRecord): boolean =>
  response.results.some(result => result.primary_tool_slugs.length > 0 || result.related_tool_slugs.length > 0);

const cacheSearchToolSchemas = async (
  env: Env,
  toolSchemas: Record<string, SearchToolSchema>
): Promise<Record<string, ToolInputDefinition>> =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(toolSchemas).map(async ([key, schema]) => {
        const definition = await cacheToolInputDefinition(env, {
          slug: key,
          toolkit: schema.toolkit,
          version: schema.version ?? null,
          schema: schema.input_schema ?? {},
          noAuth: schema.no_auth,
        });
        return [key, definition] as const;
      })
    )
  );

const buildSearchJsonPayload = async (params: {
  env: Env;
  response: SearchResponseRecord;
  cachedDefinitions: Record<string, ToolInputDefinition>;
  sessionId: string;
}): Promise<SearchJsonPayload> => {
  const cacheDir = resolveCacheDir(params.env);
  const primaryToolSlugs = Array.from(
    new Set(params.response.results.flatMap(result => result.primary_tool_slugs))
  );
  const primaryToolSchemaPaths = Object.fromEntries(
    primaryToolSlugs.map(slug => {
      const definition = params.cachedDefinitions[slug];
      const schemaPath = definition
        ? toHomeRelativePath(cacheDir, definition.schemaPath)
        : TOOL_SCHEMA_PATH_FORMAT.replace('<TOOL_SLUG>', slug);
      return [slug, schemaPath] as const;
    })
  );
  const connectedToolkits = Array.from(
    new Set(
      (params.response.toolkit_connection_statuses ?? [])
        .filter(status => status.has_active_connection)
        .map(status => status.toolkit.toLowerCase())
    )
  );

  const firstSlug = firstSearchToolSlug(params.response);
  const firstPayload = buildMinimalPayloadFromSchema(
    firstSlug ? params.response.tool_schemas[firstSlug]?.input_schema : undefined
  );
  const firstDataArg =
    Object.keys(firstPayload).length === 0 ? '-d "{}"' : `-d '${JSON.stringify(firstPayload)}'`;

  return {
    results: params.response.results.map(stripSearchResultMetadata),
    tool_schemas: {
      primary: primaryToolSchemaPaths,
      related_tools_path_format: TOOL_SCHEMA_PATH_FORMAT,
    },
    connected_toolkits: connectedToolkits,
    ...(params.response.error ? { error: params.response.error } : {}),
    next_steps: {
      guidance:
        'You can directly proceed with these steps without waiting for the user to ask. The provided session must already have the relevant connected account, then execute tools with --session-id.',
      steps: buildSearchNextSteps({
        firstSlug,
        firstDataArg,
        sessionId: params.sessionId,
      }),
    },
  };
};

const performSearch = async (
  config: CliConfig,
  sessionId: string,
  options: SearchOptions
): Promise<SearchResponseRecord> => {
  const queries = options.queries.map(query => query.trim()).filter(Boolean);
  if (queries.length === 0) {
    throw new CliError('At least one query is required.');
  }

  const toolkitList = parseToolkitList(options.toolkits);
  const response = await apiRequest<SearchResponseRecord>(config, {
    method: 'POST',
    path: `/api/v3.1/tool_router/session/${encodeURIComponent(sessionId)}/search`,
    body: {
      queries: queries.map(query => ({ use_case: query })),
      ...(toolkitList ? { toolkits: toolkitList } : {}),
    },
  });

  return limitSearchResponse(response, toolkitList, options.limit);
};

export const runSearch = async (args: string[], io: CliIO, env: Env): Promise<void> => {
  const options = parseSearchArgs(args);
  const sessionId = requireSessionId(options.sessionId);
  const config = readConfig(env);
  const response = await performSearch(config, sessionId, options);
  const cachedDefinitions = await cacheSearchToolSchemas(env, response.tool_schemas);
  const resultCount = response.results.reduce(
    (sum, result) => sum + result.primary_tool_slugs.length + result.related_tool_slugs.length,
    0
  );

  appendCliSessionHistory({
    env,
    sessionId,
    entry: {
      command: 'search',
      query: options.queries.join(' | '),
      queries: options.queries,
      toolkitFilter: parseToolkitList(options.toolkits) ?? [],
      limit: options.limit,
      resultCount,
      nextSteps: response.next_steps_guidance ?? [],
    },
  });

  if (!responseHasTools(response)) {
    writeLine(io.stdout, '[]');
    return;
  }

  const output = await buildSearchJsonPayload({ env, response, cachedDefinitions, sessionId });
  writeLine(io.stdout, JSON.stringify(output, null, 2));
};
