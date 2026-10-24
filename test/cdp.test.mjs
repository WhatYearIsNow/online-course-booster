import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { connect, sleep, FATAL_RE } from '../scripts/cdp.mjs';
import { validateEndpoint, readDevToolsEndpoint, resolveConnectionConfig } from '../scripts/lib/connection-config.mjs';

// EventTarget wire simulator: these tests never create a network socket.
function transport(handler, { autoOpen = true } = {}) {
  return class FakeWebSocket extends EventTarget {
    static instances = [];
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.constructor.instances.push(this);
      if (autoOpen) queueMicrotask(() => {
        if (this.readyState === 0) { this.readyState = 1; this.dispatchEvent(new Event('open')); }
      });
    }
    send(raw) {
      const message = JSON.parse(raw);
      this.sent.push(message);
      if (handler) handler(this, message);
      else if (message.method === 'Target.getTargets') this.reply(message, { targetInfos: [] });
    }
    message(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
    reply(request, result = {}, error) {
      queueMicrotask(() => this.message({
        id: request.id, ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        ...(error ? { error } : { result }),
      }));
    }
    event(method, params = {}) { this.message({ method, params }); }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
  };
}

function probeAnd(handler) {
  return (ws, request) => {
    if (request.method === 'Target.getTargets') ws.reply(request, { targetInfos: [] });
    else handler?.(ws, request);
  };
}

async function client(t, handler, options = {}) {
  const cdp = await connect(undefined, {
    endpoint: 'ws://127.0.0.1:9222/devtools/browser/test', env: {},
    WebSocketClass: transport(probeAnd(handler)), requestTimeoutMs: 100,
    ...options,
  });
  t.after(() => cdp.close());
  return cdp;
}

test('endpoint policy accepts loopback and rejects remote/authenticated/non-WS/query URLs', () => {
  for (const value of ['ws://127.0.0.1:9222/', 'ws://localhost:9333/', 'ws://[::1]:9222/devtools/browser/x']) {
    assert.equal(new URL(validateEndpoint(value)).protocol, 'ws:');
  }
  for (const value of [
    'wss://localhost:9222/', 'http://localhost:9222/', 'ws://example.org/',
    'ws://localhost.example.org/', 'ws://0.0.0.0:9222/', 'ws://192.168.1.1/',
    'ws://user:secret@localhost:9222/', 'ws://localhost:9222/?token=secret',
    'ws://localhost:9222/?', 'ws://localhost:9222/#', ' ws://localhost/',
    'ws://localhost/\n', 'ws://localhost\\@example.org/', 'ws:localhost:9222', 'ws://localhost:0', '', null,
  ]) assert.throws(() => validateEndpoint(value), undefined, String(value));
});

test('DevToolsActivePort parser validates both lines and cannot redirect to a remote endpoint', () => {
  assert.equal(readDevToolsEndpoint('chosen', () => '9222\r\n/devtools/browser/a-b_1\r\n'), 'ws://127.0.0.1:9222/devtools/browser/a-b_1');
  for (const contents of ['0\n/devtools/browser/x', '65536\n/devtools/browser/x', '1.5\n/devtools/browser/x',
    '9222\n//example.org/', '9222\n/devtools/browser/x?secret', '9222\n/devtools/browser/x\nextra', '9222']) {
    assert.throws(() => readDevToolsEndpoint('chosen', () => contents));
  }
});

test('configuration precedence is explicit and no personal browser path is assumed', () => {
  const env = { CDP_ENDPOINT: 'ws://localhost:1', CDP_RELAY_URL: 'ws://localhost:2', CHROME_USER_DATA_DIR: 'env-dir' };
  const noRead = () => { throw new Error('must not read profile'); };
  assert.equal(resolveConnectionConfig('arg-dir', { env, endpoint: 'ws://localhost:3', readFile: noRead }).endpoint, 'ws://localhost:3/');
  assert.equal(resolveConnectionConfig(undefined, { env, readFile: noRead }).source, 'CDP_ENDPOINT');
  assert.equal(resolveConnectionConfig(undefined, { env: { CDP_RELAY_URL: env.CDP_RELAY_URL }, readFile: noRead }).source, 'CDP_RELAY_URL');
  const seen = [];
  const config = resolveConnectionConfig('positional', {
    env, userDataDir: 'option-dir',
    readFile(path) { seen.push(path); return '9222\n/devtools/browser/x'; },
  });
  assert.match(seen[0], /option-dir/);
  assert.equal(config.source, 'DevToolsActivePort');
  assert.equal(config.expectProfile, null);
  assert.throws(() => resolveConnectionConfig(undefined, { env: {} }), /Specify/);
  assert.throws(() => resolveConnectionConfig(undefined, { env: { CDP_ENDPOINT: '' } }), /endpoint/);
});

test('connect probes protocol and rejects error or malformed probe responses', async () => {
  for (const failure of ['error', 'malformed']) {
    const Fake = transport((ws, request) => ws.reply(request, {}, failure === 'error' ? { message: 'unsupported method' } : undefined));
    await assert.rejects(connect(undefined, { endpoint: 'ws://localhost:9222/', env: {}, WebSocketClass: Fake }), /unsupported method|Invalid CDP/);
    const ws = Fake.instances[0];
    assert.equal(ws.readyState, 3);
    for (const event of ['open', 'close', 'error', 'message']) assert.equal(getEventListeners(ws, event).length, 0);
  }
});

test('handshake timeout, error, and abort close the socket and remove listeners', async () => {
  const Fake = transport(null, { autoOpen: false });
  await assert.rejects(connect(undefined, { endpoint: 'ws://localhost:9222/', env: {}, WebSocketClass: Fake, connectTimeoutMs: 15 }), /connect timeout/);
  assert.equal(Fake.instances[0].readyState, 3);
  for (const event of ['open', 'close', 'error']) assert.equal(getEventListeners(Fake.instances[0], event).length, 0);
  const control = new AbortController();
  const pending = connect(undefined, { endpoint: 'ws://localhost:9222/', env: {}, WebSocketClass: Fake, signal: control.signal });
  control.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(getEventListeners(control.signal, 'abort').length, 0);
  const failed = connect(undefined, { endpoint: 'ws://localhost:9222/', env: {}, WebSocketClass: Fake });
  Fake.instances.at(-1).dispatchEvent(new Event('error'));
  await assert.rejects(failed, /handshake failed/);
});

test('pre-aborted connect creates no socket', async () => {
  const Fake = transport();
  const control = new AbortController();
  control.abort();
  await assert.rejects(connect(undefined, {
    endpoint: 'ws://localhost:9222/', env: {}, WebSocketClass: Fake, signal: control.signal,
  }), { name: 'AbortError' });
  assert.equal(Fake.instances.length, 0);
});

test('call timeout and abort clean listeners; malformed/late messages do not corrupt the connection', async (t) => {
  const cdp = await client(t);
  const control = new AbortController();
  const pending = cdp.call('Never.responds', {}, null, { signal: control.signal, timeoutMs: 15 });
  await assert.rejects(pending, /CDP timeout/);
  assert.equal(getEventListeners(control.signal, 'abort').length, 0);
  cdp.ws.dispatchEvent(new MessageEvent('message', { data: '{broken' }));
  cdp.ws.message(null);
  cdp.ws.reply(cdp.ws.sent.at(-1), { stale: true });
  const cancelled = cdp.call('Never.responds', {}, null, { signal: control.signal });
  control.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(getEventListeners(control.signal, 'abort').length, 0);
  assert.deepEqual(await cdp.targets(), []);
});

test('close and socket error reject outstanding requests immediately', async (t) => {
  for (const mode of ['close', 'error']) {
    const cdp = await client(t);
    const pending = cdp.call('Never.responds');
    cdp.ws.dispatchEvent(new Event(mode));
    await assert.rejects(pending, /CDP connection closed/);
    await assert.rejects(cdp.call('Anything'), /not connected/);
    for (const event of ['close', 'error', 'message']) assert.equal(getEventListeners(cdp.ws, event).length, 0);
  }
});

test('connection AbortSignal rejects pending calls and is removed after close', async (t) => {
  const control = new AbortController();
  const cdp = await client(t, undefined, { signal: control.signal });
  const pending = cdp.call('Never.responds');
  control.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cdp.ws.readyState, 3);
  assert.equal(getEventListeners(control.signal, 'abort').length, 0);
});

test('concurrent attach calls share one request and use sessionId on page methods', async (t) => {
  const cdp = await client(t, (ws, request) => {
    if (request.method === 'Target.attachToTarget') ws.reply(request, { sessionId: 's1' });
    if (request.method === 'Runtime.evaluate') ws.reply(request, { result: { value: 42 } });
  });
  const values = await Promise.all([cdp.evaluate('target', '1'), cdp.evaluate('target', '2')]);
  assert.deepEqual(values, [42, 42]);
  assert.equal(cdp.ws.sent.filter((request) => request.method === 'Target.attachToTarget').length, 1);
  for (const request of cdp.ws.sent.filter((request) => request.method === 'Runtime.evaluate')) assert.equal(request.sessionId, 's1');
});

test('response with another sessionId cannot satisfy a pending page request', async (t) => {
  let evaluation;
  const cdp = await client(t, (ws, request) => {
    if (request.method === 'Target.attachToTarget') ws.reply(request, { sessionId: 's1' });
    if (request.method === 'Runtime.evaluate') { evaluation = request; ws.message({ id: request.id, sessionId: 's-other', result: { result: { value: 'wrong' } } }); }
  });
  const pending = cdp.evaluate('target', '1');
  await sleep(1);
  cdp.ws.reply(evaluation, { result: { value: 'correct' } });
  assert.equal(await pending, 'correct');
});

test('detach arriving before attach response rejects stale session and permits a new attach', async (t) => {
  let attaches = 0;
  const cdp = await client(t, (ws, request) => {
    if (request.method === 'Target.attachToTarget') {
      if (++attaches === 1) ws.event('Target.detachedFromTarget', { sessionId: 'old' });
      ws.reply(request, { sessionId: attaches === 1 ? 'old' : 'new' });
    }
  });
  await assert.rejects(cdp.session('target'), /detached during attach/);
  assert.equal(await cdp.session('target'), 'new');
});

test('detach invalidates cache and rejects outstanding calls in that session', async (t) => {
  let attaches = 0;
  const cdp = await client(t, (ws, request) => {
    if (request.method === 'Target.attachToTarget') ws.reply(request, { sessionId: `s${++attaches}` });
  });
  const sid = await cdp.session('target');
  const pending = cdp.call('Runtime.evaluate', {}, sid);
  cdp.ws.event('Target.detachedFromTarget', { sessionId: sid });
  await assert.rejects(pending, /session detached/);
  assert.equal(await cdp.session('target'), 's2');
});

test('targetDestroyed during attach prevents stale response from becoming cached', async (t) => {
  const cdp = await client(t, (ws, request) => {
    if (request.method === 'Target.attachToTarget') {
      ws.event('Target.targetDestroyed', { targetId: 'target' });
      ws.reply(request, { sessionId: 'destroyed-session' });
    }
  });
  await assert.rejects(cdp.session('target'), /detached during attach/);
});

test('attach event followed by detach rejects concurrent waiters without waiting for attach response', async (t) => {
  const cdp = await client(t, (ws, request) => {
    if (request.method === 'Target.attachToTarget') {
      queueMicrotask(() => {
        ws.event('Target.attachedToTarget', { sessionId: 'soon-gone', targetInfo: { targetId: 'target' } });
        ws.event('Target.detachedFromTarget', { sessionId: 'soon-gone' });
      });
    }
  });
  await assert.rejects(cdp.session('target'), /detached during attach/);
});

test('cancelled attach cannot repopulate session cache from a late attached event', async (t) => {
  let requests = [];
  const cdp = await client(t, (ws, request) => { requests.push(request); });
  const control = new AbortController();
  const first = cdp.session('target', { signal: control.signal });
  control.abort();
  await assert.rejects(first, { name: 'AbortError' });
  cdp.ws.event('Target.attachedToTarget', { sessionId: 'stale', targetInfo: { targetId: 'target' } });
  const second = cdp.session('target');
  cdp.ws.reply(requests.at(-1), { sessionId: 'current' });
  assert.equal(await second, 'current');
  assert.equal(requests.length, 2);
});

test('one cancelled attach waiter does not cancel other concurrent waiters', async (t) => {
  let attachRequest;
  const cdp = await client(t, (ws, request) => { attachRequest = request; });
  const control = new AbortController();
  const first = cdp.session('target', { signal: control.signal });
  const second = cdp.session('target');
  control.abort();
  await assert.rejects(first, { name: 'AbortError' });
  cdp.ws.reply(attachRequest, { sessionId: 'shared' });
  assert.equal(await second, 'shared');
});

test('getFrameTree returns raw CDP data; live URL check rejects a redirected host', async (t) => {
  let url = 'https://www.icourse163.org/learn/DEMO-1001?tid=2001';
  const cdp = await client(t, (ws, request) => {
    if (request.method === 'Target.attachToTarget') ws.reply(request, { sessionId: 's' });
    if (request.method === 'Page.getFrameTree') ws.reply(request, { frameTree: { frame: { url } } });
  });
  assert.equal((await cdp.getFrameTree('target')).frameTree.frame.url, url);
  assert.equal((await cdp.assertTargetUrl('target', ['www.icourse163.org'])).hostname, 'www.icourse163.org');
  url = 'https://www.icourse163.org.example.org/';
  await assert.rejects(cdp.assertTargetUrl('target', ['www.icourse163.org']), /does not match/);
});

test('waitFor bounds a hanging attach and hanging evaluation to the overall deadline', async (t) => {
  for (const attachWorks of [false, true]) {
    const cdp = await client(t, (ws, request) => {
      if (attachWorks && request.method === 'Target.attachToTarget') ws.reply(request, { sessionId: 's' });
    });
    const started = performance.now();
    assert.equal(await cdp.waitFor('target', 'condition', { timeoutMs: 30, intervalMs: 5 }), false);
    assert.ok(performance.now() - started < 500);
  }
});

test('waitFor returns true, bounds recurring errors and immediately propagates fatal errors', async (t) => {
  let mode = 'ready';
  const cdp = await client(t, (ws, request) => {
    if (request.method === 'Target.attachToTarget') ws.reply(request, { sessionId: 's' });
    if (request.method === 'Runtime.evaluate') {
      if (mode === 'ready') ws.reply(request, { result: { value: true } });
      else ws.reply(request, {}, { message: mode === 'fatal' ? 'Target closed' : 'Page is busy' });
    }
  });
  assert.equal(await cdp.waitFor('target', 'condition'), true);
  mode = 'retry';
  await assert.rejects(cdp.waitFor('target', 'condition', { intervalMs: 1, maxConsecutiveErrors: 2 }), /2 consecutive/);
  mode = 'fatal';
  await assert.rejects(cdp.waitFor('target', 'condition'), /Target closed/);
  assert.equal(FATAL_RE.test('CDP connection closed'), true);
});

test('waitFor aborts during attach and polling sleep without leaving signal listeners', async (t) => {
  for (const mode of ['attach', 'sleep']) {
    const control = new AbortController();
    const cdp = await client(t, (ws, request) => {
      if (mode === 'sleep' && request.method === 'Target.attachToTarget') ws.reply(request, { sessionId: 's' });
      if (request.method === 'Runtime.evaluate') ws.reply(request, { result: { value: false } });
    });
    const pending = cdp.waitFor('target', 'condition', { signal: control.signal, intervalMs: 5000 });
    await sleep(5);
    control.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(getEventListeners(control.signal, 'abort').length, 0);
  }
});

test('profile requirement remains unverified and is never inferred from endpoint configuration', async (t) => {
  const cdp = await client(t, undefined, { expectProfile: 'Example Profile' });
  assert.equal(cdp.connectionInfo.profile.status, 'unverified');
  assert.equal(cdp.connectionInfo.profile.expected, 'Example Profile');
  assert.equal(cdp.connectionInfo.localOnly, true);
});

test('closing or aborting work leaves no transport-owned request or attach timers', async (t) => {
  const active = new Set();
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    const handle = nativeSetTimeout(() => { active.delete(handle); callback(...args); }, delay);
    active.add(handle);
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', (handle) => { active.delete(handle); nativeClearTimeout(handle); });
  const cdp = await client(t);
  const attach = cdp.session('target');
  const request = cdp.call('Never.responds');
  cdp.close();
  await assert.rejects(attach, /connection closed/);
  await assert.rejects(request, /connection closed/);
  assert.equal(active.size, 0);
  const second = await client(t);
  const control = new AbortController();
  const cancelled = second.waitFor('target', 'condition', { signal: control.signal });
  control.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  await Promise.resolve();
  assert.equal(active.size, 0);
});
