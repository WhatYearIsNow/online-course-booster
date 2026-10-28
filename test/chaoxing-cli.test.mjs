import test from 'node:test';
import assert from 'node:assert/strict';
import { main, parseCli } from '../scripts/chaoxing.mjs';

const identity = ['--course-id', '100', '--class-id', '200'];

function fakeClient({ userId = '900', courseId = '100', classId = '200', score = {} } = {}) {
  return {
    closed: false,
    close() {
      this.closed = true;
    },
    async targets() {
      return [
        { targetId: 'P1', url: `https://tsjy.chaoxing.com/plaza/?courseId=${courseId}&classId=${classId}` },
      ];
    },
    async waitFor() {
      return true;
    },
    async evaluate(targetId, expression) {
      if (expression.includes('window.userId')) return { userId, courseId, classId, personId: '1' };
      if (expression.includes('user-score-detail'))
        return { data: { totalScore: 1, courseMinScore: 800, dayScore: 1, items: [], ...score } };
      return null;
    },
  };
}

test('帮助可离线运行', async () => {
  let help = '';
  assert.equal(await main(['--help'], { helpOutput: (text) => (help = text) }), 0);
  assert.match(help, /形势与政策广场/);
});

test('参数错误在连接前拒绝', async () => {
  for (const argv of [
    [],
    ['nope', ...identity],
    ['status'],
    ['status', '--course-id', '0', '--class-id', '200'],
    ['quiz', ...identity],
    ['run', ...identity],
    ['run', ...identity, '--target', '0'],
    ['status', ...identity, '--target', '800'],
    ['status', ...identity, '--submit'],
    ['quiz', ...identity, '--chapter', '300', '--submit'],
    ['status', ...identity, '--managed', '--endpoint', 'ws://127.0.0.1:1/devtools/browser/x'],
    ['status', ...identity, '--headless'],
    ['status', ...identity, '--strategy', 'smart'],
    ['status', ...identity, '--classify', '1,x'],
  ]) {
    assert.equal(await main(argv, { errorOutput() {} }), 1, argv.join(' '));
  }
  assert.equal(parseCli(['quiz', ...identity, '--chapter', '300']).chapter, '300');
  assert.equal(parseCli(['run', ...identity, '--target', '800']).target, 800);
});

test('status 只读输出积分与身份', async () => {
  let output;
  const client = fakeClient();
  const code = await main(['status', ...identity], {
    connect: async () => client,
    output: (value) => (output = value),
  });
  assert.equal(code, 0);
  assert.equal(output.identity.userId, '900');
  assert.equal(output.score.total, 1);
  assert.equal(output.score.min, 800);
  assert.equal(client.closed, true);
});

test('未登录或身份不符时阻断', async () => {
  assert.equal(
    await main(['status', ...identity], {
      connect: async () => fakeClient({ userId: '' }),
      errorOutput() {},
    }),
    2,
  );
  assert.equal(
    await main(['status', ...identity], {
      connect: async () => fakeClient({ courseId: '999' }),
      errorOutput() {},
    }),
    2,
  );
  assert.equal(
    await main(['status', ...identity, '--expect-user', '901'], {
      connect: async () => fakeClient({ userId: '900' }),
      errorOutput() {},
    }),
    2,
  );
});
