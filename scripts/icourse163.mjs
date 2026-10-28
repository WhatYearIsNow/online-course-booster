#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { connect } from './cdp.mjs';
import { ensureManagedBrowser } from './lib/launch.mjs';
import {
  createPlan,
  validatePlan,
  readJson,
  readRules,
  writeJsonExclusive,
  reserveJson,
  EXIT,
  TaskError,
  selectTarget,
} from './lib/workflow.mjs';
import { runCommand } from './lib/mooc.mjs';

const HELP = `中国大学 MOOC 工具（Node.js >=22.15）
用法: node scripts/icourse163.mjs <command> --course ID --term ID [options]
命令: status | grading | exam | videos | discuss
连接: --endpoint ws://127.0.0.1:PORT/devtools/browser/ID 或 --user-data-dir PATH
受管浏览器: --managed [--headless] [--data-dir DIR] [--browser PATH]（隔离、不占用日常浏览器）
目标: --target ID（多个匹配标签时必填） --school CODE --expect-profile NAME
输出: --out FILE（JSON，拒绝覆盖） --timeout-ms MS（默认120000）
讨论预览（完全离线）:
  discuss --file replies.json --rules grading.txt [--plan plan.json] [--dry-run]
讨论提交（独立步骤，须用户已审阅）:
  discuss --plan plan.json --submit --confirm DIGEST [--journal FILE]
视频: videos 默认为目录扫描；--execute --rules grading.txt 开启历史实验播放方法
--help 显示帮助。--plan 和 --out 文件均不覆盖；退出码见 README。`;
const STRINGS = [
  'course',
  'term',
  'school',
  'target',
  'endpoint',
  'user-data-dir',
  'expect-profile',
  'file',
  'rules',
  'plan',
  'confirm',
  'journal',
  'out',
  'timeout-ms',
  'data-dir',
  'browser',
];
const BOOLEANS = ['help', 'submit', 'dry-run', 'execute', 'managed', 'headless'];
export function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: Object.fromEntries([
        ...STRINGS.map((k) => [k, { type: 'string' }]),
        ...BOOLEANS.map((k) => [k, { type: 'boolean' }]),
      ]),
    });
  } catch {
    throw new TaskError('未知参数或参数缺少值，使用 --help 查看用法。', EXIT.ARGS);
  }
  const seen = new Set();
  for (const arg of argv.filter((a) => a.startsWith('--'))) {
    const key = arg.split('=')[0];
    if (seen.has(key)) throw new TaskError('不允许重复参数。', EXIT.ARGS);
    seen.add(key);
  }
  const v = parsed.values;
  if (v.help) return { help: true };
  const cmd = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || !['status', 'grading', 'exam', 'videos', 'discuss'].includes(cmd))
    throw new TaskError('需要一个有效命令，使用 --help 查看用法。', EXIT.ARGS);
  if (!/^[1-9]\d*$/.test(v.course || '') || !/^[1-9]\d*$/.test(v.term || ''))
    throw new TaskError('需要 --course 和 --term，均为正整数 ID。', EXIT.ARGS);
  if (v.school && !/^[A-Za-z0-9]+$/.test(v.school)) throw new TaskError('--school 无效。', EXIT.ARGS);
  const timeoutMs = Number(v['timeout-ms'] ?? 120000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3600000)
    throw new TaskError('--timeout-ms 必须是 100–3600000 的整数。', EXIT.ARGS);
  const only = (keys, allowed) => {
    if (!allowed && keys.some((k) => v[k] !== undefined))
      throw new TaskError('该参数不适用于当前命令。', EXIT.ARGS);
  };
  only(['file', 'plan', 'confirm', 'journal', 'submit', 'dry-run'], cmd === 'discuss');
  only(['execute'], cmd === 'videos');
  only(['rules'], cmd === 'discuss' || cmd === 'videos');
  if (cmd === 'discuss') {
    if (v.submit) {
      if (!v.plan || !v.confirm || v.file || v.rules || v['dry-run'])
        throw new TaskError('提交需要 --plan 和 --confirm；不可同时预览。', EXIT.ARGS);
    } else if (!v.file || !v.rules || v.confirm || v.journal)
      throw new TaskError('预览需要 --file 和 --rules。', EXIT.ARGS);
  }
  if (cmd === 'videos' && Boolean(v.execute) !== Boolean(v.rules))
    throw new TaskError('实验播放需要同时提供 --execute 和 --rules。', EXIT.ARGS);
  if (v.headless && !v.managed) throw new TaskError('--headless 需要配合 --managed。', EXIT.ARGS);
  if ((v['data-dir'] || v.browser) && !v.managed)
    throw new TaskError('--data-dir 和 --browser 只适用于 --managed。', EXIT.ARGS);
  if (v.managed && (v.endpoint || v['user-data-dir']))
    throw new TaskError('--managed 不能与 --endpoint 或 --user-data-dir 同时使用。', EXIT.ARGS);
  if (v.managed && v['expect-profile'])
    throw new TaskError('受管浏览器无法证明 --expect-profile；请改用日常浏览器连接。', EXIT.ARGS);
  return {
    ...v,
    cmd,
    timeoutMs,
    identity: { course: v.course, term: v.term, ...(v.school ? { school: v.school } : {}) },
  };
}
/**
 * Managed browsers start empty. When no matching course tab exists and the
 * school code is known, open the exact learning URL once, then select it by
 * course and term. A login redirect still fails selection rather than guessing.
 */
async function selectManagedTarget(client, options, signal) {
  try {
    return selectTarget(await client.targets(), options.identity, options.target);
  } catch (error) {
    if (!options.managed || options.target || !options.school) throw error;
    const url = `https://www.icourse163.org/learn/${options.school}-${options.identity.course}?tid=${options.identity.term}#/learn/content`;
    const targetId = await client.createTarget('about:blank', { signal });
    await client.navigate(targetId, url, { signal });
    const loaded = await client.waitFor(targetId, 'document.readyState === "complete"', {
      timeoutMs: 60000,
      intervalMs: 300,
      signal,
    });
    if (!loaded) throw new TaskError('受管浏览器打开课程页超时；请核对登录状态。');
    return selectTarget(await client.targets(), options.identity, targetId);
  }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const output = deps.output ?? ((value) => console.log(JSON.stringify(value, null, 2)));
  const errorOutput = deps.errorOutput ?? ((text) => console.error(text));
  let client;
  let timer;
  let reservedOutput;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (deps.signal) {
    if (deps.signal.aborted) controller.abort();
    else deps.signal.addEventListener('abort', abort, { once: true });
  }
  try {
    const options = parseCli(argv);
    if (options.help) {
      (deps.helpOutput ?? console.log)(HELP);
      return EXIT.OK;
    }
    controller.signal.throwIfAborted();
    let plan;
    if (options.cmd === 'discuss') {
      if (!options.submit) {
        plan = createPlan({
          ...options.identity,
          replies: readJson(options.file),
          gradingEvidence: readRules(options.rules),
        });
        if (options.plan && options.out && resolve(options.plan) === resolve(options.out))
          throw new TaskError('--plan 与 --out 不能是同一文件。', EXIT.ARGS);
        if (options.plan) writeJsonExclusive(options.plan, plan);
        if (options.out) writeJsonExclusive(options.out, plan);
        output(plan);
        return EXIT.OK;
      }
      plan = validatePlan(readJson(options.plan), options.identity, options.confirm);
      options.journal ??= join('.local', 'journals', `${plan.digest}.jsonl`);
    }
    if (options.rules) options.gradingEvidence = readRules(options.rules);
    // 在任何浏览器写操作前确保报告路径可写且不存在，避免提交后才发现输出冲突。
    if (options.out) reservedOutput = reserveJson(options.out);
    timer = setTimeout(abort, options.timeoutMs);
    controller.signal.throwIfAborted();
    if (options.managed) {
      const managed = await (deps.ensureManagedBrowser ?? ensureManagedBrowser)({
        dataDir: resolve(options['data-dir'] ?? join(process.cwd(), '.local', 'managed-browser')),
        executable: options.browser ?? process.env.OCB_BROWSER ?? null,
        headless: Boolean(options.headless),
        connect: deps.connect,
        signal: controller.signal,
      });
      client = managed.client;
    } else {
      client = await (deps.connect ?? connect)(undefined, {
        endpoint: options.endpoint,
        userDataDir: options['user-data-dir'],
        expectProfile: options['expect-profile'],
        signal: controller.signal,
      });
    }
    if (
      client.connectionInfo?.profile?.status === 'unverified' ||
      (options['expect-profile'] && client.connectionInfo?.profile?.status !== 'verified')
    )
      throw new TaskError('无法证明连接端点属于要求的 profile；操作已停止。');
    const chosen = await selectManagedTarget(client, options, controller.signal);
    const result = await runCommand(client, chosen, options, { plan, signal: controller.signal });
    reservedOutput?.write(result);
    output(result);
    return result.exitCode ?? EXIT.OK;
  } catch (error) {
    const interrupted = controller.signal.aborted || error.name === 'AbortError';
    errorOutput(
      error instanceof TaskError
        ? error.message
        : interrupted
          ? '任务已中断；请核对本地日志与平台实际记录。'
          : '环境或页面操作失败。请运行 doctor 并核对页面状态。',
    );
    return interrupted ? EXIT.INTERRUPTED : error instanceof TaskError ? error.code : EXIT.ENV;
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', abort);
    try {
      reservedOutput?.close();
    } catch {
      /* 保留主要错误 */
    }
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
