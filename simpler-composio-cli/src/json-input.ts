import fs from 'node:fs/promises';
import { parse as parseJsonWithComments } from 'comment-json';
import { CliError } from './errors.js';
import { CliIO, readAllStdin } from './io.js';

export const parseJsonIsh = (raw: string): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    try {
      return parseJsonWithComments(raw, undefined, true) as unknown;
    } catch {
      return Function(`"use strict"; return (${raw});`)() as unknown;
    }
  }
};

export const parseArgumentsObject = (raw: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = parseJsonIsh(raw);
  } catch {
    throw new CliError(
      'Invalid JSON input. Provide JSON or a JS-style object literal, e.g. -d \'{ "key": "value" }\''
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('Expected a JSON object for tool arguments, e.g. -d \'{ "key": "value" }\'');
  }

  return parsed as Record<string, unknown>;
};

export const resolveTextInput = async (
  input: string | undefined,
  io: CliIO,
  options: { missingValue?: string; readPipedStdin?: boolean } = {}
): Promise<string | undefined> => {
  if (input !== undefined) {
    const value = input.trim();
    if (value === '-') {
      return readAllStdin(io.stdin);
    }

    if (value.startsWith('@')) {
      const filePath = value.slice(1).trim();
      if (!filePath) {
        throw new CliError('Missing file path after "@" in --data');
      }
      return fs.readFile(filePath, 'utf8');
    }

    return value;
  }

  if (options.readPipedStdin && io.stdin.isTTY === false) {
    const piped = await readAllStdin(io.stdin);
    if (piped.trim().length > 0) return piped;
  }

  return options.missingValue;
};
