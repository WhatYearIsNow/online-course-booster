#!/usr/bin/env node
/** Keep test fixtures in a writable, per-run project directory, not a host-specific temp. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = resolve(root, '.local/test-runs');
mkdirSync(base, { recursive: true });
const temporary = mkdtempSync(resolve(base, 'run-'));
let child;
const stop = (signal) => child?.kill(signal);
const interrupt = () => stop('SIGINT');
const terminate = () => stop('SIGTERM');
process.once('SIGINT', interrupt);
process.once('SIGTERM', terminate);
try {
  child = spawn(process.execPath, ['--test', ...process.argv.slice(2)], {
    cwd: root,
    windowsHide: true,
    stdio: 'inherit',
    env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary },
  });
  process.exitCode = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => done(code ?? (signal === 'SIGINT' ? 130 : 1)));
  });
} catch {
  console.error('Could not start the test runner.');
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
  const local = relative(base, temporary);
  if (!local || local === '..' || local.startsWith('..' + sep) || isAbsolute(local))
    throw new Error('Unsafe test cleanup path');
  try {
    rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    console.error('Test fixture cleanup failed.');
    process.exitCode = 1;
  }
}
