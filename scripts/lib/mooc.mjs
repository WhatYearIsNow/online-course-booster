import { buildDwrBody, parseDwrResponse } from './parse.mjs';
import { assertIdentity, openJournal, classifyExam, TaskError, EXIT } from './workflow.mjs';

export async function pageEval(cdp, targetId, identity, fn, arg = {}) {
  const tree = await cdp.getFrameTree(targetId);
  const actual = assertIdentity(tree?.frameTree?.frame?.url, identity);
  const expectedPath = `/${actual.prefix}learn/${actual.school}-${identity.course}`;
  // 在页面执行上下文中再检查一次，防止 getFrameTree 后发生重定向。
  const expression = `(() => {
    const ensureIdentity = () => {
      const want = ${JSON.stringify(identity)};
      const url = new URL(location.href);
      const path = ${JSON.stringify(expectedPath)};
      if (url.protocol !== 'https:' || url.port || url.username || url.password || !['www.icourse163.org','icourse163.org'].includes(url.hostname) || ![path, path+'/', path+'/content', path+'/content/'].includes(url.pathname) || url.searchParams.getAll('tid').length !== 1 || url.searchParams.get('tid') !== want.term) throw new Error('TARGET_IDENTITY_CHANGED');
    };
    ensureIdentity();
    return (${fn.toString()})(${JSON.stringify(arg)}, ensureIdentity);
  })()`;
  return cdp.evaluate(targetId, expression);
}
export function validateProgress(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !['learnedTimeCount', 'learnedVideoCount', 'lessonCount'].every(
      (k) => Number.isSafeInteger(value[k]) && value[k] >= 0,
    )
  ) {
    throw new TaskError('服务端返回的数据结构无法确认学习进度；没有把缺失值当成零。', EXIT.PARTIAL);
  }
  return Object.fromEntries(
    ['learnedTimeCount', 'learnedVideoCount', 'lessonCount'].map((k) => [k, value[k]]),
  );
}
export async function status(cdp, target, identity) {
  const result = await pageEval(
    cdp,
    target.targetId,
    identity,
    async function readProgress({ term }) {
      const key = (document.cookie.match(/(?:^|;\s*)NTESSTUDYSI=([^;]+)/) || [])[1];
      const query = key ? '?csrfKey=' + encodeURIComponent(key) : '';
      const response = await fetch('/mm-course/web/j/mocMemberLearnBean.getTermLearn.rpc' + query, {
        method: 'POST',
        credentials: 'include',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ termId: term }).toString(),
      });
      if (!response.ok) return { error: 'HTTP_' + response.status };
      let data;
      try {
        data = await response.json();
      } catch {
        return { error: 'NOT_JSON' };
      }
      if (data.code !== undefined && data.code !== 0 && data.code !== 200) return { error: 'BUSINESS_ERROR' };
      const r = data.result;
      return r && typeof r === 'object'
        ? {
            learnedTimeCount: r.learnedTimeCount,
            learnedVideoCount: r.learnedVideoCount,
            lessonCount: r.lessonCount,
          }
        : { error: 'NO_RESULT' };
    },
    identity,
  );
  return { source: 'server-aggregate', ...validateProgress(result), observedAt: new Date().toISOString() };
}
async function go(cdp, target, identity, route, ready, signal) {
  const actual = assertIdentity((await cdp.getFrameTree(target.targetId))?.frameTree?.frame?.url, identity);
  const url = `https://www.icourse163.org/${actual.prefix}learn/${actual.school}-${identity.course}?tid=${identity.term}#/learn/${route}`;
  await cdp.navigate(target.targetId, url);
  const loaded = await cdp.waitFor(
    target.targetId,
    `document.readyState !== 'loading' && location.hash.startsWith(${JSON.stringify('#/learn/' + route)}) && (${ready})`,
    { timeoutMs: 20000, signal },
  );
  if (!loaded) throw new TaskError('目标页面未在期限内呈现可识别内容。', EXIT.PARTIAL);
}
export async function scanVideos(cdp, target, identity, signal) {
  await go(
    cdp,
    target,
    identity,
    'content',
    `document.querySelector('.j-titleBox, .lsicon') !== null`,
    signal,
  );
  await pageEval(cdp, target.targetId, identity, function expandOutline() {
    for (const box of document.querySelectorAll('.j-titleBox')) {
      const arrow = box.querySelector('.j-up');
      if (arrow?.offsetParent) box.click();
    }
    return true;
  });
  const rendered = await cdp.waitFor(target.targetId, `document.querySelector('.lsicon') !== null`, {
    timeoutMs: 15000,
    signal,
  });
  if (!rendered) throw new TaskError('目录为空或选择器已变化，无法确认视频列表。', EXIT.PARTIAL);
  return pageEval(cdp, target.targetId, identity, function readOutline() {
    const nodes = [...document.querySelectorAll('.lsicon')].filter((el) => /视频/.test(el.title || ''));
    return {
      source: 'page-dom',
      total: nodes.length,
      items: nodes.map((el) => ({ cid: el.dataset.cid, learned: el.classList.contains('learned') })),
    };
  });
}
async function readInfo(cdp, target, identity, cmd, signal) {
  await go(
    cdp,
    target,
    identity,
    cmd === 'exam' ? 'examlist' : 'score',
    cmd === 'exam'
      ? `document.querySelector('.j-examItem, .u-quizItem') !== null || /还未开放|尚未开放|未开始|未到开放时间/.test(document.body.innerText)`
      : `Boolean(document.querySelector('.learnPageContent')?.innerText.replace(/Grading Criteria|评分标准|成绩评定|成绩构成/g, '').trim())`,
    signal,
  );
  const info = await pageEval(
    cdp,
    target.targetId,
    identity,
    function readCourseInfo({ cmd }) {
      const items = [...document.querySelectorAll('.j-examItem, .u-quizItem')];
      const actions = items
        .flatMap((item) => [...item.querySelectorAll('a, button')])
        .filter(
          (el) =>
            el.offsetParent !== null &&
            !el.disabled &&
            el.getAttribute('aria-disabled') !== 'true' &&
            !/disabled/i.test(el.className),
        )
        .map((el) => (el.innerText || '').trim());
      return {
        text: (
          (cmd === 'grading'
            ? document.querySelector('.learnPageContent')?.innerText
            : document.body.innerText) || ''
        ).slice(0, 20000),
        items: items.map((el) => (el.innerText || '').trim()).filter(Boolean),
        actions,
      };
    },
    { cmd },
  );
  if (cmd === 'grading' && /还没有发布评分标准|尚未发布|暂无评分标准/.test(info.text)) {
    return { command: cmd, source: 'page-dom', ...info, state: 'NOT_PUBLISHED', exitCode: EXIT.PARTIAL };
  }
  return {
    command: cmd,
    source: 'page-dom',
    ...info,
    ...(cmd === 'exam'
      ? { state: classifyExam(info), exitCode: classifyExam(info) === 'UNKNOWN' ? EXIT.PARTIAL : EXIT.OK }
      : {}),
  };
}
async function topics(cdp, target, identity, signal) {
  await go(
    cdp,
    target,
    identity,
    'forumindex',
    `document.querySelector('a[href*="forumdetail"]') !== null`,
    signal,
  );
  return pageEval(cdp, target.targetId, identity, function readTopics() {
    return [...document.querySelectorAll('a[href*="forumdetail"]')].flatMap((a) => {
      try {
        const url = new URL(a.getAttribute('href'), location.href);
        if (
          url.origin !== location.origin ||
          url.pathname !== location.pathname ||
          url.search !== location.search
        )
          return [];
        const [path, query = ''] = url.hash.slice(1).split('?');
        const params = new URLSearchParams(query);
        const pid = params.get('pid');
        return path === '/learn/forumdetail' &&
          params.getAll('pid').length === 1 &&
          /^[1-9]\d*$/.test(pid || '')
          ? [Number(pid)]
          : [];
      } catch {
        return [];
      }
    });
  });
}
export async function submitDiscussions(cdp, target, identity, plan, journalPath, signal) {
  const available = new Set(await topics(cdp, target, identity, signal));
  if (plan.replies.some((reply) => !available.has(reply.pid)))
    throw new TaskError('计划含未在当前课程讨论目录核实的主题 ID，停止提交。');
  const journal = openJournal(journalPath, plan);
  const results = [];
  try {
    for (const reply of plan.replies) {
      signal?.throwIfAborted();
      const batchId = String(Date.now());
      const bodyTemplate = buildDwrBody({
        ...reply,
        httpSessionId: '__OCB_HTTP_SESSION__',
        scriptSessionId: '__OCB_SCRIPT_SESSION__',
        batchId,
      });
      // 在获取会话、发请求前先持久化 intent；进程崩溃也不会自动重发。
      journal.append({ state: 'intent', pid: reply.pid });
      let sent = false;
      try {
        const response = await pageEval(
          cdp,
          target.targetId,
          identity,
          async function postReply({ bodyTemplate }) {
            const key = (document.cookie.match(/(?:^|;\s*)NTESSTUDYSI=([^;]+)/) || [])[1];
            const ssid = window.dwr?.engine?._scriptSessionId;
            const safe = (value) =>
              typeof value === 'string' && value && !/[\u0000-\u0020\u007f\u0085\u2028\u2029]/u.test(value);
            if (!safe(key) || !safe(ssid)) return { notSent: true };
            // 请求体在浏览器内构造；凭据不跨到 Node，也不进入日志或预览。
            const body = bodyTemplate
              .replace(/^scriptSessionId=.*$/m, () => 'scriptSessionId=' + ssid)
              .replace(/^httpSessionId=.*$/m, () => 'httpSessionId=' + key);
            const res = await fetch('/dwr/call/plaincall/MocForumBean.addReply.dwr', {
              method: 'POST',
              headers: { 'Content-Type': 'text/plain' },
              credentials: 'include',
              redirect: 'error',
              signal: AbortSignal.timeout(10000),
              body,
            });
            const text = await res.text();
            // 超限响应整体拒绝，不能把截断后恰好完整的成功回调当作原始响应。
            return text.length > 1_000_000
              ? { status: res.status, tooLarge: true }
              : { status: res.status, text };
          },
          { bodyTemplate },
        );
        sent = !response?.notSent;
        if (!sent) {
          results.push({ pid: reply.pid, state: 'not-sent' });
        } else {
          const verdict =
            response.status >= 200 && response.status < 300
              ? parseDwrResponse(response.text, { batchId, callId: 0 })
              : { ok: false };
          results.push(
            verdict.ok
              ? { pid: reply.pid, state: 'acknowledged', replyId: verdict.replyId }
              : { pid: reply.pid, state: 'uncertain' },
          );
        }
      } catch {
        // 网络错误无法证明写入失败，不能静默重试。
        results.push({ pid: reply.pid, state: 'uncertain' });
      }
      journal.append(results.at(-1));
      if (results.at(-1).state !== 'acknowledged') break;
    }
    const complete =
      results.length === plan.replies.length && results.every((r) => r.state === 'acknowledged');
    return {
      command: 'discuss',
      digest: plan.digest,
      results,
      remaining: plan.replies.slice(results.length).map((r) => r.pid),
      source: 'server-acknowledgement',
      verified: false,
      exitCode: signal?.aborted ? EXIT.INTERRUPTED : complete ? EXIT.OK : EXIT.PARTIAL,
    };
  } finally {
    journal.close();
  }
}
async function playOne(cdp, target, identity, cid) {
  return pageEval(
    cdp,
    target.targetId,
    identity,
    async function playVideo({ cid }, ensureIdentity) {
      const node = [...document.querySelectorAll('.lsicon')].find((el) => el.dataset.cid === cid);
      if (!node) return { cid, played: false, ended: false, reason: 'unit-missing' };
      ensureIdentity();
      node.click();
      const deadline = Date.now() + 15000;
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      let video;
      while (Date.now() < deadline) {
        ensureIdentity();
        const params = new URLSearchParams(location.hash.split('?')[1] || '');
        video = document.querySelector('video');
        if (params.get('cid') === cid && video && Number.isFinite(video.duration) && video.duration > 1)
          break;
        video = null;
        await pause(150);
      }
      if (!video) return { cid, played: false, ended: false, reason: 'video-not-ready' };
      const eventCleanups = [];
      const event = (name, ms) =>
        new Promise((resolve) => {
          const done = (value) => {
            clearTimeout(timer);
            video.removeEventListener(name, handler);
            resolve(value);
          };
          const handler = () => done(true);
          const timer = setTimeout(() => done(false), ms);
          video.addEventListener(name, handler, { once: true });
          eventCleanups.push(() => done(false));
        });
      try {
        ensureIdentity();
        const seeking = event('seeked', 3000);
        video.currentTime = Math.max(0, video.duration - 2);
        const seeked = await seeking;
        ensureIdentity();
        if (!seeked) return { cid, seeked, played: false, ended: false, reason: 'seek-timeout' };
        const endedEvent = event('ended', 6000);
        let playTimer;
        try {
          await Promise.race([
            video.play(),
            new Promise((_, reject) => {
              playTimer = setTimeout(() => reject(new Error('play-timeout')), 4000);
            }),
          ]);
        } finally {
          clearTimeout(playTimer);
        }
        ensureIdentity();
        const ended = await endedEvent;
        ensureIdentity();
        return { cid, seeked, played: true, ended };
      } catch {
        return { cid, played: false, ended: false, reason: 'play-failed' };
      } finally {
        video.pause();
        for (const cleanup of eventCleanups) cleanup();
      }
    },
    { cid },
  );
}
export async function runCommand(cdp, target, options, { plan, signal } = {}) {
  const { identity, cmd } = options;
  if (cmd === 'status') return { command: cmd, progress: await status(cdp, target, identity) };
  if (cmd === 'exam' || cmd === 'grading') return readInfo(cdp, target, identity, cmd, signal);
  if (cmd === 'discuss')
    return submitDiscussions(
      cdp,
      target,
      plan.school ? { ...identity, school: plan.school } : identity,
      plan,
      options.journal,
      signal,
    );
  const before = await scanVideos(cdp, target, identity, signal);
  if (!options.execute) return { command: cmd, mode: 'scan', outline: before, executed: false };
  const progressBefore = await status(cdp, target, identity);
  const todo = before.items.filter((item) => !item.learned).map((item) => item.cid);
  if (
    todo.some((cid) => typeof cid !== 'string' || !/^[1-9]\d*$/.test(cid)) ||
    new Set(todo).size !== todo.length
  )
    throw new TaskError('视频目录 ID 无效或重复；未执行播放。');
  const results = [];
  let failureCode = null;
  const classifyFailure = (error) =>
    signal?.aborted || error.name === 'AbortError' ? EXIT.INTERRUPTED : EXIT.PARTIAL;
  for (const cid of todo) {
    try {
      signal?.throwIfAborted();
      await scanVideos(cdp, target, identity, signal);
      results.push(await playOne(cdp, target, identity, cid));
    } catch (error) {
      failureCode = classifyFailure(error);
      results.push({
        cid,
        played: false,
        ended: false,
        reason: failureCode === EXIT.INTERRUPTED ? 'interrupted' : 'page-or-connection-error',
      });
      break;
    }
  }
  let after = null,
    progressAfter = null;
  if (failureCode === null) {
    try {
      after = await scanVideos(cdp, target, identity, signal);
      progressAfter = await status(cdp, target, identity);
    } catch (error) {
      failureCode = classifyFailure(error);
    }
  }
  // 目录样式仅为 DOM 证据。aggregate 无法证明单个 cid 已入账，不报告逐条 verified。
  return {
    command: cmd,
    mode: 'experimental-playback',
    results,
    remaining: todo.slice(results.length),
    outlineBefore: before,
    outlineAfter: after,
    progressBefore,
    progressAfter,
    verified: false,
    exitCode: failureCode ?? (todo.length ? EXIT.PARTIAL : EXIT.OK),
  };
}
