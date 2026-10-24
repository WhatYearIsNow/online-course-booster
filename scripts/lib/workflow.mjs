import { createHash } from 'node:crypto';
import { openSync, writeSync, fsyncSync, closeSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeReply, parseCourseUrl } from './parse.mjs';

export const EXIT = Object.freeze({ OK: 0, ARGS: 1, ENV: 2, PARTIAL: 3, INTERRUPTED: 4 });
export class TaskError extends Error {
  constructor(message, code = EXIT.ENV, options) { super(message, options); this.code = code; }
}
export function assertIdentity(url, { course, term, school }) {
  const actual = parseCourseUrl(url);
  if (!actual || actual.courseId !== course || actual.termId !== term || (school && actual.school !== school)) {
    throw new TaskError('课程、学期或学校身份不匹配；操作已停止。');
  }
  return actual;
}
export function selectTarget(pages, identity, targetId) {
  if (!Array.isArray(pages)) throw new TaskError('无效的标签页列表。');
  const matches = pages.filter(p => {
    try { assertIdentity(p.url, identity); return p.type === undefined || p.type === 'page'; }
    catch { return false; }
  });
  if (targetId) {
    const chosen = matches.find(p => p.targetId === targetId);
    if (!chosen) throw new TaskError('--target 未精确匹配目标课程和学期。');
    return chosen;
  }
  if (matches.length !== 1) throw new TaskError(matches.length ? '目标存在多个标签页，请用 --target 明确指定。' : '没有匹配课程和学期的学习标签页。');
  return matches[0];
}
function payload({ course, term, school = null, gradingEvidence, replies }) {
  if (!/^[1-9]\d*$/.test(course) || !/^[1-9]\d*$/.test(term) ||
      (school !== null && !/^[A-Za-z0-9]+$/.test(school))) throw new TaskError('计划中的课程身份无效。', EXIT.ARGS);
  if (typeof gradingEvidence !== 'string' || !gradingEvidence.trim()) throw new TaskError('需要非空成绩规则依据。', EXIT.ARGS);
  if (!Array.isArray(replies) || !replies.length || replies.length > 100) throw new TaskError('回复必须为 1–100 条。', EXIT.ARGS);
  const normalized = replies.map(normalizeReply);
  if (normalized.some(r => !r) || normalized.some(r => r.html.length > 100_000)) throw new TaskError('回复格式无效或内容过长；没有跳过任何条目。', EXIT.ARGS);
  if (new Set(normalized.map(r => r.pid)).size !== normalized.length) throw new TaskError('计划含重复主题 ID，请拆分并审阅。', EXIT.ARGS);
  return { version: 1, platform: 'icourse163', operation: 'discuss', course, term, school, gradingEvidence, replies: normalized };
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createPlan(input) {
  const body = payload(input);
  return { ...body, digest: digest(body) };
}
export function validatePlan(plan, identity, confirmation) {
  if (!plan || plan.version !== 1 || plan.platform !== 'icourse163' || plan.operation !== 'discuss') throw new TaskError('未知的预览计划格式。', EXIT.ARGS);
  const checked = createPlan(plan);
  if (plan.digest !== checked.digest || confirmation !== checked.digest) throw new TaskError('预览摘要不匹配；请重新预览并确认。', EXIT.ARGS);
  if (plan.course !== identity.course || plan.term !== identity.term || (identity.school && identity.school !== plan.school)) throw new TaskError('计划与命令行课程身份不符。', EXIT.ARGS);
  return checked;
}
export function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new TaskError('JSON 文件无法读取或格式错误。', EXIT.ARGS); }
}
export function readRules(path) {
  try {
    const text = readFileSync(path, 'utf8');
    if (!text.trim() || text.length > 100_000) throw new Error();
    return text;
  } catch { throw new TaskError('成绩规则文件无法读取、为空或过长。', EXIT.ARGS); }
}
export function writeJsonExclusive(path, data) {
  const reserved = reserveJson(path);
  try { reserved.write(data); } finally { reserved.close(); }
}
export function reserveJson(path) {
  let fd;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch { throw new TaskError('输出文件写入失败或已存在；不会覆盖现有文件。', EXIT.ARGS); }
  return { write: data => { writeSync(fd, JSON.stringify(data, null, 2) + '\n'); fsyncSync(fd); }, close: () => closeSync(fd) };
}
export function openJournal(path, plan) {
  mkdirSync(dirname(path), { recursive: true });
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch { throw new TaskError('提交日志已存在或不可写。先核对讨论区及日志，禁止自动重发。', EXIT.ARGS); }
  const append = record => {
    writeSync(fd, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n'); fsyncSync(fd);
  };
  try { append({ state: 'started', digest: plan.digest, course: plan.course, term: plan.term }); }
  catch (error) { closeSync(fd); throw error; }
  return { append, close: () => closeSync(fd) };
}
export function classifyExam({ text = '', actions = [] } = {}) {
  const negative = /还未开放|尚未开放|未开始|未到开放时间/.test(text);
  const positive = actions.some(action => /^(开始考试|进入考试|继续考试)$/.test(action.trim()));
  if (/请先登录|扫码登录/.test(text) || (positive && negative)) return 'UNKNOWN';
  if (positive) return 'OPEN';
  if (negative) return 'NOT_OPEN';
  return 'UNKNOWN';
}
