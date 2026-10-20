import { ConfigError } from '../config/env.js';

export interface GlobalOpts {
  db?: string;
  json?: boolean;
  verbose?: boolean;
}

/** Prints an error (JSON or plain) and exits: 2 for bad usage/config, 1 for runtime errors. */
export function fail(err: unknown, json: boolean | undefined): never {
  const message = err instanceof Error ? err.message : String(err);
  const code = err instanceof ConfigError ? 2 : 1;
  if (json) {
    process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exit(code);
}

export function printResult(result: unknown, json: boolean | undefined, human: () => string): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(`${human()}\n`);
  }
}
