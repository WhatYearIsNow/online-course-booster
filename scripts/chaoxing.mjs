#!/usr/bin/env node
/**
 * Chaoxing (超星学习通) plaza CLI. Read-only status and chapter listing; quiz
 * preview and submission are separate steps bound to a plan digest. No answer
 * bank, no automatic retry, and no attempt to bypass captcha or risk control.
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve, join, dirname } from 'node:path';
import { openSync, writeSync, fsyncSync, closeSync, mkdirSync } from 'node:fs';
import { connect } from './cdp.mjs';
import { ensureManagedBrowser } from './lib/launch.mjs';
import { EXIT, TaskError, readJson, writeJsonExclusive, reserveJson } from './lib/workflow.mjs';
import {
  buildPlazaUrl,
  buildStudyUrl,
  buildQuizPlan,
  buildRunPlan,
  validateQuizPlan,
  validateRunPlan,
  readIdentity,
  readScore,
  readClassifyIds,
  readChapterIds,
  readNode,
  openChapter,
  openQuizTab,
  inspectQuiz,
  answerQuiz,
  submitQuiz,
  readQuizResult,
  detectBlocked,
} from './lib/chaoxing.mjs';

const HELP = `超星学习通（形势与政策广场）工具（Node.js >=22.15）
用法: node scripts/chaoxing.mjs <command> --course-id ID --class-id ID [options]
命令:
  status                     只读：身份、总积分、达标线与分项规则
  chapters                   只读：列出知识点（章节）ID
  quiz --chapter ID          预览单章测评；--submit --confirm DIGEST 才提交
  run --target N             预览批量冲分计划；--submit --confirm DIGEST 才执行
连接:
  --endpoint ws://... | --user-data-dir PATH | --managed [--headless] [--data-dir DIR] [--browser PATH]
身份: --expect-user UID（可选，核对 window.userId）
范围: --classify IDS（逗号分隔；缺省从广场页读取） --max-chapters N（run 上限）
输出: --plan FILE（保存/读取计划） --out FILE（结果，拒绝覆盖） --journal FILE
其他: --strategy first（默认启发式） --timeout-ms MS --help
退出码: 0 完成；1 参数/计划；2 环境/身份；3 部分完成或未满足；4 中断或结果含糊。`;

const STRINGS = [
  'course-id',
  'class-id',
  'expect-user',
  'chapter',
  'classify',
  'target',
  'max-chapters',
  'strategy',
  'confirm',
  'plan',
  'out',
  'journal',
  'endpoint',
  'user-data-dir',
  'data-dir',
  'browser',
  'timeout-ms',
];
const BOOLEANS = ['help', 'submit', 'managed', 'headless'];

export function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: Object.fromEntries([
        ...STRINGS.map((key) => [key, { type: 'string' }]),
        ...BOOLEANS.map((key) => [key, { type: 'boolean' }]),
      ]),
    });
  } catch {
    throw new TaskError('未知参数或参数缺少值，使用 --help 查看用法。', EXIT.ARGS);
  }
  const seen = new Set();
  for (const arg of argv.filter((value) => value.startsWith('--'))) {
    const key = arg.split('=')[0];
    if (seen.has(key)) throw new TaskError('不允许重复参数。', EXIT.ARGS);
    seen.add(key);
  }
  const values = parsed.values;
  if (values.help) return { help: true };
  const command = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || !['status', 'chapters', 'quiz', 'run'].includes(command))
    throw new TaskError('需要一个有效命令，使用 --help 查看用法。', EXIT.ARGS);
  if (!/^[1-9]\d*$/.test(values['course-id'] || '') || !/^[1-9]\d*$/.test(values['class-id'] || ''))
    throw new TaskError('需要 --course-id 和 --class-id，均为正整数 ID。', EXIT.ARGS);
  if (values['expect-user'] && !/^[1-9]\d*$/.test(values['expect-user']))
    throw new TaskError('--expect-user 无效。', EXIT.ARGS);
  if (values.classify && !/^[1-9]\d*(,[1-9]\d*)*$/.test(values.classify))
    throw new TaskError('--classify 必须是逗号分隔的正整数。', EXIT.ARGS);
  const timeoutMs = Number(values['timeout-ms'] ?? 120000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3_600_000)
    throw new TaskError('--timeout-ms 必须是 100–3600000 的整数。', EXIT.ARGS);
  const strategy = values.strategy ?? 'first';
  if (strategy !== 'first') throw new TaskError('当前只支持 --strategy first。', EXIT.ARGS);
  if (command === 'quiz' && !/^[1-9]\d*$/.test(values.chapter || ''))
    throw new TaskError('quiz 需要 --chapter，为正整数 ID。', EXIT.ARGS);
  if (command === 'run') {
    const target = Number(values.target);
    if (!Number.isSafeInteger(target) || target <= 0 || target > 100000)
      throw new TaskError('run 需要 --target，为 1–100000 的整数。', EXIT.ARGS);
    if (values['max-chapters'] !== undefined) {
      const max = Number(values['max-chapters']);
      if (!Number.isSafeInteger(max) || max <= 0 || max > 10000)
        throw new TaskError('--max-chapters 必须是 1–10000 的整数。', EXIT.ARGS);
    }
  } else if (values.target !== undefined || values['max-chapters'] !== undefined) {
    throw new TaskError('--target 和 --max-chapters 只适用于 run。', EXIT.ARGS);
  }
  if (command !== 'quiz' && values.chapter !== undefined)
    throw new TaskError('--chapter 只适用于 quiz。', EXIT.ARGS);
  if (values.submit && !values.confirm) throw new TaskError('提交需要 --confirm DIGEST。', EXIT.ARGS);
  if (values.confirm && !values.submit) throw new TaskError('--confirm 只用于 --submit。', EXIT.ARGS);
  if (values.submit && !['quiz', 'run'].includes(command))
    throw new TaskError('--submit 只适用于 quiz 和 run。', EXIT.ARGS);
  if (values.managed && (values.endpoint || values['user-data-dir']))
    throw new TaskError('--managed 不能与 --endpoint 或 --user-data-dir 同时使用。', EXIT.ARGS);
  if ((values['data-dir'] || values.browser || values.headless) && !values.managed)
    throw new TaskError('--data-dir、--browser 和 --headless 只适用于 --managed。', EXIT.ARGS);
  return {
    ...values,
    command,
    timeoutMs,
    strategy,
    courseId: values['course-id'],
    classId: values['class-id'],
    expectUser: values['expect-user'] ?? null,
    classifyIds: values.classify ? values.classify.split(',') : null,
    target: values.target === undefined ? null : Number(values.target),
    maxChapters: values['max-chapters'] === undefined ? null : Number(values['max-chapters']),
  };
}

function openJournal(path, plan) {
  mkdirSync(dirname(path), { recursive: true });
  let fd;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch {
    throw new TaskError('提交日志已存在或不可写。先核对平台记录，禁止自动重跑。', EXIT.ARGS);
  }
  const append = (record) => {
    writeSync(fd, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
    fsyncSync(fd);
  };
  try {
    append({ state: 'started', digest: plan.digest, operation: plan.operation });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return { append, close: () => closeSync(fd) };
}

async function openPlaza(client, options, signal) {
  const url = buildPlazaUrl(options.courseId, options.classId);
  const pages = await client.targets();
  let page = pages.find(
    (candidate) =>
      candidate.url.includes('tsjy.chaoxing.com') && candidate.url.includes(`courseId=${options.courseId}`),
  );
  if (!page) {
    const targetId = await client.createTarget('about:blank', { signal });
    await client.navigate(targetId, url, { signal });
    page = { targetId, url };
  }
  const ready = await client.waitFor(
    page.targetId,
    `String(window.courseId || '') === '${options.courseId}'`,
    { timeoutMs: 30000, intervalMs: 400, signal },
  );
  if (!ready) throw new TaskError('广场页未就绪；请核对登录状态与课程身份。');
  const identity = await readIdentity(client, page.targetId);
  if (!identity.userId) throw new TaskError('未登录或登录已过期；请先在浏览器中完成登录。');
  if (identity.courseId !== options.courseId) throw new TaskError('广场页课程 ID 与 --course-id 不一致。');
  if (identity.classId && identity.classId !== options.classId)
    throw new TaskError('广场页班级 ID 与 --class-id 不一致。');
  if (options.expectUser && identity.userId !== options.expectUser)
    throw new TaskError('广场页用户 ID 与 --expect-user 不一致。');
  return { targetId: page.targetId, identity };
}

async function resolveClassify(client, targetId, options, identity) {
  if (options.classifyIds) return options.classifyIds;
  const ids = await readClassifyIds(client, targetId, {
    courseId: options.courseId,
    classId: options.classId,
    userId: identity.userId,
  });
  if (!ids.length) throw new TaskError('未能读取分类 ID；请用 --classify 明确指定。');
  return ids;
}

async function status(client, targetId, options) {
  const score = await readScore(client, targetId, options.courseId, options.classId);
  if (!score) throw new TaskError('积分接口未返回有效数据。');
  return { state: 'ok', score };
}

async function chapters(client, targetId, options, identity) {
  const classifyIds = await resolveClassify(client, targetId, options, identity);
  const ids = await readChapterIds(client, targetId, {
    courseId: options.courseId,
    classId: options.classId,
    classifyIds,
  });
  return { state: 'ok', classifyIds, count: ids.length, chapters: ids };
}

async function prepareQuiz(client, plazaTarget, studyTarget, options, chapterId, signal) {
  const node = await readNode(client, plazaTarget, {
    courseId: options.courseId,
    classId: options.classId,
    chapterId,
  });
  if (!node) return { state: 'no-node' };
  if (node.mode !== 'study') return { state: 'preview-mode', mode: node.mode };
  const url = buildStudyUrl({
    domain: node.domain,
    courseId: options.courseId,
    classId: node.classId || options.classId,
    chapterId,
    enc: node.enc,
  });
  try {
    if (!(await openChapter(client, studyTarget, url, chapterId, { timeoutMs: 20000, signal })))
      return { state: 'chapter-timeout' };
    const tab = await openQuizTab(client, studyTarget, { timeoutMs: 20000, signal });
    if (tab !== 'ready') return { state: tab };
    const quiz = await inspectQuiz(client, studyTarget, { signal });
    if (quiz.error) return { state: quiz.error };
    const blocked = detectBlocked(quiz.text);
    if (blocked) return { state: 'blocked', reason: blocked };
    return { state: 'ready', quiz, node };
  } catch (error) {
    return { state: 'failed', error: error.message };
  }
}

async function quiz(client, targetId, options, signal) {
  const studyTarget = await client.createTarget('about:blank', { signal });
  try {
    const prepared = await prepareQuiz(client, targetId, studyTarget, options, options.chapter, signal);
    if (prepared.state !== 'ready') return prepared;
    const plan = buildQuizPlan({
      courseId: options.courseId,
      classId: options.classId,
      chapterId: options.chapter,
      questions: prepared.quiz.questions,
      strategy: options.strategy,
    });
    if (prepared.quiz.done) return { state: 'already-done', plan };
    if (!prepared.quiz.hasSubmit) return { state: 'no-submit', plan };
    if (!options.submit) return { state: 'preview', plan };
    validateQuizPlan(plan, plan, options.confirm);
    const journalPath = options.journal ?? join('.local', 'journals', `chaoxing-${plan.digest}.jsonl`);
    const journal = openJournal(journalPath, plan);
    try {
      journal.append({ state: 'answered', chapterId: options.chapter });
      const answered = await answerQuiz(client, studyTarget, options.strategy, { signal });
      const submitted = await submitQuiz(client, studyTarget, { signal });
      const result = await readQuizResult(client, studyTarget, { signal });
      journal.append({
        state: result.blocked || !submitted.confirmed ? 'uncertain' : 'result',
        chapterId: options.chapter,
        submitted,
        result,
      });
      return {
        state: result.blocked ? 'blocked' : submitted.confirmed ? 'submitted' : 'uncertain',
        answered,
        submitted,
        result,
        plan,
        journal: journalPath,
      };
    } finally {
      journal.close();
    }
  } finally {
    try {
      await client.call('Target.closeTarget', { targetId: studyTarget });
    } catch {
      /* The tab may already be gone. */
    }
  }
}

async function run(client, targetId, options, signal) {
  const before = await readScore(client, targetId, options.courseId, options.classId);
  if (!before) throw new TaskError('积分接口未返回有效数据。');
  if (before.total !== null && before.total >= options.target) return { state: 'target-reached', before };
  const identity = await readIdentity(client, targetId);
  const classifyIds = await resolveClassify(client, targetId, options, identity);
  const ids = await readChapterIds(client, targetId, {
    courseId: options.courseId,
    classId: options.classId,
    classifyIds,
  });
  if (!ids.length) throw new TaskError('没有可处理的知识点。');
  const plan = buildRunPlan({
    courseId: options.courseId,
    classId: options.classId,
    target: options.target,
    chapters: ids,
    strategy: options.strategy,
  });
  if (!options.submit) return { state: 'preview', plan, before, chapterCount: ids.length };
  validateRunPlan(
    plan,
    { courseId: options.courseId, classId: options.classId, chapters: ids },
    options.confirm,
  );
  const journalPath = options.journal ?? join('.local', 'journals', `chaoxing-${plan.digest}.jsonl`);
  const journal = openJournal(journalPath, plan);
  const studyTarget = await client.createTarget('about:blank', { signal });
  const outcomes = [];
  let score = before.total;
  let processed = 0;
  const limit = options.maxChapters ?? ids.length;
  try {
    for (const chapterId of ids) {
      if (processed >= limit) break;
      if (score !== null && score >= options.target) break;
      processed++;
      const prepared = await prepareQuiz(client, targetId, studyTarget, options, chapterId, signal);
      if (prepared.state !== 'ready') {
        journal.append({ state: 'skipped', chapterId, reason: prepared.state });
        outcomes.push({ chapterId, state: 'skipped', reason: prepared.state });
        continue;
      }
      if (prepared.quiz.done) {
        journal.append({ state: 'already-done', chapterId });
        outcomes.push({ chapterId, state: 'already-done' });
        continue;
      }
      if (!prepared.quiz.hasSubmit) {
        journal.append({ state: 'no-submit', chapterId });
        outcomes.push({ chapterId, state: 'no-submit' });
        continue;
      }
      journal.append({ state: 'answered', chapterId });
      const answered = await answerQuiz(client, studyTarget, options.strategy, { signal });
      const submitted = await submitQuiz(client, studyTarget, { signal });
      const result = await readQuizResult(client, studyTarget, { signal });
      const state = result.blocked ? 'blocked' : submitted.confirmed ? 'result' : 'uncertain';
      journal.append({ state, chapterId, answered, submitted, result });
      outcomes.push({ chapterId, state, answered: answered.answered, result });
      if (result.blocked || !submitted.confirmed) break;
      score = (await readScore(client, targetId, options.courseId, options.classId))?.total ?? score;
    }
  } finally {
    journal.close();
    try {
      await client.call('Target.closeTarget', { targetId: studyTarget });
    } catch {
      /* The tab may already be gone. */
    }
  }
  const after = await readScore(client, targetId, options.courseId, options.classId);
  const uncertain = outcomes.some((item) => item.state === 'uncertain' || item.state === 'blocked');
  return {
    state: uncertain
      ? 'uncertain'
      : after?.total !== null && after?.total >= options.target
        ? 'target-reached'
        : 'partial',
    before,
    after,
    processed,
    outcomes,
    journal: journalPath,
  };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const output = deps.output ?? ((value) => console.log(JSON.stringify(value, null, 2)));
  const errorOutput = deps.errorOutput ?? ((text) => console.error(text));
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (deps.signal) {
    if (deps.signal.aborted) controller.abort();
    else deps.signal.addEventListener('abort', abort, { once: true });
  }
  let client;
  let timer;
  let reservedOutput;
  try {
    const options = parseCli(argv);
    if (options.help) {
      (deps.helpOutput ?? console.log)(HELP);
      return EXIT.OK;
    }
    controller.signal.throwIfAborted();
    if (options.out) reservedOutput = reserveJson(options.out);
    timer = setTimeout(abort, options.timeoutMs);
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
        signal: controller.signal,
      });
    }
    const plaza = await openPlaza(client, options, controller.signal);
    let result;
    if (options.command === 'status')
      result = { ...(await status(client, plaza.targetId, options)), identity: plaza.identity };
    else if (options.command === 'chapters')
      result = await chapters(client, plaza.targetId, options, plaza.identity);
    else if (options.command === 'quiz')
      result = await quiz(client, plaza.targetId, options, controller.signal);
    else result = await run(client, plaza.targetId, options, controller.signal);
    if (options.plan && result.plan) writeJsonExclusive(options.plan, result.plan);
    reservedOutput?.write(result);
    output(result);
    if (result.state === 'preview') return EXIT.OK;
    if (result.state === 'blocked' || result.state === 'uncertain') return EXIT.INTERRUPTED;
    if (['target-reached', 'submitted', 'ok', 'already-done'].includes(result.state)) return EXIT.OK;
    return EXIT.PARTIAL;
  } catch (error) {
    const interrupted = controller.signal.aborted || error.name === 'AbortError';
    if (process.env.OCB_DEBUG === '1' && !(error instanceof TaskError))
      errorOutput(`[debug] ${error?.stack ?? error}`);
    errorOutput(
      error instanceof TaskError
        ? error.message
        : interrupted
          ? '任务已中断；请核对平台实际记录后再决定是否继续。'
          : '环境或页面操作失败。请核对登录状态与页面结构。',
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
