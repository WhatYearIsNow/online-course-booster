import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pageEval, status, validateProgress, submitDiscussions, runCommand } from '../scripts/lib/mooc.mjs';
import { createPlan } from '../scripts/lib/workflow.mjs';

const identity = { course: '1000', term: '2000' };
const url = 'https://www.icourse163.org/learn/DEMO-1000?tid=2000';
const target = { targetId: 'target', url };
function fakeClient(handlers = {}) {
  let current = url;
  return {
    async getFrameTree() { return { frameTree: { frame: { url: handlers.frameUrl ?? current } } }; },
    async navigate(id, next) { current = next; },
    async waitFor() { return handlers.ready ?? true; },
    async evaluate(id, expression) {
      new vm.Script(expression); // 所有注入表达式都必须是有效的 JavaScript。
      if (handlers.evaluate) return handlers.evaluate(expression);
      return vm.runInNewContext(expression, { URL, URLSearchParams, AbortSignal, location: { href: handlers.pageUrl ?? current }, document: { cookie: 'NTESSTUDYSI=synthetic-test-session' }, fetch: handlers.fetch });
    },
  };
}
test('上下文内再次校验身份，防止快照后发生导航', async () => {
  await assert.rejects(pageEval(fakeClient({ pageUrl: url.replace('2000', '2001') }), target.targetId, identity, () => true), /TARGET_IDENTITY_CHANGED/);
  await assert.rejects(pageEval(fakeClient({ frameUrl: url.replace('1000', '1001') }), target.targetId, identity, () => true), /身份不匹配/);
  assert.equal(await pageEval(fakeClient(), target.targetId, identity, () => 42), 42);
});
test('status通过真实注入函数构造请求，返回数据不含会话', async () => {
  let request;
  const client = fakeClient({ fetch: async (path, init) => { request = { path, init }; return { ok: true, json: async () => ({ result: { learnedTimeCount: 60, learnedVideoCount: 2, lessonCount: 4, privateField: 'hidden' } }) }; } });
  const result = await status(client, target, identity);
  assert.equal(result.source, 'server-aggregate');
  assert.equal(result.learnedVideoCount, 2);
  assert.equal(request.init.body, 'termId=2000');
  assert.equal(request.init.redirect, 'error');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-test-session|privateField/);
});
test('status拒绝业务错误、缺失数据、非JSON、HTTP错误与负数', async () => {
  for (const response of [{ ok: false, status: 403 }, { ok: true, json: async () => { throw new Error(); } }, { ok: true, json: async () => ({ code: -1, result: {} }) }, { ok: true, json: async () => ({ result: {} }) }]) {
    await assert.rejects(status(fakeClient({ fetch: async () => response }), target, identity), /无法确认学习进度/);
  }
  for (const value of [null, {}, { learnedTimeCount: -1, learnedVideoCount: 1, lessonCount: 1 }, { learnedTimeCount: 0, learnedVideoCount: '1', lessonCount: 1 }]) assert.throws(() => validateProgress(value));
});
function discussionClient({ ids = [3000], response, fail = false } = {}) {
  const calls = [];
  const client = fakeClient({ evaluate: expression => {
    if (expression.includes('function readTopics')) return ids;
    if (expression.includes('async function postReply')) {
      calls.push(expression);
      if (fail) throw new Error('network after possible commit');
      if (response) return response;
      const batch = expression.match(/batchId=(\d+)/)[1];
      return { status: 200, text: `dwr.engine._remoteHandleCallback('${batch}','0',{id:4000});` };
    }
    throw new Error('Unexpected evaluation');
  } });
  return { client, calls };
}
test('讨论提交写入日志、绑定batch、只报告服务端ack，重复运行不重发', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ocb-submit-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plan = createPlan({ ...identity, gradingEvidence: '合成规则', replies: [{ pid: 3000, html: 'test' }] });
  const journal = join(dir, 'task.jsonl');
  const { client, calls } = discussionClient();
  const result = await submitDiscussions(client, target, identity, plan, journal);
  assert.equal(result.results[0].state, 'acknowledged');
  assert.equal(result.verified, false);
  assert.equal(calls.length, 1);
  const records = readFileSync(journal, 'utf8');
  assert.deepEqual(records.trim().split('\n').map(x => JSON.parse(x).state), ['started', 'intent', 'acknowledged']);
  assert.doesNotMatch(records, /cookie|SessionId|html/);
  await assert.rejects(submitDiscussions(client, target, identity, plan, journal), /日志已存在/);
  assert.equal(calls.length, 1);
});
test('主题不属于当前目录时无写入；网络异常停止整批且不自动重试', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ocb-stop-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plan = createPlan({ ...identity, gradingEvidence: '合成规则', replies: [{ pid: 3000, html: 'x' }, { pid: 3001, html: 'y' }] });
  const absent = discussionClient({ ids: [] });
  await assert.rejects(submitDiscussions(absent.client, target, identity, plan, join(dir, 'absent.jsonl')));
  assert.equal(absent.calls.length, 0);
  const network = discussionClient({ ids: [3000, 3001], fail: true });
  const result = await submitDiscussions(network.client, target, identity, plan, join(dir, 'network.jsonl'));
  assert.equal(result.exitCode, 3);
  assert.equal(result.results[0].state, 'uncertain');
  assert.deepEqual(result.remaining, [3001]); assert.equal(network.calls.length, 1);
});
test('视频默认扫描，没有执行播放或请求时长接口', async () => {
  const expressions = [];
  const client = fakeClient({ evaluate: expression => {
    expressions.push(expression);
    if (expression.includes('function expandOutline')) return true;
    if (expression.includes('function readOutline')) return { source: 'page-dom', total: 1, items: [{ cid: '3000', learned: false }] };
    throw new Error('unexpected mutation');
  } });
  const result = await runCommand(client, target, { cmd: 'videos', identity });
  assert.equal(result.executed, false);
  assert.equal(result.mode, 'scan');
  assert.equal(expressions.length, 2);
});
test('视频异步等待中同文档切换学期时停止，不执行seek/play', async () => {
  let href = url, played = 0, seeked = 0;
  const video = { duration: NaN, set currentTime(value) { seeked++; }, play() { played++; } };
  const node = { dataset: { cid: '3000' }, click() { href = url + '#/learn/content?cid=3000'; } };
  const client = fakeClient({ evaluate: expression => {
    if (expression.includes('function expandOutline')) return true;
    if (expression.includes('function readOutline')) return { source: 'page-dom', total: 1, items: [{ cid: '3000', learned: false }] };
    if (expression.includes('async function readProgress')) return { learnedTimeCount: 0, learnedVideoCount: 0, lessonCount: 1 };
    return vm.runInNewContext(expression, { URL, URLSearchParams, location: { get href() { return href; }, get hash() { return new URL(href).hash; } },
      document: { querySelectorAll: () => [node], querySelector: () => video },
      setTimeout(callback, ms) { return setTimeout(() => { href = href.replace('tid=2000', 'tid=2001'); callback(); }, Math.min(ms, 1)); }, clearTimeout,
    });
  } });
  const result = await runCommand(client, target, { cmd: 'videos', identity, execute: true, gradingEvidence: '合成规则' });
  assert.equal(played, 0); assert.equal(seeked, 0); assert.equal(result.exitCode, 3);
  assert.equal(result.results[0].reason, 'page-or-connection-error');
});
for (const denied of [false, true]) {
  test(`实验视频真实注入函数: ${denied ? '播放拒绝后清理' : 'seek/ended成功仍不夸大为服务端逐项验证'}`, async () => {
    let href = url, played = 0, paused = 0, seeked = 0;
    const timers = new Set();
    class Video extends EventTarget {
      duration = 20;
      set currentTime(value) { assert.equal(value, 18); seeked++; queueMicrotask(() => this.dispatchEvent(new Event('seeked'))); }
      async play() { played++; if (denied) throw new Error('Autoplay rejected'); queueMicrotask(() => this.dispatchEvent(new Event('ended'))); }
      pause() { paused++; }
    }
    const video = new Video();
    const node = { dataset: { cid: '3000' }, click() { href = url + '#/learn/content?cid=3000'; } };
    const client = fakeClient({ evaluate: expression => {
      if (expression.includes('function expandOutline')) return true;
      if (expression.includes('function readOutline')) return { source: 'page-dom', total: 1, items: [{ cid: '3000', learned: played > 0 && !denied }] };
      if (expression.includes('async function readProgress')) return { learnedTimeCount: 2, learnedVideoCount: played > 0 && !denied ? 1 : 0, lessonCount: 1 };
      return vm.runInNewContext(expression, { URL, URLSearchParams, location: { get href() { return href; }, get hash() { return new URL(href).hash; } },
        document: { querySelectorAll: () => [node], querySelector: () => video },
        setTimeout(callback, ms) { const id = setTimeout(() => { timers.delete(id); callback(); }, ms); timers.add(id); return id; },
        clearTimeout(id) { timers.delete(id); clearTimeout(id); },
      });
    } });
    const result = await runCommand(client, target, { cmd: 'videos', identity, execute: true, gradingEvidence: '合成规则' });
    assert.equal(played, 1); assert.equal(seeked, 1); assert.equal(paused, 1); assert.equal(timers.size, 0);
    assert.equal(result.results[0].played, !denied);
    assert.equal(result.exitCode, 3); assert.equal(result.verified, false);
    assert.equal(result.outlineAfter.source, 'page-dom');
    assert.equal(result.progressAfter.source, 'server-aggregate');
  });
}
