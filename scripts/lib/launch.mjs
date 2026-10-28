/**
 * Managed, isolated browser lifecycle. Node.js >=22.15; no runtime dependencies.
 *
 * A managed browser is a Chromium-family process started with its own dedicated
 * user-data-dir and an ephemeral loopback debug port. It is detached from the
 * CLI, so a task can run while the user keeps working in their daily browser.
 * The user's default browser, its profiles and its DevToolsActivePort file are
 * never read, copied, junctioned or modified. A first interactive login in the
 * managed profile persists there and is reused by later runs.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { connect as defaultConnect, sleep } from '../cdp.mjs';
import { validateEndpoint } from './connection-config.mjs';

const DEFAULT_LAUNCH_TIMEOUT_MS = 20_000;
const REUSE_CONNECT_TIMEOUT_MS = 1500;
const POLL_MS = 250;

export class BrowserLaunchError extends Error {
  constructor(message, code = 'ERR_BROWSER_LAUNCH', options) {
    super(message, options);
    this.name = 'BrowserLaunchError';
    this.code = code;
  }
}

/** Per-platform Chromium-family executable candidates; Linux uses PATH lookup. */
export function browserCandidates(env = process.env, platform = process.platform) {
  const under = (root, relative) => (root ? join(root, relative) : null);
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || '';
    const prog = env.PROGRAMFILES || '';
    const prog86 = env['PROGRAMFILES(X86)'] || '';
    return [
      under(local, 'Google/Chrome/Application/chrome.exe'),
      under(prog, 'Google/Chrome/Application/chrome.exe'),
      under(prog86, 'Google/Chrome/Application/chrome.exe'),
      under(local, 'Chromium/Application/chrome.exe'),
      under(prog86, 'Microsoft/Edge/Application/msedge.exe'),
      under(prog, 'Microsoft/Edge/Application/msedge.exe'),
      under(local, 'Microsoft/Edge/Application/msedge.exe'),
    ].filter(Boolean);
  }
  return [];
}

const LINUX_BROWSER_NAMES = [
  'google-chrome-stable',
  'google-chrome',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
  'brave-browser',
];

function whichExecutable(name) {
  return execFileSync('which', [name], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * Locate a Chromium-family executable. explicitPath (--browser / OCB_BROWSER)
 * wins; otherwise platform candidates, then PATH on Linux.
 */
export function findBrowserExecutable({
  explicitPath = null,
  env = process.env,
  platform = process.platform,
  candidates = browserCandidates(env, platform),
  which = whichExecutable,
  exists = existsSync,
} = {}) {
  if (explicitPath) {
    if (!exists(explicitPath))
      throw new BrowserLaunchError(
        `Configured browser executable does not exist: ${explicitPath}`,
        'ERR_BROWSER_CONFIGURATION',
      );
    return explicitPath;
  }
  for (const path of candidates) {
    if (exists(path)) return path;
  }
  if (platform !== 'win32' && platform !== 'darwin') {
    for (const name of LINUX_BROWSER_NAMES) {
      try {
        const found = which(name);
        if (found) return found;
      } catch {
        /* which exits nonzero when absent. */
      }
    }
  }
  throw new BrowserLaunchError(
    'No Chromium-based browser was found. Install Google Chrome (Chromium, Edge and Brave also work), or point --browser / OCB_BROWSER at an existing executable.',
    'ERR_BROWSER_CONFIGURATION',
  );
}

/** The managed profile directory; always a dedicated tree, never the user's. */
export function managedBrowserDir(dataDir) {
  return join(resolve(dataDir), 'browser');
}

/**
 * Read DevToolsActivePort inside the managed dir. Returns a loopback ws://
 * browser endpoint, or null when absent, briefly locked (Windows EBUSY) or
 * malformed. A stale file is indistinguishable here; callers verify by
 * connecting, and a fresh launch overwrites the file.
 */
export function readActiveEndpoint(dir, read = readFileSync) {
  let content;
  try {
    content = read(join(dir, 'DevToolsActivePort'), 'utf8');
  } catch {
    return null;
  }
  const lines = String(content).trim().split(/\r?\n/);
  const port = Number(lines[0]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (!/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(lines[1] || '')) return null;
  try {
    return validateEndpoint(`ws://127.0.0.1:${port}${lines[1]}`);
  } catch {
    return null;
  }
}

/** Command line for a managed launch; exported for tests. */
export function managedLaunchArgs({ profileDir, headless = false, url = 'about:blank' }) {
  return [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    ...(headless ? ['--headless=new', '--disable-gpu'] : []),
    url,
  ];
}

function writeStateAtomic(path, data) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(temporary, path);
}

/**
 * Ensure a managed browser is running and connectable. Reuses an already
 * running instance (verified by connecting, which also discards stale
 * DevToolsActivePort files); otherwise launches one detached process that
 * outlives this CLI, then waits for its ephemeral debug endpoint.
 * Returns { client, endpoint, reused, dir, executable }.
 */
export async function ensureManagedBrowser({
  dataDir,
  executable = null,
  headless = false,
  timeoutMs = DEFAULT_LAUNCH_TIMEOUT_MS,
  connect = defaultConnect,
  spawnImpl = spawn,
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  sleepImpl = sleep,
  signal,
} = {}) {
  if (!dataDir) throw new BrowserLaunchError('A managed browser data directory is required.');
  signal?.throwIfAborted();
  const dir = managedBrowserDir(dataDir);

  const existing = readActiveEndpoint(dir);
  if (existing) {
    try {
      const client = await connect(undefined, {
        endpoint: existing,
        connectTimeoutMs: REUSE_CONNECT_TIMEOUT_MS,
        env: {},
      });
      return { client, endpoint: existing, reused: true, dir, executable: null };
    } catch {
      /* Stale file or dying process: launch fresh below. */
    }
  }

  const resolvedExecutable = findBrowserExecutable({ explicitPath: executable, env, platform, exists });
  mkdirSync(dir, { recursive: true });
  const args = managedLaunchArgs({ profileDir: dir, headless });
  const child = spawnImpl(resolvedExecutable, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  let exited = null;
  child.once('exit', (code) => {
    exited = code;
  });
  const spawnError = new Promise((_, reject) => {
    child.once('error', (error) =>
      reject(
        new BrowserLaunchError(`Managed browser failed to start: ${error.message}`, 'ERR_BROWSER_LAUNCH', {
          cause: error,
        }),
      ),
    );
  });
  spawnError.catch(() => {});

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const endpoint = readActiveEndpoint(dir);
    if (endpoint) {
      try {
        const client = await connect(undefined, {
          endpoint,
          connectTimeoutMs: REUSE_CONNECT_TIMEOUT_MS,
          env: {},
        });
        try {
          writeStateAtomic(join(resolve(dataDir), 'browser-connection.json'), {
            pid: child.pid ?? null,
            endpoint,
            executable: resolvedExecutable,
            headless,
            startedAt: new Date().toISOString(),
          });
        } catch {
          /* The state file is diagnostic only. */
        }
        return { client, endpoint, reused: false, dir, executable: resolvedExecutable };
      } catch {
        /* Endpoint raced with startup; keep polling. */
      }
    }
    if (exited !== null)
      throw new BrowserLaunchError(
        `Managed browser exited during startup with code ${exited}. A headed launch on a machine without a display fails this way; try --headless.`,
        'ERR_BROWSER_LAUNCH',
      );
    if (Date.now() >= deadline)
      throw new BrowserLaunchError(
        `Managed browser did not become connectable within ${timeoutMs}ms. Try --headless or an explicit --endpoint.`,
        'ERR_BROWSER_LAUNCH',
      );
    await sleepImpl(POLL_MS, { signal });
  }
}

/**
 * Gracefully stop the managed browser (flushes cookies) by closing over CDP.
 * Browser.close often does not answer before exit, and on some platforms the
 * DevToolsActivePort file lingers after the process is gone, so shutdown is
 * confirmed by the endpoint refusing connections; a leftover file is stale and
 * is discarded by the reuse path's connect verification.
 */
export async function closeManagedBrowser({
  dataDir,
  waitMs = 5000,
  connect = defaultConnect,
  sleepImpl = sleep,
} = {}) {
  if (!dataDir) throw new BrowserLaunchError('A managed browser data directory is required.');
  const dir = managedBrowserDir(dataDir);
  const endpoint = readActiveEndpoint(dir);
  if (!endpoint) return { stopped: false, endpoint: null, reason: 'not-running' };
  let client;
  try {
    client = await connect(undefined, {
      endpoint,
      connectTimeoutMs: REUSE_CONNECT_TIMEOUT_MS,
      env: {},
    });
  } catch {
    return { stopped: false, endpoint, reason: 'not-reachable' };
  }
  try {
    await client.call('Browser.close', {}, null, { timeoutMs: 3000 });
  } catch {
    /* Most versions exit without answering. */
  }
  try {
    client.close();
  } catch {
    /* Already closed by the browser exiting. */
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    const current = readActiveEndpoint(dir);
    if (!current) return { stopped: true, endpoint, portFileRemoved: true };
    try {
      const probe = await connect(undefined, {
        endpoint: current,
        connectTimeoutMs: REUSE_CONNECT_TIMEOUT_MS,
        env: {},
      });
      try {
        probe.close();
      } catch {
        /* Probe only. */
      }
    } catch {
      return { stopped: true, endpoint, portFileRemoved: false };
    }
    if (Date.now() >= deadline) return { stopped: false, endpoint, reason: 'still-running' };
    await sleepImpl(POLL_MS);
  }
}

/** Read-only health snapshot for `browser status`; never throws. */
export async function browserStatus({
  dataDir,
  executable = null,
  env = process.env,
  platform = process.platform,
  connect = defaultConnect,
  exists = existsSync,
} = {}) {
  const dir = managedBrowserDir(dataDir);
  const report = {
    dataDir: resolve(dataDir),
    dir,
    executable: null,
    executableError: null,
    running: false,
    endpoint: null,
  };
  try {
    report.executable = findBrowserExecutable({ explicitPath: executable, env, platform, exists });
  } catch (error) {
    report.executableError = error.message;
  }
  report.endpoint = readActiveEndpoint(dir);
  if (report.endpoint) {
    try {
      const client = await connect(undefined, {
        endpoint: report.endpoint,
        connectTimeoutMs: REUSE_CONNECT_TIMEOUT_MS,
        env: {},
      });
      client.close();
      report.running = true;
    } catch {
      /* Endpoint file present but stale. */
    }
  }
  return report;
}
