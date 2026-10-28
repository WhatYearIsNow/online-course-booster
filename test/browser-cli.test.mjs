import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError, defaultDataDir, main, parseCli } from '../scripts/browser.mjs';

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ocb-browser-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePort(dir, port = 9222) {
  mkdirSync(join(dir, 'browser'), { recursive: true });
  writeFileSync(join(dir, 'browser', 'DevToolsActivePort'), `${port}\n/devtools/browser/EXAMPLE\n`);
}

function fakeClient(overrides = {}) {
  return {
    closed: false,
    close() {
      this.closed = true;
    },
    async createTarget() {
      return 'T1';
    },
    async navigate() {},
    async waitFor() {
      return true;
    },
    async evaluate() {
      return 'Example';
    },
    async getFrameTree() {
      return { frameTree: { frame: { url: 'https://example.com/' } } };
    },
    async screenshot() {},
    async call() {
      return {};
    },
    ...overrides,
  };
}

test('帮助与默认数据目录可离线使用', async () => {
  assert.equal(parseCli(['--help']).help, true);
  assert.equal(defaultDataDir({ OCB_DATA_DIR: 'D:/data' }, 'C:/work'), 'D:/data');
  assert.equal(defaultDataDir({}, 'C:/work'), join('C:/work', '.local', 'managed-browser'));
  let help = '';
  const code = await main(['--help'], { helpOutput: (text) => (help = text) });
  assert.equal(code, 0);
  assert.match(help, /受管浏览器/);
});

test('参数错误在启动前拒绝', () => {
  for (const argv of [
    [],
    ['nope'],
    ['open'],
    ['open', '--url', 'ftp://example.com/'],
    ['open', '--url', 'https://user:pass@example.com/'],
    ['status', '--url', 'https://example.com/'],
    ['status', '--headless'],
    ['start', '--headless', '--headless'],
    ['start', '--timeout-ms', '0'],
    ['start', '--wat'],
    ['open', '--url'],
  ]) {
    assert.throws(() => parseCli(argv), CliError, argv.join(' '));
  }
  assert.equal(parseCli(['open', '--url', 'https://example.com/']).command, 'open');
  assert.equal(parseCli(['start', '--headless']).headless, true);
});

test('status 只读报告，不启动浏览器', async (t) => {
  const dir = workspace(t);
  let output;
  const code = await main(['status', '--data-dir', dir], {
    launchDeps: { exists: () => true },
    output: (value) => (output = value),
  });
  assert.equal(code, 0);
  assert.equal(output.running, false);
  assert.ok(output.executable);
});

test('start 复用已有受管实例并报告端点', async (t) => {
  const dir = workspace(t);
  writePort(dir);
  const client = fakeClient();
  let output;
  const code = await main(['start', '--data-dir', dir], {
    launchDeps: { connect: async () => client, exists: () => true },
    output: (value) => (output = value),
  });
  assert.equal(code, 0);
  assert.equal(output.started, true);
  assert.equal(output.reused, true);
  assert.equal(client.closed, true);
});

test('open 等待条件成功时报告页面与截图', async (t) => {
  const dir = workspace(t);
  writePort(dir);
  const shot = join(dir, 'shot.png');
  let output;
  const code = await main(
    [
      'open',
      '--data-dir',
      dir,
      '--url',
      'https://example.com/',
      '--expect',
      'document.title',
      '--screenshot',
      shot,
    ],
    {
      launchDeps: { connect: async () => fakeClient(), exists: () => true },
      output: (value) => (output = value),
    },
  );
  assert.equal(code, 0);
  assert.equal(output.ok, true);
  assert.equal(output.url, 'https://example.com/');
  assert.equal(output.screenshot, shot);
});

test('open 条件未满足时返回部分失败而非成功', async (t) => {
  const dir = workspace(t);
  writePort(dir);
  let output;
  const code = await main(
    ['open', '--data-dir', dir, '--url', 'https://example.com/', '--expect', 'false', '--timeout-ms', '200'],
    {
      launchDeps: {
        connect: async () =>
          fakeClient({
            async waitFor(targetId, expression) {
              return expression.includes('readyState');
            },
          }),
        exists: () => true,
      },
      output: (value) => (output = value),
    },
  );
  assert.equal(code, 3);
  assert.equal(output.ok, false);
  assert.equal(output.reason, 'expect-timeout');
});

test('stop 在未运行时是幂等的', async (t) => {
  const dir = workspace(t);
  let output;
  const code = await main(['stop', '--data-dir', dir], {
    launchDeps: { exists: () => true },
    output: (value) => (output = value),
  });
  assert.equal(code, 0);
  assert.equal(output.reason, 'not-running');
});
