#!/usr/bin/env node
import { CommanderError } from 'commander';
import { createProgram } from './program.js';

createProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    if (err instanceof CommanderError) {
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
        process.exit(err.exitCode);
      }
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
