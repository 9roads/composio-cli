import fs from 'node:fs';
import { rejectUnsupportedUserIdOption, requireSessionId, takeOptionValue } from '../args.js';
import { Env, readConfig } from '../config.js';
import { CliError } from '../errors.js';
import { apiRequest } from '../http.js';
import { CliIO, writeLine } from '../io.js';
import { injectSingleFileArgument, uploadToolInputFiles } from '../file-input.js';
import { parseArgumentsObject, resolveTextInput } from '../json-input.js';
import { executeLocalTool, isLocalToolSlug } from '../local-tools.js';
import {
  formatSchemaOutput,
  getCachedToolInputDefinition,
  getOrFetchToolInputDefinition,
  ToolInputDefinition,
  validateToolInputArguments,
} from '../schema-cache.js';
import { runConnectedToolkitFailFast } from '../connection-checks.js';
import { toolkitFromToolSlug } from '../toolkit.js';
import {
  appendCliSessionHistory,
  mapComposioError,
  prepareExecuteOutputLikeOriginalCli,
  serializeJsonLikeOriginalCli,
} from '../original-compat.js';

type ExecuteOptions = {
  slug?: string;
  data?: string;
  file?: string;
  account?: string;
  sessionId?: string;
  parallel: boolean;
  getSchema: boolean;
  dryRun: boolean;
  skipConnectionCheck: boolean;
  skipToolParamsCheck: boolean;
  skipChecks: boolean;
  specs: ParallelExecuteSpec[];
};

type ParallelExecuteSpec = {
  slug: string;
  data?: string;
  account?: string;
};

type ParallelExecuteResult = {
  slug: string;
  successful: boolean;
  [key: string]: unknown;
  error?: string | null;
};

type ParallelExecuteSummary = {
  successful: boolean;
  parallel: true;
  results: ParallelExecuteResult[];
};

const META_TOOL_SLUGS = new Set([
  'COMPOSIO_SEARCH_TOOLS',
  'COMPOSIO_MULTI_EXECUTE_TOOL',
  'COMPOSIO_MANAGE_CONNECTIONS',
  'COMPOSIO_WAIT_FOR_CONNECTIONS',
  'COMPOSIO_REMOTE_WORKBENCH',
  'COMPOSIO_REMOTE_BASH_TOOL',
  'COMPOSIO_GET_TOOL_SCHEMAS',
  'COMPOSIO_UPSERT_RECIPE',
  'COMPOSIO_GET_RECIPE',
]);

const emptyExecuteOptions = (): ExecuteOptions => ({
  parallel: false,
  getSchema: false,
  dryRun: false,
  skipConnectionCheck: false,
  skipToolParamsCheck: false,
  skipChecks: false,
  specs: [],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isMetaToolSlug = (slug: string): boolean => META_TOOL_SLUGS.has(slug);

const looksLikeUploadSource = (value: string): boolean => {
  if (/^https?:\/\//i.test(value)) return true;
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) return true;
  if (value.includes('\\')) return true;
  return fs.existsSync(value);
};

const argumentsContainUploadSource = (value: unknown): boolean => {
  if (typeof value === 'string') return looksLikeUploadSource(value);
  if (Array.isArray(value)) return value.some(argumentsContainUploadSource);
  if (!isRecord(value)) return false;
  return Object.values(value).some(argumentsContainUploadSource);
};

const stringifyExecutionError = (value: unknown): string => {
  if (typeof value === 'string' && value.trim()) return value;
  if (value instanceof Error) return value.message;
  if (value === null || value === undefined || value === '') return 'Execution failed.';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const getExecutionError = (result: unknown): string | null => {
  if (!isRecord(result)) return null;

  if ('error' in result && result.error !== null && result.error !== undefined && result.error !== false && result.error !== '') {
    return stringifyExecutionError(result.error);
  }

  if (result.successful === false) {
    return 'error' in result ? stringifyExecutionError(result.error) : 'Execution failed.';
  }

  return null;
};

const formatExecuteExceptionOutput = (params: {
  error: unknown;
  slug: string;
}): { json: string; message: string; summary: Record<string, unknown> } => {
  const mapped = mapComposioError({ error: params.error, toolSlug: params.slug });
  const summary = {
    successful: false,
    error: mapped.message,
    slug: mapped.override ? params.slug : (mapped.slugValue ?? params.slug),
  };
  return {
    json: serializeJsonLikeOriginalCli(summary),
    message: mapped.message,
    summary,
  };
};

const normalizeExecuteResponse = (result: unknown): unknown => {
  if (!isRecord(result)) return result;
  if (result.dryRun === true || ('inputSchema' in result && 'schemaPath' in result)) return result;
  if ('successful' in result && 'logId' in result) return result;

  const hasExecuteShape =
    'data' in result || 'error' in result || 'log_id' in result || 'logId' in result;
  if (!hasExecuteShape) return result;

  const error = 'error' in result ? result.error : null;
  const logId =
    typeof result.logId === 'string'
      ? result.logId
      : typeof result.log_id === 'string'
        ? result.log_id
        : '';

  return {
    successful: error === null || error === undefined,
    data: 'data' in result ? result.data : null,
    error: error ?? null,
    logId,
    ...(result.permissionApproval ? { permissionApproval: result.permissionApproval } : {}),
  };
};

const isSchemaOutput = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && 'inputSchema' in value && 'schemaPath' in value;

const isDryRunOutput = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && value.dryRun === true;

const toParallelResult = (slug: string, result: unknown, env: Env): ParallelExecuteResult => {
  const normalized = normalizeExecuteResponse(result);
  const error = getExecutionError(normalized);
  if (error) {
    const logId = isRecord(normalized) && typeof normalized.logId === 'string' ? normalized.logId : undefined;
    return {
      slug,
      successful: false,
      error,
      ...(logId ? { logId } : {}),
    };
  }

  if (isSchemaOutput(normalized)) {
    return {
      slug,
      successful: true,
      version: normalized.version,
      schemaPath: normalized.schemaPath,
      inputSchema: normalized.inputSchema,
    };
  }

  if (isDryRunOutput(normalized)) {
    return {
      ...normalized,
      slug,
      successful: true,
    };
  }

  if (isRecord(normalized)) {
    const output = prepareExecuteOutputLikeOriginalCli(slug, normalized, env);
    if (output.kind === 'file') {
      return {
        slug,
        ...output.summary,
      };
    }

    return {
      slug,
      ...normalized,
      successful: true,
    };
  }

  return {
    slug,
    successful: true,
    data: normalized,
    error: null,
    logId: '',
  };
};

const formatSingleExecuteOutput = (slug: string, result: unknown, env: Env): string => {
  const normalized = normalizeExecuteResponse(result);
  if (getExecutionError(normalized)) {
    return serializeJsonLikeOriginalCli(normalized);
  }

  if (isSchemaOutput(normalized) || isDryRunOutput(normalized) || !isRecord(normalized)) {
    return serializeJsonLikeOriginalCli(normalized);
  }

  const output = prepareExecuteOutputLikeOriginalCli(slug, normalized, env);
  return output.kind === 'file'
    ? serializeJsonLikeOriginalCli(output.summary)
    : output.json;
};

export const parseExecuteArgs = (args: string[]): ExecuteOptions => {
  const options = emptyExecuteOptions();
  options.parallel = args.includes('--parallel') || args.includes('-p');
  let currentParallelSpec: ParallelExecuteSpec | null = null;

  const pushCurrentParallelSpec = (): void => {
    if (currentParallelSpec) {
      options.specs.push(currentParallelSpec);
      currentParallelSpec = null;
    }
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

    if (token === '--parallel' || token === '-p') {
      options.parallel = true;
      continue;
    }

    if (token === '--data' || token === '-d' || token.startsWith('--data=') || token.startsWith('-d=')) {
      const [value, next] = takeOptionValue(args, i, '--data');
      if (options.parallel) {
        if (!currentParallelSpec) {
          throw new CliError('-d/--data must follow a TOOL_SLUG when using --parallel.');
        }
        currentParallelSpec.data = value;
      } else {
        options.data = value;
      }
      i = next;
      continue;
    }

    if (token === '--file' || token.startsWith('--file=')) {
      const [value, next] = takeOptionValue(args, i, '--file');
      options.file = value;
      i = next;
      continue;
    }

    if (token === '--account' || token.startsWith('--account=')) {
      const [value, next] = takeOptionValue(args, i, '--account');
      options.account = value;
      i = next;
      continue;
    }

    if (token === '--get-schema') {
      options.getSchema = true;
      continue;
    }

    if (token === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (token === '--skip-connection-check') {
      options.skipConnectionCheck = true;
      continue;
    }

    if (token === '--skip-tool-params-check') {
      options.skipToolParamsCheck = true;
      continue;
    }

    if (token === '--skip-checks') {
      options.skipChecks = true;
      continue;
    }

    if (token.startsWith('-')) {
      throw new CliError(`Unknown option for execute: ${token}`);
    }

    if (options.parallel) {
      pushCurrentParallelSpec();
      currentParallelSpec = {
        slug: token,
        ...(options.account ? { account: options.account } : {}),
      };
      continue;
    }

    if (options.slug) {
      throw new CliError(`Unexpected argument for execute: ${token}`);
    }
    options.slug = token;
  }

  pushCurrentParallelSpec();
  return options;
};

const resolveArgs = async (data: string | undefined, io: CliIO): Promise<Record<string, unknown>> => {
  const raw = (await resolveTextInput(data, io, { missingValue: '{}', readPipedStdin: true })) ?? '{}';
  return parseArgumentsObject(raw);
};

const getDefinitionIfNeeded = async (params: {
  config: ReturnType<typeof readConfig>;
  env: Env;
  allowFetchFailure?: boolean;
  sessionId: string;
  slug: string;
  mode: 'refresh' | 'fetch-if-missing' | 'cached' | 'none';
}): Promise<ToolInputDefinition | null> => {
  if (params.mode === 'none') return null;
  if (params.mode === 'cached') return getCachedToolInputDefinition(params.env, params.slug);
  try {
    return await getOrFetchToolInputDefinition(params.config, params.env, params.sessionId, params.slug, {
      refresh: params.mode === 'refresh',
    });
  } catch (error) {
    if (params.allowFetchFailure) return null;
    throw error;
  }
};

const executeSingle = async (params: {
  args: Record<string, unknown>;
  account?: string;
  config: ReturnType<typeof readConfig>;
  env: Env;
  file?: string;
  getSchema: boolean;
  dryRun: boolean;
  sessionId: string;
  skipConnectionCheck: boolean;
  skipToolParamsCheck: boolean;
  skipChecks: boolean;
  slug: string;
}): Promise<unknown> => {
  const local = await isLocalToolSlug(params.slug);
  const meta = isMetaToolSlug(params.slug);
  const shouldValidate = !params.skipToolParamsCheck && !params.skipChecks;
  const mustFetchDefinition = params.getSchema || Boolean(params.file) || (params.dryRun && shouldValidate);
  const shouldValidateWithSchema = shouldValidate && !local && !meta;
  const shouldTryFetchDefinition =
    !params.dryRun && !local && !meta && argumentsContainUploadSource(params.args);
  const schemaMode: 'refresh' | 'fetch-if-missing' | 'cached' | 'none' =
    mustFetchDefinition || shouldTryFetchDefinition
      ? 'refresh'
      : shouldValidateWithSchema
        ? 'refresh'
        : !params.dryRun && !local && !meta
          ? 'cached'
          : 'none';

  const definition = await getDefinitionIfNeeded({
    config: params.config,
    env: params.env,
    allowFetchFailure: shouldTryFetchDefinition && !mustFetchDefinition,
    sessionId: params.sessionId,
    slug: params.slug,
    mode: schemaMode,
  });

  if (params.getSchema) {
    if (!definition) throw new CliError(`No schema available for ${params.slug}.`);
    return JSON.parse(formatSchemaOutput(params.slug, definition)) as unknown;
  }

  let toolArgs = params.args;
  if (params.file) {
    if (!definition) throw new CliError(`No schema available for ${params.slug}.`);
    toolArgs = injectSingleFileArgument({
      slug: params.slug,
      args: toolArgs,
      filePath: params.file,
      schema: definition.schema,
    });
  }

  if (definition && shouldValidate) {
    validateToolInputArguments(params.slug, toolArgs, definition);
  }

  if (params.dryRun) {
    await runConnectedToolkitFailFast({
      config: params.config,
      sessionId: params.sessionId,
      toolSlug: params.slug,
      skip: params.skipConnectionCheck || params.skipChecks || local,
    });
    return {
      successful: true,
      dryRun: true,
      slug: params.slug,
      sessionId: params.sessionId,
      arguments: toolArgs,
      ...(definition
        ? { schemaPath: definition.schemaPath, schemaVersion: definition.version }
        : {}),
    };
  }

  if (local) {
    const localResult = await executeLocalTool(params.slug, toolArgs);
    if (localResult) {
      return {
        successful: true,
        data: localResult,
        error: null,
        logId: '',
      };
    }
    throw new CliError(`Local tool "${params.slug}" is not available in the bundled local tools provider.`);
  }

  await runConnectedToolkitFailFast({
    config: params.config,
    sessionId: params.sessionId,
    toolSlug: params.slug,
    skip: params.skipConnectionCheck || params.skipChecks,
  });

  const normalizedArgs =
    definition && !meta
      ? await uploadToolInputFiles({
          config: params.config,
          toolSlug: params.slug,
          arguments_: toolArgs,
          inputSchema: definition.schema,
          toolkitSlug: definition.toolkit ?? toolkitFromToolSlug(params.slug),
        })
      : toolArgs;

  if (meta) {
    const raw = await apiRequest<unknown>(params.config, {
      method: 'POST',
      path: `/api/v3.1/tool_router/session/${encodeURIComponent(params.sessionId)}/execute_meta`,
      body: {
        slug: params.slug,
        arguments: normalizedArgs,
      },
    });
    return normalizeExecuteResponse(raw);
  }

  const raw = await apiRequest<unknown>(params.config, {
    method: 'POST',
    path: `/api/v3.1/tool_router/session/${encodeURIComponent(params.sessionId)}/execute`,
    body: {
      tool_slug: params.slug,
      arguments: normalizedArgs,
      ...(params.account ? { account: params.account } : {}),
    },
  });
  return normalizeExecuteResponse(raw);
};

const runSingle = async (
  options: ExecuteOptions,
  io: CliIO,
  env: Env,
  sessionId: string,
  config: ReturnType<typeof readConfig>
): Promise<unknown> => {
  if (!options.slug) throw new CliError('Missing <slug> for execute.');
  const args = await resolveArgs(options.data, io);
  return executeSingle({
    args,
    account: options.account,
    config,
    env,
    file: options.file,
    getSchema: options.getSchema,
    dryRun: options.dryRun,
    sessionId,
    skipConnectionCheck: options.skipConnectionCheck,
    skipToolParamsCheck: options.skipToolParamsCheck,
    skipChecks: options.skipChecks,
    slug: options.slug,
  });
};

const runParallel = async (
  options: ExecuteOptions,
  io: CliIO,
  env: Env,
  sessionId: string,
  config: ReturnType<typeof readConfig>
): Promise<ParallelExecuteSummary> => {
  if (options.file) {
    throw new CliError('--file is not supported with --parallel. Pass file fields explicitly in each -d payload.');
  }

  if (options.specs.length === 0) {
    throw new CliError('At least one TOOL_SLUG -d <text> group is required with --parallel.');
  }

  const results = await Promise.all(
    options.specs.map(async spec => {
      try {
        const args = await resolveArgs(spec.data, io);
        const result = await executeSingle({
          args,
          account: spec.account ?? options.account,
          config,
          env,
          getSchema: options.getSchema,
          dryRun: options.dryRun,
          sessionId,
          skipConnectionCheck: options.skipConnectionCheck,
          skipToolParamsCheck: options.skipToolParamsCheck,
          skipChecks: options.skipChecks,
          slug: spec.slug,
        });
        return toParallelResult(spec.slug, result, env);
      } catch (error) {
        const mapped = mapComposioError({ error, toolSlug: spec.slug });
        return {
          slug: spec.slug,
          successful: false,
          error: mapped.message,
          ...(mapped.slugValue ? { errorSlug: mapped.slugValue } : {}),
        };
      }
    })
  );

  return {
    successful: results.every(result => result.successful),
    parallel: true,
    results,
  };
};

export const runExecute = async (args: string[], io: CliIO, env: Env): Promise<void> => {
  const options = parseExecuteArgs(args);
  const sessionId = requireSessionId(options.sessionId);
  const config = readConfig(env);

  if (options.parallel) {
    const result = await runParallel(options, io, env, sessionId, config);
    writeLine(io.stdout, serializeJsonLikeOriginalCli(result));
    appendCliSessionHistory({
      env,
      sessionId,
      entry: {
        command: 'execute',
        status: result.successful ? 'success' : 'error',
        parallel: true,
        results: result.results.map(item => ({
          slug: item.slug,
          successful: item.successful,
          ...(item.error ? { error: item.error } : {}),
          ...(typeof item.logId === 'string' ? { logId: item.logId } : {}),
          ...(item.storedInFile ? { storedInFile: true, outputFilePath: item.outputFilePath } : {}),
        })),
      },
    });
    if (!result.successful) {
      throw new CliError('One or more parallel tool executions failed.');
    }
    return;
  }

  const slug = options.slug ?? '';
  let result: unknown;
  try {
    result = await runSingle(options, io, env, sessionId, config);
  } catch (error) {
    const output = formatExecuteExceptionOutput({ error, slug });
    writeLine(io.stdout, output.json);
    appendCliSessionHistory({
      env,
      sessionId,
      entry: {
        command: 'execute',
        status: 'error',
        slug,
        error: output.message,
      },
    });
    throw new CliError(output.message);
  }

  writeLine(io.stdout, formatSingleExecuteOutput(options.slug ?? '', result, env));
  const error = getExecutionError(result);
  if (error) {
    appendCliSessionHistory({
      env,
      sessionId,
      entry: {
        command: 'execute',
        status: 'error',
        slug,
        error,
        arguments: isRecord(result) && 'arguments' in result ? result.arguments : undefined,
        logId: isRecord(result) && typeof result.logId === 'string' ? result.logId : undefined,
      },
    });
    throw new CliError(error);
  }

  const normalized = normalizeExecuteResponse(result);
  appendCliSessionHistory({
    env,
    sessionId,
    entry: {
      command: 'execute',
      status: isDryRunOutput(normalized) ? 'dry-run' : 'success',
      slug,
      storedInFile: isRecord(normalized) && 'storedInFile' in normalized ? normalized.storedInFile : false,
      logId: isRecord(normalized) && typeof normalized.logId === 'string' ? normalized.logId : undefined,
    },
  });
};
