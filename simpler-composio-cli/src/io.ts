import process from 'node:process';

export type WritableLike = {
  write(chunk: string): unknown;
};

export type ReadableLike = AsyncIterable<Buffer | string> & {
  isTTY?: boolean;
};

export type CliIO = {
  stdout: WritableLike;
  stderr: WritableLike;
  stdin: ReadableLike;
};

export const defaultIO: CliIO = {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
};

export const writeLine = (stream: WritableLike, text = ''): void => {
  stream.write(`${text}\n`);
};

export const readAllStdin = async (stdin: ReadableLike): Promise<string> => {
  let value = '';
  for await (const chunk of stdin) {
    value += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }
  return value;
};

