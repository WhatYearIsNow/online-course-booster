// Chaoxing (超星学习通) plaza helpers: pure parsing plus bounded page operations.
// Page text and API payloads are data. Nothing here executes page-provided code.
import { createHash } from 'node:crypto';

export const PLAZA_HOST = 'tsjy.chaoxing.com';
const DECIMAL = /^[1-9]\d*$/;

/** Ids are interpolated into page expressions, so they must be digits only. */
export function assertId(value, name) {
  if (typeof value !== 'string' || !DECIMAL.test(value))
    throw new TypeError(`${name} must be a positive integer string`);
  return value;
}

export function buildPlazaUrl(courseId, classId) {
  assertId(courseId, 'courseId');
  return `https://${PLAZA_HOST}/plaza/?courseId=${courseId}${classId ? `&classId=${assertId(classId, 'classId')}` : ''}`;
}

/** The real study entry; `enc` is account-bound and must come from modify-node. */
export function buildStudyUrl({ domain, courseId, classId, chapterId, enc }) {
  assertId(courseId, 'courseId');
  assertId(classId, 'classId');
  assertId(chapterId, 'chapterId');
  if (typeof domain !== 'string' || !/^https:\/\/[a-z0-9.-]+\.chaoxing\.com$/i.test(domain))
    throw new TypeError('domain must be an https chaoxing.com host');
  if (typeof enc !== 'string' || !/^[A-Za-z0-9]+$/.test(enc)) throw new TypeError('enc must be alphanumeric');
  const node = `${domain}/mycourse/studentstudy?chapterId=${chapterId}&courseId=${courseId}&clazzid=${classId}&enc=${enc}&mooc2=1`;
  return `${domain}/mycourse/transfer?moocId=${courseId}&ut=s&clazzid=${classId}&refer=${encodeURIComponent(node)}`;
}

/** Knowledge ids appear as goKnowledge(<index>, <knowledgeId>). */
export function parseKnowledgeIds(html) {
  if (typeof html !== 'string') return [];
  const ids = new Set();
  for (const match of html.matchAll(/goKnowledge\(\s*\d+\s*,\s*(\d+)/g)) ids.add(match[1]);
  return [...ids];
}

export function parseClassifyIds(payload, html = '') {
  const ids = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (/^(id|classifyId|classify_id)$/i.test(key) && DECIMAL.test(String(item))) ids.add(String(item));
      else visit(item);
    }
  };
  visit(payload);
  for (const match of String(html).matchAll(/classifyId=(\d+)/g)) ids.add(match[1]);
  return [...ids];
}

const number = (value) =>
  value === null || value === undefined || value === ''
    ? null
    : Number.isFinite(Number(value))
      ? Number(value)
      : null;

export function parseScoreDetail(payload) {
  const data = payload?.data;
  if (!data || typeof data !== 'object') return null;
  return {
    total: number(data.totalScore),
    min: number(data.courseMinScore),
    day: number(data.dayScore),
    dailyMax: number(data.dailyMaxScore),
    items: Array.isArray(data.items)
      ? data.items.map((item) => ({
          name: String(item?.name ?? ''),
          score: number(item?.score),
          rule: String(item?.rule ?? ''),
          unitScore: number(item?.unitScore),
          dailyMaxScore: number(item?.dailyMaxScore),
        }))
      : [],
  };
}

const QUESTION_TYPES = new Map([
  ['判断题', 'judge'],
  ['单选题', 'single'],
  ['多选题', 'multiple'],
  ['填空题', 'fill'],
  ['简答题', 'essay'],
]);

export function classifyQuestionType(text) {
  const match = String(text ?? '').match(/【(.*?)】/);
  if (!match) return 'unknown';
  return QUESTION_TYPES.get(match[1].trim()) ?? 'unknown';
}

/** Only the documented heuristic is supported; it never reads question text. */
export function selectOptions(type, strategy = 'first') {
  if (strategy !== 'first') throw new Error('unsupported answer strategy');
  if (type === 'multiple') return [0, 1];
  if (type === 'judge' || type === 'single') return [0];
  return [];
}

export function parseQuizResult(text) {
  const body = String(text ?? '');
  const match = body.match(/本次成绩\s*(\d+(?:\.\d+)?)\s*分/);
  return { done: /已完成|已提交/.test(body), score: match ? Number(match[1]) : null };
}

const BLOCK_RULES = [
  [/请输入验证码|拖动滑块|滑块验证|完成验证|安全验证/, 'captcha'],
  [/操作频繁|请求过于频繁|稍后再试/, 'rate-limited'],
  [/已在其他页面学习|账号已在其他/, 'single-tab-conflict'],
  [/请先登录|扫码登录|登录已过期/, 'login-required'],
  [/enc\s*校验失败/, 'enc-invalid'],
];

export function detectBlocked(text) {
  const body = String(text ?? '');
  for (const [pattern, reason] of BLOCK_RULES) if (pattern.test(body)) return reason;
  return null;
}

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function buildQuizPlan({ courseId, classId, chapterId, questions, strategy = 'first' }) {
  const body = {
    version: 1,
    platform: 'chaoxing',
    operation: 'quiz',
    courseId: assertId(courseId, 'courseId'),
    classId: assertId(classId, 'classId'),
    chapterId: assertId(chapterId, 'chapterId'),
    strategy,
    questions: questions.map((question) => ({
      type: question.type,
      options: question.options,
    })),
  };
  return { ...body, digest: digest(body) };
}

export function validateQuizPlan(plan, live, confirmation) {
  if (!plan || plan.version !== 1 || plan.platform !== 'chaoxing' || plan.operation !== 'quiz')
    throw new Error('unknown quiz plan format');
  const checked = buildQuizPlan(plan);
  if (plan.digest !== checked.digest || confirmation !== checked.digest)
    throw new Error('quiz plan digest mismatch; preview again');
  if (
    checked.chapterId !== live.chapterId ||
    checked.courseId !== live.courseId ||
    checked.classId !== live.classId
  )
    throw new Error('quiz plan does not match the live chapter');
  if (
    checked.questions.length !== live.questions.length ||
    checked.questions.some(
      (question, index) =>
        question.type !== live.questions[index].type || question.options !== live.questions[index].options,
    )
  )
    throw new Error('live questions changed since preview; preview again');
  return checked;
}

export function buildRunPlan({ courseId, classId, target, chapters, strategy = 'first' }) {
  const body = {
    version: 1,
    platform: 'chaoxing',
    operation: 'run',
    courseId: assertId(courseId, 'courseId'),
    classId: assertId(classId, 'classId'),
    target: Number(target),
    strategy,
    chapters: [...chapters],
  };
  if (!Number.isSafeInteger(body.target) || body.target <= 0)
    throw new Error('target must be a positive integer');
  return { ...body, digest: digest(body) };
}

export function validateRunPlan(plan, live, confirmation) {
  if (!plan || plan.version !== 1 || plan.platform !== 'chaoxing' || plan.operation !== 'run')
    throw new Error('unknown run plan format');
  const checked = buildRunPlan(plan);
  if (plan.digest !== checked.digest || confirmation !== checked.digest)
    throw new Error('run plan digest mismatch; preview again');
  if (checked.courseId !== live.courseId || checked.classId !== live.classId)
    throw new Error('run plan does not match the live course');
  const liveSet = new Set(live.chapters);
  if (checked.chapters.some((chapter) => !liveSet.has(chapter)))
    throw new Error('live chapter list changed since preview; preview again');
  return checked;
}

// ---- Page operations -------------------------------------------------------

export async function readIdentity(cdp, targetId) {
  return cdp.evaluate(
    targetId,
    `(() => ({
      userId: String(window.userId || ''),
      courseId: String(window.courseId || ''),
      classId: String(window.classId || ''),
      personId: String(window.personId || ''),
    }))()`,
  );
}

export async function readScore(cdp, targetId, courseId, classId) {
  assertId(courseId, 'courseId');
  assertId(classId, 'classId');
  const payload = await cdp.evaluate(
    targetId,
    `(async () => {
      const response = await fetch('/plaza/score/${courseId}/user-score-detail?classId=${classId}', { credentials: 'include' });
      return response.json();
    })()`,
  );
  return parseScoreDetail(payload);
}

export async function readClassifyIds(cdp, targetId, { courseId, classId, userId }) {
  assertId(courseId, 'courseId');
  assertId(classId, 'classId');
  const payload = await cdp.evaluate(
    targetId,
    `(async () => {
      try {
        const response = await fetch('/plaza/classify-list?courseId=${courseId}&classId=${classId}&userId=${assertId(userId, 'userId')}', { credentials: 'include' });
        return await response.json();
      } catch { return null; }
    })()`,
  );
  const html = await cdp.evaluate(
    targetId,
    `(() => [...document.querySelectorAll('a[href*="classifyId="]')].map((a) => a.href).join('\\n'))()`,
  );
  return parseClassifyIds(payload, html);
}

export async function readChapterIds(cdp, targetId, { courseId, classId, classifyIds }) {
  assertId(courseId, 'courseId');
  assertId(classId, 'classId');
  const ids = classifyIds.map((id) => assertId(id, 'classifyId'));
  if (!ids.length) throw new Error('no classify ids; pass --classify explicitly');
  const found = await cdp.evaluate(
    targetId,
    `(async () => {
      const out = new Set();
      for (const classify of ${JSON.stringify(ids)}) {
        for (let page = 1; page <= 60; page++) {
          const response = await fetch('/plaza/knowledge-list?classifyId=' + classify + '&courseId=${courseId}&classId=${classId}&page=' + page, { credentials: 'include' });
          const text = await response.text();
          const matches = [...text.matchAll(/goKnowledge\\(\\s*\\d+\\s*,\\s*(\\d+)/g)];
          if (!matches.length) break;
          for (const match of matches) out.add(match[1]);
        }
      }
      return [...out];
    })()`,
  );
  return Array.isArray(found) ? found : [];
}

export async function readNode(cdp, targetId, { courseId, classId, chapterId }) {
  assertId(courseId, 'courseId');
  assertId(classId, 'classId');
  assertId(chapterId, 'chapterId');
  const payload = await cdp.evaluate(
    targetId,
    `(async () => {
      const response = await fetch('/plaza/user/${courseId}/${chapterId}/modify-node?classId=${classId}', { credentials: 'include' });
      return response.json();
    })()`,
  );
  const data = payload?.data;
  if (!data || typeof data !== 'object') return null;
  return {
    mode: String(data.mode ?? ''),
    enc: String(data.enc ?? ''),
    domain: String(data.domain ?? ''),
    classId: String(data.classId ?? classId),
  };
}

export async function openChapter(cdp, targetId, url, chapterId, { timeoutMs = 20000, signal } = {}) {
  assertId(chapterId, 'chapterId');
  await cdp.navigate(targetId, url, { signal });
  return cdp.waitFor(
    targetId,
    `location.href.includes('studentstudy') && location.href.includes('chapterId=${chapterId}') && !!document.getElementById('iframe')`,
    { timeoutMs, intervalMs: 400, signal },
  );
}

const QUIZ_DOC = `(() => {
  const frame = document.getElementById('iframe');
  const doc = frame && frame.contentDocument;
  if (!doc) return null;
  const work = doc.querySelector('iframe[src*="modules/work/"]');
  const workDoc = work && work.contentDocument;
  if (!workDoc) return null;
  const content = workDoc.querySelector('#frame_content');
  return (content && content.contentDocument) || null;
})()`;

export async function openQuizTab(cdp, targetId, { timeoutMs = 20000, signal } = {}) {
  const tabReady = await cdp.waitFor(
    targetId,
    `[...document.querySelectorAll('[id^=dct]')].some((e) => /测评|测验/.test(e.innerText))`,
    { timeoutMs: Math.min(timeoutMs, 10000), intervalMs: 400, signal },
  );
  if (!tabReady) return 'no-tab';
  await cdp.evaluate(
    targetId,
    `(() => {
      const tab = [...document.querySelectorAll('[id^=dct]')].find((e) => /测评|测验/.test(e.innerText));
      if (!tab) return null;
      tab.click();
      return tab.id;
    })()`,
    { signal },
  );
  const ready = await cdp.waitFor(
    targetId,
    `(() => { const q = ${QUIZ_DOC}; return !!(q && q.querySelector('.TiMu')); })()`,
    { timeoutMs, intervalMs: 400, signal },
  );
  return ready ? 'ready' : 'no-work';
}

export async function inspectQuiz(cdp, targetId, { signal } = {}) {
  const raw = await cdp.evaluate(
    targetId,
    `(() => {
      const q = ${QUIZ_DOC};
      if (!q) return { error: 'no-quiz-doc' };
      const items = [...q.querySelectorAll('.TiMu')];
      return {
        count: items.length,
        questions: items.map((item) => {
          const title = item.querySelector('.Zy_TItle_p,.fontLabel');
          return {
            title: title ? title.innerText : '',
            options: item.querySelectorAll('li.font-cxsecret').length,
          };
        }),
        done: /已完成|已提交/.test(q.body.innerText),
        hasSubmit: !!q.querySelector('a.btnSubmit'),
        text: q.body.innerText.slice(0, 500),
      };
    })()`,
    { signal },
  );
  if (!raw || raw.error) return { error: raw?.error ?? 'no-quiz-doc' };
  return {
    count: raw.count,
    questions: raw.questions.map((question) => ({
      type: classifyQuestionType(question.title),
      options: question.options,
    })),
    done: Boolean(raw.done),
    hasSubmit: Boolean(raw.hasSubmit),
    text: String(raw.text ?? ''),
  };
}

export async function answerQuiz(cdp, targetId, strategy = 'first', { signal } = {}) {
  return cdp.evaluate(
    targetId,
    `(() => {
      const q = ${QUIZ_DOC};
      if (!q) return { error: 'no-quiz-doc' };
      const log = [];
      for (const item of q.querySelectorAll('.TiMu')) {
        const title = item.querySelector('.Zy_TItle_p,.fontLabel');
        const text = title ? title.innerText : '';
        const match = text.match(/【(.*?)】/);
        const label = match ? match[1].trim() : '';
        const options = [...item.querySelectorAll('li.font-cxsecret')];
        let picks;
        if (label === '多选题') picks = ${JSON.stringify(selectOptions('multiple', strategy))};
        else if (label === '判断题' || label === '单选题') picks = ${JSON.stringify(selectOptions('single', strategy))};
        else picks = [];
        for (const index of picks) if (options[index]) options[index].click();
        log.push({ label, picks, available: options.length });
      }
      return { answered: log.length, log };
    })()`,
    { signal },
  );
}

export async function submitQuiz(cdp, targetId, { signal, sleep } = {}) {
  const wait = sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const clicked = await cdp.evaluate(
    targetId,
    `(() => { const q = ${QUIZ_DOC}; const button = q && q.querySelector('a.btnSubmit'); if (!button) return false; button.click(); return true; })()`,
    { signal },
  );
  if (!clicked) return { submitted: false, confirmed: false };
  await wait(1200);
  const confirmed = await cdp.evaluate(
    targetId,
    `(() => {
      const q = ${QUIZ_DOC};
      if (!q) return false;
      const button = [...q.querySelectorAll('a.bluebtn')].find((b) => /submitCheckTimes/.test(b.getAttribute('onclick') || ''));
      if (!button) return false;
      button.click();
      return true;
    })()`,
    { signal },
  );
  await wait(1500);
  return { submitted: true, confirmed: Boolean(confirmed) };
}

export async function readQuizResult(cdp, targetId, { signal } = {}) {
  const text = await cdp.evaluate(
    targetId,
    `(() => { const q = ${QUIZ_DOC}; return q ? q.body.innerText.slice(0, 2000) : ''; })()`,
    { signal },
  );
  return { ...parseQuizResult(text), blocked: detectBlocked(text) };
}
