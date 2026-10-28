import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  browserCandidates,
  browserStatus,
  closeManagedBrowser,
  ensureManagedBrowser,
  findBrowserExecutable,
  managedBrowserDir,
  managedLaunchArgs,
  readActiveEndpoint,
} from '../scripts/lib/launch.mjs';

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ocb-launch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePort(dir, port = 9222, path = '/devtools/browser/EXAMPLE') {
  mkdirSync(join(dir, 'browser'), { recursive: true });
  writeFileSync(join(dir, 'browser', 'DevToolsActivePort'), `${port}\n${path}\n`);
}

function fakeChild() {
  const listeners = new Map();
  return {
    pid: 4242,
    unref() {},
    once(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    emit(event, value) {
      for (const fn of listeners.get(event) ?? []) fn(value);
    },
  };
}

function fakeClient(overrides = {}) {
  return {
    closed: false,
    close() {
      this.closed = true;
    },
    ...overrides,
  };
}

test('候选可执行文件按平台生成，空根目录被过滤', () => {
  const win = browserCandidates(
    { LOCALAPPDATA: 'C:/Local', PROGRAMFILES: 'C:/Prog', 'PROGRAMFILES(X86)': '' },
    'win32',
  );
  assert.ok(win.every((path) => path && !path.startsWith('Google')));
  assert.ok(win.some((path) => path.endsWith('chrome.exe')));
  assert.deepEqual(browserCandidates({}, 'linux'), []);
});

test('显式可执行文件缺失时报配置错误，候选命中时返回', () => {
  assert.throws(() => findBrowserExecutable({ explicitPath: 'C:/missing/chrome.exe', exists: () => false }), {
    code: 'ERR_BROWSER_CONFIGURATION',
  });
  assert.equal(
    findBrowserExecutable({
      candidates: ['C:/a/chrome.exe', 'C:/b/chrome.exe'],
      exists: (path) => path === 'C:/b/chrome.exe',
      platform: 'win32',
    }),
    'C:/b/chrome.exe',
  );
  assert.throws(() => findBrowserExecutable({ candidates: [], exists: () => false, platform: 'win32' }), {
    code: 'ERR_BROWSER_CONFIGURATION',
  });
});

test('DevToolsActivePort 只接受回环端口与浏览器路径', (t) => {
  const dir = workspace(t);
  assert.equal(readActiveEndpoint(join(dir, 'browser')), null);
  writePort(dir);
  assert.equal(readActiveEndpoint(join(dir, 'browser')), 'ws://127.0.0.1:9222/devtools/browser/EXAMPLE');
  writeFileSync(join(dir, 'browser', 'DevToolsActivePort'), '0\n/devtools/browser/X\n');
  assert.equal(readActiveEndpoint(join(dir, 'browser')), null);
  writeFileSync(join(dir, 'browser', 'DevToolsActivePort'), '9222\nhttp://evil.example/\n');
  assert.equal(readActiveEndpoint(join(dir, 'browser')), null);
});

test('启动参数使用独立资料目录与动态回环端口', () => {
  const args = managedLaunchArgs({ profileDir: 'C:/data/browser', headless: true });
  assert.ok(args.includes('--user-data-dir=C:/data/browser'));
  assert.ok(args.includes('--remote-debugging-port=0'));
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(args.includes('--headless=new'));
  assert.equal(args.at(-1), 'about:blank');
  assert.ok(!managedLaunchArgs({ profileDir: 'x' }).includes('--headless=new'));
});

test('已有实例可连接时复用，不再启动新进程', async (t) => {
  const dir = workspace(t);
  writePort(dir);
  let spawned = 0;
  const client = fakeClient();
  const result = await ensureManagedBrowser({
    dataDir: dir,
    spawnImpl: () => {
      spawned++;
      return fakeChild();
    },
    connect: async () => client,
    exists: () => true,
  });
  assert.equal(result.reused, true);
  assert.equal(result.client, client);
  assert.equal(spawned, 0);
  assert.equal(result.dir, managedBrowserDir(dir));
});

test('未运行时启动分离进程并等待调试端点', async (t) => {
  const dir = workspace(t);
  const client = fakeClient();
  let capturedArgs;
  const child = fakeChild();
  const result = await ensureManagedBrowser({
    dataDir: dir,
    headless: true,
    spawnImpl: (executable, args) => {
      capturedArgs = args;
      writePort(dir, 9333, '/devtools/browser/LAUNCHED');
      return child;
    },
    connect: async (profileDir, { endpoint }) => {
      assert.equal(endpoint, 'ws://127.0.0.1:9333/devtools/browser/LAUNCHED');
      return client;
    },
    exists: () => true,
    sleepImpl: async () => {},
  });
  assert.equal(result.reused, false);
  assert.equal(result.client, client);
  assert.ok(capturedArgs.includes('--headless=new'));
});

test('启动期间进程退出或超时都明确失败', async (t) => {
  const dir = workspace(t);
  const child = fakeChild();
  await assert.rejects(
    ensureManagedBrowser({
      dataDir: dir,
      spawnImpl: () => {
        setTimeout(() => child.emit('exit', 1), 0);
        return child;
      },
      connect: async () => fakeClient(),
      exists: () => true,
      sleepImpl: async () => {},
      timeoutMs: 500,
    }),
    { code: 'ERR_BROWSER_LAUNCH' },
  );
  await assert.rejects(
    ensureManagedBrowser({
      dataDir: dir,
      spawnImpl: () => fakeChild(),
      connect: async () => fakeClient(),
      exists: () => true,
      sleepImpl: async () => {},
      timeoutMs: 1,
    }),
    { code: 'ERR_BROWSER_LAUNCH' },
  );
});

test('取消信号阻止启动', async (t) => {
  const dir = workspace(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    ensureManagedBrowser({
      dataDir: dir,
      spawnImpl: () => fakeChild(),
      connect: async () => fakeClient(),
      exists: () => true,
      signal: controller.signal,
    }),
    { name: 'AbortError' },
  );
});

test('关闭：未运行、已停止与不可达分别报告', async (t) => {
  const dir = workspace(t);
  assert.deepEqual(await closeManagedBrowser({ dataDir: dir }), {
    stopped: false,
    endpoint: null,
    reason: 'not-running',
  });
  writePort(dir);
  const client = fakeClient({
    async call() {
      return {};
    },
  });
  let reads = 0;
  const stopped = await closeManagedBrowser({
    dataDir: dir,
    connect: async () => {
      reads++;
      if (reads > 1) throw new Error('closed');
      return client;
    },
    sleepImpl: async () => {},
    waitMs: 10,
  });
  assert.equal(stopped.stopped, true);
  assert.equal(client.closed, true);
});

test('status 只读报告，不启动进程', async (t) => {
  const dir = workspace(t);
  const report = await browserStatus({ dataDir: dir, exists: () => true });
  assert.equal(report.running, false);
  assert.ok(report.executable);
  assert.equal(report.dir, managedBrowserDir(dir));
});
