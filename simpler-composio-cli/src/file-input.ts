import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CliConfig } from './config.js';
import { CliError } from './errors.js';
import { apiRequest } from './http.js';
import { toolkitFromToolSlug } from './toolkit.js';

export type JsonSchema = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getSchemaVariants = (schema: JsonSchema | undefined): ReadonlyArray<JsonSchema> => [
  ...((Array.isArray(schema?.anyOf) ? schema.anyOf : []) as JsonSchema[]),
  ...((Array.isArray(schema?.oneOf) ? schema.oneOf : []) as JsonSchema[]),
  ...((Array.isArray(schema?.allOf) ? schema.allOf : []) as JsonSchema[]),
];

const transformSchema = (schema: JsonSchema): JsonSchema => {
  if (schema.file_uploadable === true) {
    return {
      title: schema.title,
      description: schema.description,
      format: 'path',
      type: 'string',
      file_uploadable: true,
    };
  }

  const transformed: JsonSchema = { ...schema };
  if (isRecord(schema.properties)) {
    transformed.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        isRecord(value) ? transformSchema(value) : value,
      ])
    );
  }

  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(schema[key])) {
      transformed[key] = schema[key].map(value =>
        isRecord(value) ? transformSchema(value) : value
      );
    }
  }

  if (Array.isArray(schema.items)) {
    transformed.items = schema.items.map(value => (isRecord(value) ? transformSchema(value) : value));
  } else if (isRecord(schema.items)) {
    transformed.items = transformSchema(schema.items);
  }

  return transformed;
};

export const normalizeFileUploadSchema = (schema: JsonSchema): JsonSchema => transformSchema(schema);

export const schemaHasFileUploadable = (schema: JsonSchema | undefined): boolean => {
  if (!schema) return false;
  if (schema.file_uploadable === true) return true;

  if (isRecord(schema.properties)) {
    for (const property of Object.values(schema.properties)) {
      if (isRecord(property) && schemaHasFileUploadable(property)) return true;
    }
  }

  for (const variant of getSchemaVariants(schema)) {
    if (schemaHasFileUploadable(variant)) return true;
  }

  if (Array.isArray(schema.items)) {
    return schema.items.some(item => isRecord(item) && schemaHasFileUploadable(item));
  }

  if (isRecord(schema.items)) return schemaHasFileUploadable(schema.items);
  return false;
};

export const findFileUploadablePaths = (
  schema: JsonSchema | undefined,
  basePath: ReadonlyArray<string> = []
): ReadonlyArray<ReadonlyArray<string>> => {
  if (!schema) return [];
  if (schema.file_uploadable === true) return [basePath];

  const directPropertyPaths = isRecord(schema.properties)
    ? Object.entries(schema.properties).flatMap(([key, property]) =>
        isRecord(property) ? findFileUploadablePaths(property, [...basePath, key]) : []
      )
    : [];

  const variantPaths = getSchemaVariants(schema).flatMap(variant =>
    findFileUploadablePaths(variant, basePath)
  );

  const itemPaths = Array.isArray(schema.items)
    ? schema.items.flatMap(item => (isRecord(item) ? findFileUploadablePaths(item, basePath) : []))
    : isRecord(schema.items)
      ? findFileUploadablePaths(schema.items, basePath)
      : [];

  const seen = new Set<string>();
  return [...directPropertyPaths, ...variantPaths, ...itemPaths].filter(pathParts => {
    const key = pathParts.join('.');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const hasNestedKey = (
  record: Record<string, unknown>,
  pathParts: ReadonlyArray<string>
): boolean => {
  let current: unknown = record;
  for (const key of pathParts) {
    if (!isRecord(current)) return false;
    if (!(key in current)) return false;
    current = current[key];
  }
  return true;
};

const setNestedKey = (
  record: Record<string, unknown>,
  pathParts: ReadonlyArray<string>,
  value: unknown
): Record<string, unknown> => {
  const clone: Record<string, unknown> = { ...record };
  let current = clone;

  for (const [index, key] of pathParts.entries()) {
    if (index === pathParts.length - 1) {
      current[key] = value;
      break;
    }

    const next = current[key];
    const nextObject = isRecord(next) ? { ...next } : {};
    current[key] = nextObject;
    current = nextObject;
  }

  return clone;
};

export const injectSingleFileArgument = (params: {
  slug: string;
  args: Record<string, unknown>;
  filePath: string;
  schema: JsonSchema;
}): Record<string, unknown> => {
  const uploadablePaths = findFileUploadablePaths(params.schema);
  if (uploadablePaths.length === 0) {
    throw new CliError(`Tool "${params.slug}" has no file_uploadable input. Remove --file or pass JSON via -d.`);
  }

  if (uploadablePaths.length > 1) {
    throw new CliError(
      `Tool "${params.slug}" has multiple file_uploadable inputs (${uploadablePaths
        .map(parts => parts.join('.'))
        .join(', ')}). Pass the target field explicitly with -d instead of --file.`
    );
  }

  const targetPath = uploadablePaths[0] ?? [];
  if (hasNestedKey(params.args, targetPath)) {
    throw new CliError(
      `Cannot use --file because "${targetPath.join('.')}" is already set in -d. Remove that field or omit --file.`
    );
  }

  return setNestedKey(params.args, targetPath, params.filePath);
};

const extensionMimeTypes: Record<string, string> = {
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
};

const guessMimeType = (filePath: string, fallback?: string): string =>
  fallback || extensionMimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';

const readUploadSource = async (source: string): Promise<{
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
}> => {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new CliError(`Failed to fetch file: HTTP ${response.status} ${response.statusText}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const parsedUrl = new URL(source);
    const fileName = path.basename(parsedUrl.pathname) || `file-${Date.now()}`;
    return {
      bytes,
      fileName,
      mimeType: guessMimeType(fileName, response.headers.get('content-type') ?? undefined),
    };
  }

  return {
    bytes: new Uint8Array(await fs.readFile(source)),
    fileName: path.basename(source),
    mimeType: guessMimeType(source),
  };
};

const uploadFile = async (params: {
  config: CliConfig;
  file: string;
  toolSlug: string;
  toolkitSlug: string;
}): Promise<Record<string, unknown>> => {
  const fileData = await readUploadSource(params.file);
  const md5 = crypto.createHash('md5').update(fileData.bytes).digest('hex');
  const presigned = await apiRequest<{
    key: string;
    new_presigned_url: string;
    metadata?: { storage_backend?: string };
  }>(params.config, {
    method: 'POST',
    path: '/api/v3.1/files/upload/request',
    body: {
      filename: fileData.fileName,
      mimetype: fileData.mimeType,
      md5,
      tool_slug: params.toolSlug,
      toolkit_slug: params.toolkitSlug,
    },
  });

  const uploadHeaders: Record<string, string> = {
    'Content-Type': fileData.mimeType,
    'Content-Length': fileData.bytes.byteLength.toString(),
  };
  if (presigned.metadata?.storage_backend === 'azure_blob_storage') {
    uploadHeaders['x-ms-blob-type'] = 'BlockBlob';
  }
  const uploadBody = fileData.bytes.buffer.slice(
    fileData.bytes.byteOffset,
    fileData.bytes.byteOffset + fileData.bytes.byteLength
  ) as ArrayBuffer;

  const uploadResponse = await fetch(presigned.new_presigned_url, {
    method: 'PUT',
    body: uploadBody,
    headers: uploadHeaders,
  });

  if (!uploadResponse.ok) {
    throw new CliError(`Failed to upload file: HTTP ${uploadResponse.status} ${uploadResponse.statusText}`);
  }

  return {
    name: fileData.fileName,
    mimetype: fileData.mimeType,
    s3key: presigned.key,
  };
};

const hydrateFileUploads = async (
  value: unknown,
  schema: JsonSchema | undefined,
  ctx: { config: CliConfig; toolSlug: string; toolkitSlug: string }
): Promise<unknown> => {
  if (schema?.file_uploadable === true) {
    if (typeof value !== 'string') return value;
    return uploadFile({
      config: ctx.config,
      file: value,
      toolSlug: ctx.toolSlug,
      toolkitSlug: ctx.toolkitSlug,
    });
  }

  const uploadableVariants = getSchemaVariants(schema).filter(schemaHasFileUploadable);
  if (uploadableVariants.length > 0) {
    let nextValue = value;
    for (const variant of uploadableVariants) {
      nextValue = await hydrateFileUploads(nextValue, variant, ctx);
    }
    return nextValue;
  }

  if (isRecord(schema?.properties) && isRecord(value)) {
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, entryValue]) => [
        key,
        await hydrateFileUploads(
          entryValue,
          isRecord((schema.properties as Record<string, unknown>)[key])
            ? ((schema.properties as Record<string, unknown>)[key] as JsonSchema)
            : undefined,
          ctx
        ),
      ])
    );
    return Object.fromEntries(entries);
  }

  if (schema?.type === 'array' && Array.isArray(value) && schema.items) {
    const itemSchema = Array.isArray(schema.items)
      ? schema.items.find(isRecord)
      : isRecord(schema.items)
        ? schema.items
        : undefined;
    return Promise.all(value.map(item => hydrateFileUploads(item, itemSchema, ctx)));
  }

  return value;
};

export const uploadToolInputFiles = async (params: {
  config: CliConfig;
  toolSlug: string;
  arguments_: Record<string, unknown>;
  inputSchema: JsonSchema;
  toolkitSlug?: string;
}): Promise<Record<string, unknown>> => {
  if (!schemaHasFileUploadable(params.inputSchema)) return params.arguments_;

  const hydrated = await hydrateFileUploads(params.arguments_, params.inputSchema, {
    config: params.config,
    toolSlug: params.toolSlug,
    toolkitSlug: params.toolkitSlug ?? toolkitFromToolSlug(params.toolSlug) ?? 'unknown',
  });

  return isRecord(hydrated) ? hydrated : params.arguments_;
};
