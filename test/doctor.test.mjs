import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main, parseArgs, runDoctor } from '../scripts/doctor.mjs';

function fakeClient(overrides = {}) {
  return {
    connectionInfo: {
      source: 'endpoint',
      transport: 'websocket',
      localOnly: true,
      profile: { status: 'not-requested' },
    },
    async targets() {
      return [];
    },
    close() {},
    ...overrides,
  };
}

test('doctor import and --help never connect or access browser state', async () => {
  const lines = [];
  assert.equal(
    await main(['--help'], {
      connect() {
        throw new Error('must not connect');
      },
      log: (line) => lines.push(line),
    }),
    0,
  );
  assert.match(lines.join('\n'), /--endpoint/);
  const file = fileURLToPath(new URL('../scripts/doctor.mjs', import.meta.url));
  const help = spawnSync(process.execPath, [file, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, CDP_ENDPOINT: 'invalid-on-purpose' },
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
});

test('argument parser supports explicit config and rejects typos/missing/duplicate values', () => {
  assert.deepEqual(
    parseArgs([
      '--endpoint',
      'ws://localhost:9222/',
      '--user-data-dir',
      '/example',
      '--expect-profile',
      'Example',
      '--json',
    ]),
    {
      endpoint: 'ws://localhost:9222/',
      userDataDir: '/example',
      expectProfile: 'Example',
      json: true,
    },
  );
  for (const args of [
    ['--endpoint'],
    ['--endpoint', '--json'],
    ['--wat'],
    ['--endpoint', 'a', '--endpoint', 'b'],
  ])
    assert.throws(() => parseArgs(args));
});

test('doctor reports capabilities and platform counts without private pages or raw URLs', async () => {
  let closed = 0;
  const report = await runDoctor(
    {},
    {
      connect: async () =>
        fakeClient({
          async targets() {
            return [
              { url: 'https://private.example.org/?token=PRIVATE', title: 'PRIVATE' },
              { url: 'https://www.icourse163.org/learn/EXAMPLE-1001?tid=2001', title: 'PRIVATE' },
              { url: 'https://tsjy.chaoxing.com/path', title: 'PRIVATE' },
              { url: 'https://studyvideoh5.zhihuishu.com/path', title: 'PRIVATE' },
              { url: 'https://icourse163.org.evil.example/', title: 'PRIVATE' },
              { url: 'broken', title: 'PRIVATE' },
            ];
          },
          close() {
            closed++;
          },
        }),
    },
  );
  assert.equal(report.ok, true);
  assert.deepEqual(report.platforms, { chaoxing: 1, icourse163: 1, zhihuishu: 1 });
  assert.deepEqual(report.capabilities, { cdp: true, targetListing: true });
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|example.org|tid=|targetId/);
  assert.equal(closed, 1);
});

test('requested profile stays unverified and doctor exits nonzero without disclosing profile name', async () => {
  const connect = async () =>
    fakeClient({
      connectionInfo: {
        source: 'endpoint',
        transport: 'websocket',
        localOnly: true,
        profile: { status: 'unverified', expected: 'PRIVATE_PROFILE' },
      },
    });
  const report = await runDoctor({ expectProfile: 'PRIVATE_PROFILE' }, { connect });
  assert.equal(report.ok, false);
  assert.equal(report.profile.status, 'unverified');
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_PROFILE/);
  const output = [];
  assert.equal(
    await main(['--expect-profile', 'PRIVATE_PROFILE', '--json'], {
      connect,
      log: (line) => output.push(line),
    }),
    1,
  );
  assert.equal(JSON.parse(output[0]).profile.status, 'unverified');
});

test('doctor redacts transport/OS errors and always closes after target listing failure', async () => {
  const failure = new Error('PRIVATE cookie=SECRET ws://localhost:9222/private-token local/private/path');
  const failedConnection = await runDoctor(
    {},
    {
      connect: async () => {
        throw failure;
      },
    },
  );
  assert.equal(failedConnection.ok, false);
  assert.doesNotMatch(JSON.stringify(failedConnection), /PRIVATE|SECRET|private-token|private\/path/);
  let closed = false;
  const failedTargets = await runDoctor(
    {},
    {
      connect: async () =>
        fakeClient({
          async targets() {
            throw failure;
          },
          close() {
            closed = true;
          },
        }),
    },
  );
  assert.equal(closed, true);
  assert.equal(failedTargets.ok, false);
  assert.equal(failedTargets.capabilities.cdp, true);
  assert.equal(failedTargets.capabilities.targetListing, false);
});

test('doctor CLI main returns distinct status for invalid arguments and working connection', async () => {
  assert.equal(
    await main(['--unknown'], {
      log() {},
      connect() {
        throw new Error('must not connect');
      },
    }),
    2,
  );
  const lines = [];
  assert.equal(await main([], { connect: async () => fakeClient(), log: (line) => lines.push(line) }), 0);
  assert.match(lines.join('\n'), /Profile identity: not-requested/);
});
