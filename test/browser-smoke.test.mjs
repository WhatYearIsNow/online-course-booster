import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSmokeArgs, runBrowserSmoke, BrowserSmokeError } from '../scripts/browser-smoke.mjs';

test('browser smoke requires an explicit binary and never launches on import/help', () => {
  assert.deepEqual(parseSmokeArgs(['--help'], {}), { help: true });
  assert.throws(() => parseSmokeArgs([], {}));
  assert.throws(() => parseSmokeArgs(['--browser'], {}));
  assert.throws(() => parseSmokeArgs(['--browser', 'relative-browser'], {}));
  assert.throws(() => parseSmokeArgs(['--unknown', process.execPath], {}));
  assert.equal(parseSmokeArgs([], { CHROME_BINARY: process.execPath }).binary, process.execPath);
});
test('non-browser startup failure is classified without exposing paths or reporting success', async () => {
  let reported = false;
  await assert.rejects(
    runBrowserSmoke(
      { binary: process.execPath },
      {
        log() {
          reported = true;
        },
      },
    ),
    (error) => {
      assert.ok(error instanceof BrowserSmokeError);
      assert.equal(error.code, 'BROWSER_START_FAILED');
      assert.equal(Number.isInteger(error.browserExitCode), true);
      assert.equal(error.message, 'BROWSER_START_FAILED');
      return true;
    },
  );
  assert.equal(reported, false);
});
