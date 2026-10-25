#!/usr/bin/env node
/** Opt-in real Chrome smoke check. Uses only a new temporary profile and synthetic data URLs. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connect, sleep } from './cdp.mjs';

export class BrowserSmokeError extends Error {
  constructor(code, browserExitCode = null) {
    super(code);
    this.name = 'BrowserSmokeError';
    this.code = code;
    this.browserExitCode = browserExitCode;
  }
}

export function parseSmokeArgs(args, env = process.env) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  if (args.length && (args.length !== 2 || args[0] !== '--browser' || !args[1]))
    throw new Error('Use --browser <Chrome executable> or CHROME_BINARY.');
  const binary = args[1] ?? env.CHROME_BINARY;
  if (!binary || !isAbsolute(binary) || !existsSync(binary))
    throw new Error('Specify an existing absolute Chrome executable with --browser or CHROME_BINARY.');
  return { binary };
}
export async function runBrowserSmoke({ binary }, { log = console.log } = {}) {
  const base = resolve(dirname(fileURLToPath(import.meta.url)), '../.local/browser-smoke');
  mkdirSync(base, { recursive: true });
  const profile = mkdtempSync(resolve(base, 'run-'));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);
  let child, cdp, childError, exit;
  const checks = [];
  let browserVersion;
  try {
    child = spawn(
      binary,
      [
        '--headless=new',
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
        '--user-data-dir=' + profile,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-extensions',
        'about:blank',
      ],
      { windowsHide: true, stdio: 'ignore' },
    );
    child.once('error', (error) => {
      childError = error;
    });
    exit = new Promise((resolveExit) => child.once('exit', () => resolveExit(true)));
    while (!existsSync(resolve(profile, 'DevToolsActivePort'))) {
      if (childError || child.exitCode !== null)
        throw new BrowserSmokeError('BROWSER_START_FAILED', child.exitCode);
      await sleep(100, { signal: controller.signal });
    }
    cdp = await connect(undefined, { userDataDir: profile, env: {}, signal: controller.signal });
    browserVersion = (await cdp.call('Browser.getVersion')).product;
    checks.push('real-websocket-probe');
    const pages = await cdp.targets();
    assert.equal(pages.length, 1);
    const target = pages[0].targetId;
    const sessions = await Promise.all([cdp.session(target), cdp.session(target), cdp.session(target)]);
    assert.ok(sessions[0]);
    assert.equal(new Set(sessions).size, 1);
    checks.push('concurrent-attach');
    assert.deepEqual(await cdp.evaluate(target, '({value:6*7})'), { value: 42 });
    checks.push('page-evaluation');
    const url =
      'data:text/html,' +
      encodeURIComponent('<!doctype html><title>synthetic smoke</title><p>local test</p>');
    await cdp.navigate(target, url);
    assert.equal(
      await cdp.waitFor(target, 'document.title === "synthetic smoke"', { timeoutMs: 5000 }),
      true,
    );
    assert.equal((await cdp.getFrameTree(target)).frameTree.frame.url, url);
    checks.push('navigation-and-frame-tree');
    await assert.rejects(cdp.evaluate(target, 'throw new Error("synthetic")'), /synthetic/);
    await assert.rejects(cdp.call('Synthetic.nonexistentMethod'));
    checks.push('page-and-protocol-errors');
    const started = performance.now();
    assert.equal(await cdp.waitFor(target, 'false', { timeoutMs: 80, intervalMs: 10 }), false);
    assert.ok(performance.now() - started < 2000);
    checks.push('bounded-wait');
    const cancellation = new AbortController();
    cancellation.abort();
    await assert.rejects(cdp.waitFor(target, 'false', { signal: cancellation.signal }), {
      name: 'AbortError',
    });
    checks.push('cancellation');
  } finally {
    clearTimeout(timeout);
    try {
      await cdp?.call('Browser.close', {}, null, { timeoutMs: 2000 });
    } catch {
      /* Browser.close may close before responding. */
    }
    cdp?.close();
    if (child && child.exitCode === null && !childError) {
      if (!(await Promise.race([exit, sleep(3000).then(() => false)]))) {
        child.kill();
        if (!(await Promise.race([exit, sleep(2000).then(() => false)])))
          throw new Error('Isolated browser did not exit; temporary profile retained.');
      }
    }
    // Only the newly created profile is eligible for cleanup; never a user-supplied directory.
    const path = relative(base, profile);
    if (!path || path === '..' || path.startsWith('..' + sep) || isAbsolute(path))
      throw new Error('Refusing cleanup outside smoke workspace.');
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    } catch {
      throw new BrowserSmokeError('BROWSER_CLEANUP_FAILED', child?.exitCode ?? null);
    }
  }
  const result = {
    ok: true,
    browser: browserVersion,
    checks,
    count: checks.length,
    isolatedProfileRemoved: !existsSync(profile),
    coursePlatformTested: false,
  };
  log(JSON.stringify(result, null, 2));
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseSmokeArgs(process.argv.slice(2));
    if (options.help)
      console.log(
        'Opt-in isolated Chrome smoke: node scripts/browser-smoke.mjs --browser <absolute executable> (or CHROME_BINARY). No course account is used.',
      );
    else await runBrowserSmoke(options);
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        code: error instanceof BrowserSmokeError ? error.code : 'BROWSER_SMOKE_FAILED',
        browserExitCode: error instanceof BrowserSmokeError ? error.browserExitCode : null,
      }),
    );
    process.exitCode = 1;
  }
}
