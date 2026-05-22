#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CliError, HttpError } from './errors.js';
import { defaultIO, CliIO, writeLine } from './io.js';
import { Env } from './config.js';
import { rootHelp } from './help/root.js';
import { searchHelp } from './help/search.js';
import { executeHelp } from './help/execute.js';
import { proxyHelp } from './help/proxy.js';
import { runSearch } from './commands/search.js';
import { runExecute } from './commands/execute.js';
import { runProxy } from './commands/proxy.js';

const isHelpRequest = (args: string[]): boolean =>
  args.length === 0 || args.includes('--help') || args.includes('-h');

const commandHelp = (command: string): string => {
  switch (command) {
    case 'search':
      return searchHelp();
    case 'execute':
      return executeHelp();
    case 'proxy':
      return proxyHelp();
    default:
      return rootHelp();
  }
};

const formatError = (error: unknown): string => {
  if (error instanceof HttpError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
};

export const runCli = async (
  argv = process.argv.slice(2),
  io: CliIO = defaultIO,
  env: Env = process.env
): Promise<number> => {
  try {
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
      writeLine(io.stdout, rootHelp());
      return 0;
    }

    const command = argv[0] ?? '';
    const rest = argv.slice(1);
    if (isHelpRequest(rest)) {
      writeLine(io.stdout, commandHelp(command));
      return command === 'search' || command === 'execute' || command === 'proxy' ? 0 : 1;
    }

    switch (command) {
      case 'search':
        await runSearch(rest, io, env);
        return 0;
      case 'execute':
        await runExecute(rest, io, env);
        return 0;
      case 'proxy':
        await runProxy(rest, io, env);
        return 0;
      default:
        throw new CliError(`Unknown command: ${command}. Supported commands are search, execute, and proxy.`);
    }
  } catch (error) {
    writeLine(io.stderr, formatError(error));
    return error instanceof CliError ? error.exitCode : 1;
  }
};

const realpathIfPresent = (file: string): string => {
  try {
    return realpathSync.native(file);
  } catch {
    return file;
  }
};

const currentFile = realpathIfPresent(fileURLToPath(import.meta.url));
const invokedFile = process.argv[1] ? realpathIfPresent(path.resolve(process.argv[1])) : '';

if (currentFile === invokedFile) {
  const code = await runCli();
  process.exitCode = code;
}
