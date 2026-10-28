import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, parseCli } from '../scripts/icourse163.mjs';

const identity = ['--course', '1000', '--term', '2000'];
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ocb-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'replies.json'),
    rules = join(dir, 'rules.txt'),
    plan = join(dir, 'plan.json');
  writeFileSync(file, JSON.stringify([{ pid: 3000, html: '<p>测试预览。</p>' }]));
  writeFileSync(rules, '合成成绩规则，仅供离线测试。');
  return { dir, file, rules, plan };
}
const noBrowser = {
  connect() {
    throw new Error('BROWSER_MUST_NOT_BE_USED');
  },
  errorOutput() {},
};
test('help在没有Chrome和参数时可运行', async () => {
  let help = '';
  assert.equal(await main(['--help'], { ...noBrowser, helpOutput: (text) => (help = text) }), 0);
  assert.match(help, /讨论预览/);
});
test('严格参数与命令适用范围，错误发生在连接前', async () => {
  for (const argv of [
    [],
    ['status', ...identity, '--wat'],
    ['status', ...identity, '--submit'],
    ['status', ...identity, '--term', '2001'],
    ['discuss', ...identity],
    ['videos', ...identity, '--execute'],
    ['exam', ...identity, '--timeout-ms', '0'],
  ]) {
    assert.equal(await main(argv, noBrowser), 1, argv.join(' '));
  }
  assert.equal(parseCli(['videos', ...identity]).execute, undefined);
});
test('默认讨论预览完全离线，保存计划可复核且没有cookie或DWR请求体', async (t) => {
  const f = fixture(t);
  let output;
  const code = await main(['discuss', ...identity, '--file', f.file, '--rules', f.rules, '--plan', f.plan], {
    ...noBrowser,
    output: (value) => (output = value),
  });
  assert.equal(code, 0);
  assert.match(output.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(readFileSync(f.plan, 'utf8')), output);
  assert.doesNotMatch(JSON.stringify(output), /httpSessionId|scriptSessionId|csrfKey/);
  assert.equal(
    await main(['discuss', ...identity, '--file', f.file, '--rules', f.rules, '--plan', f.plan], noBrowser),
    1,
  );
});
test('dry-run兼容离线预览；无效输入不跳过', async (t) => {
  const f = fixture(t);
  assert.equal(
    await main(['discuss', ...identity, '--file', f.file, '--rules', f.rules, '--dry-run'], {
      ...noBrowser,
      output() {},
    }),
    0,
  );
  writeFileSync(f.file, '[{"pid":0,"html":"bad"}]');
  assert.equal(await main(['discuss', ...identity, '--file', f.file, '--rules', f.rules], noBrowser), 1);
});
test('提交要求正确摘要，修改计划/课程/学期均在连接前拒绝', async (t) => {
  const f = fixture(t);
  let plan;
  await main(['discuss', ...identity, '--file', f.file, '--rules', f.rules, '--plan', f.plan], {
    ...noBrowser,
    output: (value) => (plan = value),
  });
  assert.equal(
    await main(['discuss', ...identity, '--submit', '--plan', f.plan, '--confirm', 'bad'], noBrowser),
    1,
  );
  plan.replies[0].html = 'changed';
  writeFileSync(f.plan, JSON.stringify(plan));
  assert.equal(
    await main(['discuss', ...identity, '--submit', '--plan', f.plan, '--confirm', plan.digest], noBrowser),
    1,
  );
});
test('多目标和profile身份不明时阻断，连接始终清理', async () => {
  let closed = 0;
  const client = {
    close() {
      closed++;
    },
    connectionInfo: { profile: { status: 'unverified' } },
    async targets() {
      return [
        { targetId: 'one', url: 'https://www.icourse163.org/learn/DEMO-1000?tid=2000' },
        { targetId: 'two', url: 'https://www.icourse163.org/learn/DEMO-1000?tid=2000' },
      ];
    },
  };
  const deps = { connect: async () => client, errorOutput() {} };
  assert.equal(await main(['status', ...identity], deps), 2);
  assert.equal(await main(['status', ...identity, '--expect-profile', 'Example'], deps), 2);
  assert.equal(closed, 2);
});
test('预中断不触及浏览器，错误输出不回显凭据', async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(await main(['status', ...identity], { ...noBrowser, signal: controller.signal }), 4);
  let error;
  assert.equal(
    await main(['status', ...identity], {
      connect() {
        throw new Error('SENSITIVE_SESSION_VALUE');
      },
      errorOutput: (value) => (error = value),
    }),
    2,
  );
  assert.doesNotMatch(error, /SENSITIVE_SESSION_VALUE/);
});
test('已有输出文件在连接前阻断，不会在提交后才发现冲突', async (t) => {
  const f = fixture(t);
  const out = join(f.dir, 'existing.json');
  writeFileSync(out, 'preserve');
  let connected = false;
  assert.equal(
    await main(['status', ...identity, '--out', out], {
      connect() {
        connected = true;
      },
      errorOutput() {},
    }),
    1,
  );
  assert.equal(connected, false);
  assert.equal(readFileSync(out, 'utf8'), 'preserve');
});
test('命令总超时取消连接，不挂住CLI', async () => {
  const started = performance.now();
  const code = await main(['status', ...identity, '--timeout-ms', '100'], {
    connect: (dir, { signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      ),
    errorOutput() {},
  });
  assert.equal(code, 4);
  assert.ok(performance.now() - started < 2000);
});
test('受管浏览器参数互斥且在连接前校验', async () => {
  for (const argv of [
    ['status', ...identity, '--headless'],
    ['status', ...identity, '--data-dir', '.local/x'],
    ['status', ...identity, '--browser', 'C:/chrome.exe'],
    ['status', ...identity, '--managed', '--endpoint', 'ws://127.0.0.1:9222/devtools/browser/X'],
    ['status', ...identity, '--managed', '--expect-profile', 'Profile 4'],
  ]) {
    assert.equal(await main(argv, noBrowser), 1, argv.join(' '));
  }
  const parsed = parseCli(['status', ...identity, '--managed', '--headless', '--data-dir', '.local/x']);
  assert.equal(parsed.managed, true);
  assert.equal(parsed.headless, true);
});
test('受管模式走受管连接，不读取显式端点', async () => {
  let managedCalls = 0;
  let connectCalls = 0;
  const client = {
    close() {},
    connectionInfo: { profile: { status: 'not-requested' } },
    async targets() {
      return [{ targetId: 'one', url: 'https://www.icourse163.org/learn/DEMO-1000?tid=2000' }];
    },
  };
  await main(['status', ...identity, '--managed', '--data-dir', '.local/x'], {
    connect: async () => {
      connectCalls++;
      return client;
    },
    ensureManagedBrowser: async () => {
      managedCalls++;
      return { client };
    },
    errorOutput() {},
  });
  assert.equal(managedCalls, 1);
  assert.equal(connectCalls, 0);
});
