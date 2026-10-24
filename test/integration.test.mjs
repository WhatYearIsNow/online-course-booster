import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../scripts/cdp.mjs';
import { main } from '../scripts/icourse163.mjs';

// Complete CLI -> CDP -> page-JavaScript -> fake HTTP -> DWR path, with no sockets or accounts.
function site({ cookie = 'NTESSTUDYSI=synthetic-session', failPost = false, oversizedDwr = false, examAction, examDisabled = false, examText, gradingDelay = false, gradingText = 'Grading Criteria\n合成评分内容：测试占比100%。' } = {}) {
  let gradingReads = 0;
  let current = 'https://www.icourse163.org/learn/DEMO-1000?tid=2000';
  let posts = 0, socketsClosed = 0;
  const location = { get href() { return current; }, get hash() { return new URL(current).hash; }, get origin() { return new URL(current).origin; }, get pathname() { return new URL(current).pathname; }, get search() { return new URL(current).search; } };
  const anchor = { getAttribute: () => '#/learn/forumdetail?pid=3000' };
  const action = { innerText: examAction ?? '', offsetParent: {}, disabled: examDisabled, getAttribute: () => null, className: '' };
  const examItem = { innerText: '期末考试\n' + (examAction ?? ''), querySelectorAll: () => [action] };
  const document = {
    cookie, readyState: 'complete', body: { innerText: examText ?? '合成成绩规则：讨论按课程要求人工核对。' },
    querySelector: selector => selector === '.learnPageContent' ? { innerText: gradingDelay && gradingReads++ === 0 ? 'Grading Criteria' : gradingText } : anchor,
    querySelectorAll: selector => selector.includes('forumdetail') ? [anchor] : selector === '.j-examItem, .u-quizItem' && examAction ? [examItem] : [],
  };
  const context = vm.createContext({ URL, URLSearchParams, AbortSignal, location, document, window: { dwr: { engine: { _scriptSessionId: 'synthetic/script$&' } } }, fetch: async (path, init) => {
    if (path.startsWith('/mm-course/')) return { ok: true, json: async () => ({ code: 0, result: { learnedTimeCount: 100, learnedVideoCount: 1, lessonCount: 3 } }) };
    assert.equal(path, '/dwr/call/plaincall/MocForumBean.addReply.dwr'); posts++;
    assert.match(init.body, /scriptSessionId=synthetic\/script\$&\n/);
    assert.match(init.body, /httpSessionId=synthetic-session\n/);
    assert.doesNotMatch(init.body, /__OCB_.*SESSION__/);
    if (failPost) throw new Error('Response lost after server may have accepted request');
    const batchId = init.body.match(/^batchId=(\d+)$/m)[1];
    return { status: 200, text: async () => `dwr.engine._remoteHandleCallback('${batchId}','0',{id:4000});` + (oversizedDwr ? ' '.repeat(1_000_000) + "throw 'late exception';" : '') };
  } });
  class FakeWebSocket extends EventTarget {
    readyState = 0;
    constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    send(raw) {
      const request = JSON.parse(raw);
      queueMicrotask(async () => {
        let result;
        if (request.method === 'Target.getTargets') result = { targetInfos: [{ type: 'page', targetId: 'one', url: current }] };
        else if (request.method === 'Target.attachToTarget') result = { sessionId: 'session' };
        else if (request.method === 'Page.getFrameTree') result = { frameTree: { frame: { url: current } } };
        else if (request.method === 'Page.navigate') { current = request.params.url; result = { frameId: 'frame' }; }
        else if (request.method === 'Runtime.evaluate') {
          try { result = { result: { value: await vm.runInContext(request.params.expression, context) } }; }
          catch { result = { exceptionDetails: { text: 'Simulated page error' } }; }
        } else throw new Error('Unexpected CDP method: ' + request.method);
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: request.id, ...(request.sessionId ? { sessionId: request.sessionId } : {}), result }) }));
      });
    }
    close() { if (this.readyState !== 3) { this.readyState = 3; socketsClosed++; this.dispatchEvent(new Event('close')); } }
  }
  return { connect: (dir, opts) => connect(dir, { ...opts, env: { CDP_ENDPOINT: 'ws://127.0.0.1:9222/synthetic' }, WebSocketClass: FakeWebSocket }), get posts() { return posts; }, get socketsClosed() { return socketsClosed; } };
}
const ids = ['--course', '1000', '--term', '2000'];
test('完整只读链路 status CLI -> 传输 -> 页面 fetch，结果及退出码正确且关闭连接', async () => {
  const browser = site(); let output;
  const code = await main(['status', ...ids], { connect: browser.connect, output: value => output = value, errorOutput: assert.fail });
  assert.equal(code, 0); assert.equal(output.progress.learnedVideoCount, 1);
  assert.equal(browser.posts, 0); assert.equal(browser.socketsClosed, 1);
  assert.doesNotMatch(JSON.stringify(output), /synthetic-session/);
});
for (const [scenario, config, state, code] of [['confirmed response', {}, 'acknowledged', 0], ['response loss', { failPost: true }, 'uncertain', 3], ['missing session', { cookie: '' }, 'not-sent', 3], ['oversized response is never truncated into success', { oversizedDwr: true }, 'uncertain', 3]]) {
  test(`完整预览/提交/日志链路: ${scenario}`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'ocb-integration-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'replies.json'), rules = join(dir, 'grading.txt'), planFile = join(dir, 'plan.json'), journal = join(dir, 'task.jsonl');
    writeFileSync(file, JSON.stringify([{ pid: 3000, html: '<p>合成内容。</p>' }])); writeFileSync(rules, '合成规则。');
    const browser = site(config); let plan, output;
    assert.equal(await main(['discuss', ...ids, '--file', file, '--rules', rules, '--plan', planFile], { connect: assert.fail, output: value => plan = value, errorOutput: assert.fail }), 0);
    const argv = ['discuss', ...ids, '--submit', '--plan', planFile, '--confirm', plan.digest, '--journal', journal];
    assert.equal(await main(argv, { connect: browser.connect, output: value => output = value, errorOutput: assert.fail }), code);
    assert.equal(output.results[0].state, state); assert.equal(output.verified, false);
    assert.equal(browser.posts, config.cookie === '' ? 0 : 1);
    assert.equal(await main(argv, { connect: browser.connect, output: assert.fail, errorOutput() {} }), 1);
    assert.equal(browser.posts, config.cookie === '' ? 0 : 1);
    assert.doesNotMatch(readFileSync(journal, 'utf8'), /synthetic-session|scriptSessionId|httpSessionId/);
  });
}
test('grading读取页面证据，exam只认明确可用动作', async () => {
  let result;
  const deps = browser => ({ connect: browser.connect, output: value => result = value, errorOutput: assert.fail });
  assert.equal(await main(['grading', ...ids], deps(site())), 0);
  assert.match(result.text, /合成评分内容/); assert.equal(result.source, 'page-dom');
  for (const [config, state, code] of [[{ examAction: '开始考试' }, 'OPEN', 0], [{ examAction: '开始考试', examDisabled: true }, 'UNKNOWN', 3], [{ examAction: '尚不可进入考试' }, 'UNKNOWN', 3], [{ examText: '尚未开放' }, 'NOT_OPEN', 0]]) {
    assert.equal(await main(['exam', ...ids], deps(site(config))), code);
    assert.equal(result.state, state);
  }
});
test('grading仅有导航标题时不会报成功，未发布规则返回partial', async () => {
  let result;
  const browser = site({ gradingText: 'Grading Criteria\n老师还没有发布评分标准，请耐心等待' });
  assert.equal(await main(['grading', ...ids], { connect: browser.connect, output: value => result = value, errorOutput: assert.fail }), 3);
  assert.equal(result.state, 'NOT_PUBLISHED');
});
test('grading等待异步正文，不将标题作为评分内容', async () => {
  let result;
  const browser = site({ gradingDelay: true });
  assert.equal(await main(['grading', ...ids], { connect: browser.connect, output: value => result = value, errorOutput: assert.fail }), 0);
  assert.match(result.text, /合成评分内容/);
});
