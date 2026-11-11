import test from 'node:test';
import assert from 'node:assert/strict';
import { main, parseCli } from '../scripts/chaoxing.mjs';

const identity = ['--course-id', '100', '--class-id', '200'];

function fakeClient({ userId = '900', courseId = '100', classId = '200', score = {}, banner = null } = {}) {
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
      if (banner && expression.includes('document.body.innerText')) return banner;
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

test('省略 --class-id 时自动解析当前账号的班级', async () => {
  let output;
  const code = await main(['status', '--course-id', '100'], {
    connect: async () => fakeClient(),
    output: (value) => (output = value),
  });
  assert.equal(code, 0);
  assert.equal(output.classId, '200');
  assert.equal(output.enrolled, true);
});

test('自动解析失败（未入班）时阻断 run', async () => {
  const client = fakeClient({ classId: '', banner: '您尚未报名，学习行为将不计分' });
  assert.equal(
    await main(['run', '--course-id', '100', '--target', '800'], {
      connect: async () => client,
      errorOutput() {},
    }),
    2,
  );
});

test('显式 classId 未入班时 run 阻断', async () => {
  const client = fakeClient({ banner: '您尚未报名，学习行为将不计分' });
  assert.equal(
    await main(['run', ...identity, '--target', '800'], {
      connect: async () => client,
      errorOutput() {},
    }),
    2,
  );
});

test('status 报告入班状态（横幅存在时 enrolled=false）', async () => {
  let output;
  const code = await main(['status', ...identity], {
    connect: async () => fakeClient({ banner: '您尚未报名，学习行为将不计分' }),
    output: (value) => (output = value),
  });
  assert.equal(code, 0);
  assert.equal(output.enrolled, false);
});

test('class-id 可选且必须是正整数', () => {
  assert.equal(parseCli(['status', '--course-id', '100']).classId, null);
  assert.throws(
    () => parseCli(['status', '--course-id', '100', '--class-id', '0']),
    (error) => error.code === 1,
  );
});

test('bank 参数校验与默认路径', async () => {
  const base = ['run', '--course-id', '100', '--class-id', '200', '--target', '800'];
  assert.ok(parseCli(base).bankPath.endsWith('answer-bank.json'));
  assert.equal(parseCli([...base, '--no-bank']).bankPath, null);
  assert.equal(parseCli([...base, '--bank', 'X.json']).bankPath, 'X.json');
  assert.equal(await main([...base, '--bank', 'X.json', '--no-bank'], { errorOutput() {} }), 1);
  assert.equal(
    await main(['status', '--course-id', '100', '--class-id', '200', '--bank', 'X.json'], {
      errorOutput() {},
    }),
    1,
  );
});

function fakeLoginClient({ vcode = '', tip = '' } = {}) {
  let created = false;
  let logged = false;
  return {
    async targets() {
      if (!created) return [];
      if (!logged) return [{ targetId: 'L1', url: 'https://passport2.chaoxing.com/login?fid=' }];
      return [{ targetId: 'L1', url: 'https://i.chaoxing.com/base?t=1' }];
    },
    async createTarget() {
      created = true;
      return 'L1';
    },
    async navigate() {},
    async waitFor() {
      return true;
    },
    async evaluate(targetId, expression) {
      if (expression.includes("getElementById('phone')")) return 11;
      if (expression.includes("getElementById('pwd')")) return 13;
      if (expression.includes('.auto-lg-next')) return true;
      if (expression.includes('loginTip')) {
        logged = vcode === '' && tip === '';
        return { tipText: tip, needVcode: vcode };
      }
      return null;
    },
  };
}

test('login 参数校验', async () => {
  assert.equal(await main(['login'], { errorOutput() {} }), 1);
  assert.equal(await main(['login', '--phone', '15700000000'], { errorOutput() {} }), 1);
  assert.equal(
    await main(['login', '--phone', '15700000000', '--password', 'x', '--course-id', '1'], {
      errorOutput() {},
    }),
    1,
  );
  assert.equal(
    await main(['login', '--cred', 'a.json', '--phone', '15700000000', '--password', 'x'], {
      errorOutput() {},
    }),
    1,
  );
});

test('login 成功路径输出落点 URL', async () => {
  let output;
  const code = await main(['login', '--phone', '15700000000', '--password', 'x'], {
    connect: async () => fakeLoginClient(),
    output: (value) => (output = value),
  });
  assert.equal(code, 0);
  assert.equal(output.state, 'ok');
  assert.ok(String(output.url).includes('i.chaoxing.com'));
});

test('login 验证码即停', async () => {
  assert.equal(
    await main(['login', '--phone', '15700000000', '--password', 'x'], {
      connect: async () => fakeLoginClient({ vcode: '1' }),
      errorOutput() {},
    }),
    2,
  );
});

test('login 登录失败提示即停', async () => {
  assert.equal(
    await main(['login', '--phone', '15700000000', '--password', 'x'], {
      connect: async () => fakeLoginClient({ tip: '用户名或密码错误' }),
      errorOutput() {},
    }),
    2,
  );
});
