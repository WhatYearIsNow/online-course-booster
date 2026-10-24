// Backward-compatible offline entry point. Discover every test/*.test.mjs suite.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = spawnSync(process.execPath, ['--test'], { cwd: root, stdio: 'inherit' });
if (result.error) console.error(`Unable to start tests: ${result.error.message}`);
process.exitCode = result.status ?? 1;
