/** Local-only, dependency-free CDP transport. Requires Node.js >= 22.15. */
import { writeFileSync } from 'node:fs';
import { resolveConnectionConfig } from './lib/connection-config.mjs';

export const FATAL_RE = /CDP (?:connection closed|not connected|session detached)|CDP 连接已关闭|CDP 未连接|Session with given id not found|No target with given id|Target closed|Target detached during attach|Cannot find context|Inspected target navigated or closed|WebSocket is not open/i;

function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new RangeError(`${name} must be a positive finite number <= 2147483647`);
  }
  return value;
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('The operation was aborted', 'AbortError');
}

function bounded(promise, { timeoutMs, signal, message = 'CDP timeout' }) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => { cleanup(); reject(abortError(signal)); };
    timer = setTimeout(() => { cleanup(); reject(new Error(message)); }, positive(timeoutMs, 'timeoutMs'));
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

export function sleep(ms, { signal } = {}) {
  if (!Number.isFinite(ms) || ms < 0 || ms > 2_147_483_647) throw new RangeError('Invalid sleep duration');
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(abortError(signal)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function openSocket(endpoint, WebSocketClass, timeoutMs, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    let ws;
    let timer;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      ws?.removeEventListener('open', onOpen);
      ws?.removeEventListener('close', onClose);
      ws?.removeEventListener('error', onError);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) { try { ws?.close(); } catch {} reject(error); }
      else resolve(ws);
    };
    const onOpen = () => finish();
    const onClose = () => finish(new Error('CDP connection closed during handshake'));
    const onError = () => finish(new Error('CDP WebSocket handshake failed'));
    const onAbort = () => finish(abortError(signal));
    try { ws = new WebSocketClass(endpoint); } catch { return finish(new Error('Cannot create CDP WebSocket')); }
    ws.addEventListener('open', onOpen);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(new Error('CDP connect timeout')), timeoutMs);
    if (signal?.aborted) return onAbort();
    if (ws.readyState === 1) finish();
  });
}

/**
 * connect(profileDir?, opts): explicit endpoint > explicit userDataDir/profileDir >
 * CDP_ENDPOINT > CDP_RELAY_URL > CHROME_USER_DATA_DIR/DevToolsActivePort.
 * No browser/relay process is started and no browser profile is inferred.
 * opts.WebSocketClass provides an offline test seam; opts.env isolates configuration.
 */
export async function connect(profileDir, opts = {}) {
  const config = resolveConnectionConfig(profileDir, opts);
  const connectTimeoutMs = positive(opts.connectTimeoutMs ?? 8000, 'connectTimeoutMs');
  const requestTimeoutMs = positive(opts.requestTimeoutMs ?? 30000, 'requestTimeoutMs');
  const WebSocketClass = opts.WebSocketClass ?? globalThis.WebSocket;
  if (typeof WebSocketClass !== 'function') throw new Error('Node.js >= 22.15 with WebSocket is required');
  const ws = await openSocket(config.endpoint, WebSocketClass, connectTimeoutMs, opts.signal);
  let id = 0;
  let closed = false;
  const pending = new Map();
  const sessions = new Map();
  const attachPromises = new Map();
  const announcedSessions = new Map();
  const generations = new Map();
  const detachedSessions = new Set();

  function settlePending(mid, error, result) {
    const item = pending.get(mid);
    if (!item) return;
    pending.delete(mid);
    clearTimeout(item.timer);
    item.signal?.removeEventListener('abort', item.onAbort);
    if (error) item.reject(error); else item.resolve(result);
  }

  function shutdown(error = new Error('CDP connection closed')) {
    if (closed) return;
    closed = true;
    for (const mid of pending.keys()) settlePending(mid, error);
    sessions.clear();
    attachPromises.clear();
    announcedSessions.clear();
    generations.clear();
    detachedSessions.clear();
    ws.removeEventListener('message', onMessage);
    ws.removeEventListener('close', onClose);
    ws.removeEventListener('error', onError);
    opts.signal?.removeEventListener('abort', onAbort);
    try { ws.close(); } catch {}
  }

  function invalidateTarget(targetId, sid) {
    if (targetId) {
      sid ??= sessions.get(targetId);
      sessions.delete(targetId);
      generations.set(targetId, (generations.get(targetId) ?? 0) + 1);
      const attaching = attachPromises.get(targetId);
      if (attaching && !attaching.settled) attaching.controller.abort(new Error('Target detached during attach'));
    }
    if (sid && attachPromises.size) detachedSessions.add(sid);
    if (sid) announcedSessions.delete(sid);
    if (sid) {
      for (const [mid, item] of pending) {
        if (item.sessionId === sid) settlePending(mid, new Error('CDP session detached'));
      }
    }
  }

  function onMessage(event) {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (message.method === 'Target.attachedToTarget') {
      const { targetInfo, sessionId } = message.params ?? {};
      if (targetInfo?.targetId && sessionId && attachPromises.has(targetInfo.targetId)) announcedSessions.set(sessionId, targetInfo.targetId);
    } else if (message.method === 'Target.detachedFromTarget') {
      const { sessionId, targetId } = message.params ?? {};
      const target = targetId ?? [...sessions].find(([, sid]) => sid === sessionId)?.[0] ?? announcedSessions.get(sessionId);
      invalidateTarget(target, sessionId);
    } else if (message.method === 'Target.targetDestroyed') {
      invalidateTarget(message.params?.targetId);
    } else if (message.method === 'Page.javascriptDialogOpening' && opts.autoAcceptDialogs === true) {
      call('Page.handleJavaScriptDialog', { accept: true }, message.sessionId).catch(() => {});
    }
    if (Number.isInteger(message.id)) {
      const expectedSession = pending.get(message.id)?.sessionId ?? null;
      if ((message.sessionId ?? null) !== expectedSession) return;
      settlePending(message.id, message.error ? new Error(message.error.message ?? 'CDP protocol error') : null, message.result);
    }
  }
  const onClose = () => shutdown();
  const onError = () => shutdown(new Error('CDP connection closed after WebSocket error'));
  const onAbort = () => shutdown(abortError(opts.signal));
  ws.addEventListener('message', onMessage);
  ws.addEventListener('close', onClose);
  ws.addEventListener('error', onError);
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  /** Fourth argument may be the legacy timeout number or {timeoutMs, signal}. */
  function call(method, params = {}, sessionId = null, options = {}) {
    if (closed || ws.readyState !== 1) return Promise.reject(new Error('CDP not connected'));
    if (typeof options === 'number') options = { timeoutMs: options };
    const { timeoutMs = requestTimeoutMs, signal } = options;
    try { positive(timeoutMs, 'timeoutMs'); } catch (error) { return Promise.reject(error); }
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
      const mid = ++id;
      const onAbort = () => settlePending(mid, abortError(signal));
      const timer = setTimeout(() => settlePending(mid, new Error(`CDP timeout: ${method}`)), timeoutMs);
      pending.set(mid, { resolve, reject, timer, signal, onAbort, sessionId });
      signal?.addEventListener('abort', onAbort, { once: true });
      try { ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch (error) { settlePending(mid, error); }
    });
  }

  /** Concurrent attaches share a request; detached responses never enter the cache. */
  function session(targetId, options = {}) {
    if (closed) return Promise.reject(new Error('CDP not connected'));
    if (options.signal?.aborted) return Promise.reject(abortError(options.signal));
    if (sessions.has(targetId)) return Promise.resolve(sessions.get(targetId));
    if (!attachPromises.has(targetId)) {
      const generation = (generations.get(targetId) ?? 0) + 1;
      generations.set(targetId, generation);
      const controller = new AbortController();
      const entry = { promise: null, controller, waiters: 0, settled: false };
      attachPromises.set(targetId, entry);
      const promise = call('Target.attachToTarget', { targetId, flatten: true }, null, { signal: controller.signal })
        .then((result) => {
          if (!result?.sessionId) throw new Error('CDP attach response missing sessionId');
          if (closed || generations.get(targetId) !== generation || detachedSessions.has(result.sessionId)) {
            throw new Error('Target detached during attach');
          }
          announcedSessions.delete(result.sessionId);
          sessions.set(targetId, result.sessionId);
          return result.sessionId;
        }).finally(() => {
          entry.settled = true;
          if (attachPromises.get(targetId) === entry) attachPromises.delete(targetId);
          if (!attachPromises.size) detachedSessions.clear();
          for (const [sid, target] of announcedSessions) if (target === targetId) announcedSessions.delete(sid);
        });
      entry.promise = promise;
    }
    const entry = attachPromises.get(targetId);
    entry.waiters++;
    return bounded(entry.promise, {
      timeoutMs: options.timeoutMs ?? requestTimeoutMs, signal: options.signal, message: 'CDP timeout: attach',
    }).finally(() => {
      entry.waiters--;
      if (!entry.waiters && !entry.settled) {
        if (attachPromises.get(targetId) === entry) attachPromises.delete(targetId);
        generations.set(targetId, (generations.get(targetId) ?? 0) + 1);
        entry.controller.abort();
      }
    });
  }

  async function evaluate(targetId, expression, options = {}) {
    if (typeof options === 'number') options = { timeoutMs: options };
    const sid = await session(targetId, options);
    const result = await call('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    }, sid, options);
    if (result?.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Page evaluation failed');
    }
    return result?.result?.value;
  }

  async function targets(options = {}) {
    const result = await call('Target.getTargets', {}, null, options);
    if (!Array.isArray(result?.targetInfos)) throw new Error('Invalid CDP target response');
    return result.targetInfos.filter((target) => target.type === 'page');
  }

  async function getFrameTree(targetId, options = {}) {
    return call('Page.getFrameTree', {}, await session(targetId, options), options);
  }

  /** Validate the live main-frame URL before reading or changing a chosen page. */
  async function assertTargetUrl(targetId, allowedHostnames, options = {}) {
    if (!Array.isArray(allowedHostnames) || !allowedHostnames.length) throw new Error('Specify allowed hostnames');
    const result = await getFrameTree(targetId, options);
    let url;
    try { url = new URL(result?.frameTree?.frame?.url); } catch { throw new Error('Cannot verify target main-frame URL'); }
    if (!['https:', 'http:'].includes(url.protocol) || !allowedHostnames.includes(url.hostname)
        || url.username || url.password) {
      throw new Error('Target main-frame URL does not match the allowed platform');
    }
    return url;
  }

  async function navigate(targetId, url, options = {}) {
    return call('Page.navigate', { url }, await session(targetId, options), options);
  }
  async function screenshot(targetId, outPath, options = {}) {
    const result = await call('Page.captureScreenshot', { format: 'png' }, await session(targetId, options), options);
    writeFileSync(outPath, Buffer.from(result.data, 'base64'));
    return outPath;
  }
  async function createTarget(url = 'about:blank', options = {}) {
    return (await call('Target.createTarget', { url, newWindow: false }, null, options)).targetId;
  }

  /** Strict overall deadline, including attach/evaluate and the final polling delay. */
  async function waitFor(targetId, expression, {
    timeoutMs = 20000, intervalMs = 400, maxConsecutiveErrors = 10, signal = opts.signal,
  } = {}) {
    positive(timeoutMs, 'timeoutMs');
    positive(intervalMs, 'intervalMs');
    if (!Number.isInteger(maxConsecutiveErrors) || maxConsecutiveErrors < 1) throw new RangeError('Invalid maxConsecutiveErrors');
    const deadline = performance.now() + timeoutMs;
    let consecutiveErrors = 0;
    while (performance.now() < deadline) {
      if (signal?.aborted) throw abortError(signal);
      const remaining = deadline - performance.now();
      if (remaining <= 0) return false;
      const controller = new AbortController();
      const iterationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      try {
        const value = await bounded(evaluate(targetId, expression, { timeoutMs: remaining, signal: iterationSignal }), {
          timeoutMs: remaining, signal: iterationSignal, message: 'CDP waitFor deadline',
        });
        if (value) return true;
        consecutiveErrors = 0;
      } catch (error) {
        if (signal?.aborted) throw abortError(signal);
        if (FATAL_RE.test(error.message)) throw error;
        if (performance.now() >= deadline) return false;
        if (++consecutiveErrors >= maxConsecutiveErrors) throw new Error(`waitFor failed ${consecutiveErrors} consecutive times`);
      } finally {
        controller.abort();
      }
      const delay = Math.min(intervalMs, Math.max(0, deadline - performance.now()));
      if (delay) await sleep(delay, { signal });
    }
    if (signal?.aborted) throw abortError(signal);
    return false;
  }

  try {
    if (opts.signal?.aborted) throw abortError(opts.signal);
    const probe = await call('Target.getTargets', {}, null, { timeoutMs: connectTimeoutMs, signal: opts.signal });
    if (!Array.isArray(probe?.targetInfos)) throw new Error('Invalid CDP target response during probe');
  } catch (error) { shutdown(); throw error; }

  const connectionInfo = Object.freeze({
    source: config.source, transport: 'websocket', localOnly: true,
    profile: Object.freeze({ expected: config.expectProfile, status: config.expectProfile ? 'unverified' : 'not-requested' }),
  });
  return {
    ws, connectionInfo, viaRelay: config.source === 'CDP_RELAY_URL',
    call, session, evaluate, targets, getFrameTree, assertTargetUrl,
    navigate, screenshot, createTarget, waitFor, close: () => shutdown(),
  };
}

export async function findPage(cdp, needle) {
  return (await cdp.targets()).find((page) => page.url.includes(needle));
}

/** Explicit debugging helper. Do not use in normal diagnostics: URLs may be private. */
export async function dumpPages(cdp, log = console.log) {
  const pages = await cdp.targets();
  for (const page of pages) log(page.targetId, page.title ?? '', page.url);
  return pages;
}
