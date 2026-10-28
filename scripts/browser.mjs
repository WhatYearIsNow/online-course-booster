#!/usr/bin/env node
/**
 * Managed browser CLI: an isolated, detached Chromium instance that does not
 * take over the user's daily browser. Read-only status plus explicit start,
 * open and stop. No login form is filled and no credentials are handled.
 */
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  browserStatus,
  closeManagedBrowser,
  ensureManagedBrowser,
  BrowserLaunchError,
} from './lib/launch.mjs';

const EXIT = Object.freeze({ OK: 0, ARGS: 1, ENV: 2, PARTIAL: 3, INTERRUPTED: 4 });

export class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliError';
  }
}

export const HELP = `受管浏览器（隔离、后台运行，不占用日常浏览器）
用法: node scripts/browser.mjs <command> [options]
命令:
  status                     只读报告受管实例与可执行文件
  start                      启动或复用受管实例（默认有窗口，--headless 无窗口）
  open --url URL             在受管实例中打开页面；可等待条件与截图
  stop                       通过 CDP 关闭受管实例（冲刷登录态）
选项:
  --data-dir DIR             受管数据目录（默认 OCB_DATA_DIR 或 .local/managed-browser）
  --browser PATH             指定 Chromium 系可执行文件（默认 OCB_BROWSER 或自动发现）
  --headless                 无窗口运行（不占用前台）
  --url URL                  仅 open：http/https 页面
  --expect EXPR              仅 open：页面内布尔表达式，满足即成功
  --reload-every-ms MS       仅 open：未满足时定时刷新（默认 0，不刷新）
  --screenshot FILE          仅 open：成功后截图
  --timeout-ms MS            整体超时（默认 120000）
  --json                     机器可读输出
  --help                     显示帮助
退出码: 0 成功；1 参数；2 环境/连接；3 条件未满足；4 中断。
受管实例使用独立资料目录，不读取、不复制日常浏览器资料。`;

const STRINGS = new Set([
  'data-dir',
  'browser',
  'url',
  'expect',
  'reload-every-ms',
  'screenshot',
  'timeout-ms',
]);
const BOOLEANS = new Set(['headless', 'json', 'help']);

export function parseCli(argv) {
  const values = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const [rawKey, inline] = arg.slice(2).split('=', 2);
    if (BOOLEANS.has(rawKey)) {
      if (inline !== undefined) throw new CliError(`--${rawKey} 不接受值。`);
      if (values[rawKey] !== undefined) throw new CliError(`不允许重复参数 --${rawKey}。`);
      values[rawKey] = true;
      continue;
    }
    if (!STRINGS.has(rawKey)) throw new CliError(`未知参数 --${rawKey}。`);
    if (values[rawKey] !== undefined) throw new CliError(`不允许重复参数 --${rawKey}。`);
    const value = inline ?? argv[++index];
    if (value === undefined || value === '' || (inline === undefined && value.startsWith('--')))
      throw new CliError(`--${rawKey} 缺少值。`);
    values[rawKey] = value;
  }
  if (values.help) return { help: true };
  if (positionals.length !== 1) throw new CliError('需要一个命令：status、start、open 或 stop。');
  const command = positionals[0];
  if (!['status', 'start', 'open', 'stop'].includes(command)) throw new CliError(`未知命令 ${command}。`);
  if (command !== 'open') {
    for (const key of ['url', 'expect', 'reload-every-ms', 'screenshot'])
      if (values[key] !== undefined) throw new CliError(`--${key} 不适用于 ${command}。`);
  }
  if (command === 'open' && !values.url) throw new CliError('open 需要 --url。');
  if (command !== 'start' && values.headless) throw new CliError('--headless 只适用于 start。');
  const timeoutMs = Number(values['timeout-ms'] ?? 120000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3_600_000)
    throw new CliError('--timeout-ms 必须是 100–3600000 的整数。');
  const reloadEveryMs = Number(values['reload-every-ms'] ?? 0);
  if (!Number.isSafeInteger(reloadEveryMs) || reloadEveryMs < 0 || reloadEveryMs > 3_600_000)
    throw new CliError('--reload-every-ms 必须是 0–3600000 的整数。');
  if (values.url) {
    let url;
    try {
      url = new URL(values.url);
    } catch {
      throw new CliError('--url 不是有效 URL。');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new CliError('--url 只接受不含凭据的 http/https 地址。');
  }
  return { ...values, command, timeoutMs, reloadEveryMs };
}

export function defaultDataDir(env = process.env, cwd = process.cwd()) {
  return env.OCB_DATA_DIR || join(cwd, '.local', 'managed-browser');
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('The operation was aborted', 'AbortError');
}

const expectExpression = (expression) =>
  `(() => { try { return !!(${expression}); } catch { return false; } })()`;

async function waitForLoad(client, targetId, deadline, signal) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  return client.waitFor(targetId, 'document.readyState === "complete"', {
    timeoutMs: remaining,
    intervalMs: 200,
    signal,
  });
}

async function openPage(client, options, deadline, signal) {
  const targetId = await client.createTarget('about:blank', { signal });
  await client.navigate(targetId, options.url, { signal });
  if (!(await waitForLoad(client, targetId, deadline, signal)))
    return { targetId, ok: false, reason: 'load-timeout' };
  if (!options.expect) return { targetId, ok: true };
  const expression = expectExpression(options.expect);
  if (!options.reloadEveryMs) {
    const matched = await client.waitFor(targetId, expression, {
      timeoutMs: Math.max(1, deadline - Date.now()),
      intervalMs: 500,
      signal,
    });
    return { targetId, ok: matched, ...(matched ? {} : { reason: 'expect-timeout' }) };
  }
  for (;;) {
    if (signal?.aborted) throw abortError(signal);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { targetId, ok: false, reason: 'expect-timeout' };
    let matched = false;
    try {
      matched = Boolean(
        await client.evaluate(targetId, expression, {
          timeoutMs: Math.min(remaining, 10_000),
          signal,
        }),
      );
    } catch {
      matched = false;
    }
    if (matched) return { targetId, ok: true };
    const delay = Math.min(options.reloadEveryMs, Math.max(0, deadline - Date.now()));
    if (delay) await new Promise((done) => setTimeout(done, delay));
    if (signal?.aborted) throw abortError(signal);
    if (Date.now() >= deadline) return { targetId, ok: false, reason: 'expect-timeout' };
    await client.navigate(targetId, options.url, { signal });
    await waitForLoad(client, targetId, deadline, signal);
  }
}

async function describe(client, targetId) {
  let url = null;
  try {
    url = (await client.getFrameTree(targetId))?.frameTree?.frame?.url ?? null;
  } catch {
    /* The page may have navigated away. */
  }
  let title = null;
  try {
    title = await client.evaluate(targetId, 'document.title');
  } catch {
    /* Title is diagnostic only. */
  }
  return { url, title };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const output = deps.output ?? ((value) => console.log(JSON.stringify(value, null, 2)));
  const errorOutput = deps.errorOutput ?? ((text) => console.error(text));
  const helpOutput = deps.helpOutput ?? console.log;
  const env = deps.env ?? process.env;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (deps.signal) {
    if (deps.signal.aborted) controller.abort();
    else deps.signal.addEventListener('abort', abort, { once: true });
  }
  let timer;
  let client;
  try {
    const options = parseCli(argv);
    if (options.help) {
      helpOutput(HELP);
      return EXIT.OK;
    }
    const dataDir = resolve(options['data-dir'] ?? defaultDataDir(env));
    const executable = options.browser ?? env.OCB_BROWSER ?? null;
    const launchDeps = deps.launchDeps ?? {};
    controller.signal.throwIfAborted();

    if (options.command === 'status') {
      const report = await browserStatus({ dataDir, executable, env, ...launchDeps });
      output(report);
      return report.running || report.executable ? EXIT.OK : EXIT.ENV;
    }
    if (options.command === 'stop') {
      const result = await closeManagedBrowser({ dataDir, ...launchDeps });
      output(result);
      return result.stopped || result.reason === 'not-running' ? EXIT.OK : EXIT.ENV;
    }

    // The hard stop sits just past the page deadline so a condition timeout
    // reports PARTIAL instead of being misread as an interruption.
    timer = setTimeout(abort, options.timeoutMs + 3000);
    const managed = await ensureManagedBrowser({
      dataDir,
      executable,
      headless: Boolean(options.headless),
      env,
      connect: deps.connect,
      ...launchDeps,
    });
    client = managed.client;
    if (options.command === 'start') {
      output({
        started: true,
        reused: managed.reused,
        endpoint: managed.endpoint,
        dataDir,
        headless: Boolean(options.headless),
      });
      return EXIT.OK;
    }

    const deadline = Date.now() + options.timeoutMs;
    const opened = await openPage(client, options, deadline, controller.signal);
    const details = await describe(client, opened.targetId);
    const result = {
      ok: opened.ok,
      ...(opened.reason ? { reason: opened.reason } : {}),
      targetId: opened.targetId,
      url: details.url,
      title: details.title,
      dataDir,
    };
    if (opened.ok && options.screenshot) {
      result.screenshot = resolve(options.screenshot);
      await client.screenshot(opened.targetId, result.screenshot, { signal: controller.signal });
    }
    output(result);
    return opened.ok ? EXIT.OK : EXIT.PARTIAL;
  } catch (error) {
    const interrupted = controller.signal.aborted || error.name === 'AbortError';
    if (interrupted) {
      errorOutput('任务已中断；受管浏览器可能仍在运行，可用 stop 关闭。');
      return EXIT.INTERRUPTED;
    }
    if (error instanceof CliError) {
      errorOutput(error.message);
      return EXIT.ARGS;
    }
    if (error instanceof BrowserLaunchError) {
      errorOutput(error.message);
      return EXIT.ENV;
    }
    errorOutput('受管浏览器操作失败。请运行 status 核对配置。');
    return EXIT.ENV;
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', abort);
    try {
      client?.close();
    } catch {
      /* close 不覆盖原错误 */
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.exitCode = await main(process.argv.slice(2), { signal: controller.signal });
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
