import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertIdentity,
  selectTarget,
  createPlan,
  validatePlan,
  openJournal,
  writeJsonExclusive,
  classifyExam,
} from '../scripts/lib/workflow.mjs';

const identity = { course: '1000', term: '2000' };
const url = 'https://www.icourse163.org/learn/DEMO-1000?tid=2000';
const input = {
  ...identity,
  gradingEvidence: '合成规则：讨论需人工审阅。',
  replies: [{ pid: 3000, html: '<p>合成讨论内容。</p>' }],
};
test('课程、学期、学校精确匹配，拒绝伪装域名与缺失学期', () => {
  assert.equal(assertIdentity(url, identity).school, 'DEMO');
  for (const changed of [
    url.replace('1000', '10001'),
    url.replace('2000', '2001'),
    url.replace('www.icourse163.org', 'www.icourse163.org.evil.example'),
    url.split('?')[0],
  ]) {
    assert.throws(() => assertIdentity(changed, identity));
  }
  assert.throws(() => assertIdentity(url, { ...identity, school: 'OTHER' }));
});
test('多个匹配标签页拒绝猜测，显式target还必须匹配身份', () => {
  const pages = [
    { url, targetId: 'one' },
    { url, targetId: 'two' },
    { url: url.replace('2000', '2001'), targetId: 'old' },
  ];
  assert.throws(() => selectTarget(pages, identity));
  assert.equal(selectTarget(pages, identity, 'two').targetId, 'two');
  assert.throws(() => selectTarget(pages, identity, 'old'));
  assert.throws(() => selectTarget([], identity));
});
test('摘要绑定所有正文、顺序、课程、学期与成绩依据', () => {
  const plan = createPlan(input);
  assert.deepEqual(validatePlan(plan, identity, plan.digest), plan);
  for (const change of [
    { course: '1001' },
    { term: '2001' },
    { gradingEvidence: '已修改' },
    { replies: [{ pid: 3000, html: '<p>另一内容</p>' }] },
    { version: 2 },
  ]) {
    assert.throws(() => validatePlan({ ...plan, ...change }, identity, plan.digest));
  }
  assert.throws(() => validatePlan(plan, identity, '0'.repeat(64)));
  assert.throws(() => validatePlan(plan, { ...identity, term: '9999' }, plan.digest));
});
test('无效条目与重复主题拒绝整批，避免静默跳过输入', () => {
  for (const replies of [
    [],
    [{ pid: true, html: 'x' }],
    [...input.replies, { pid: 0, html: 'x' }],
    [...input.replies, ...input.replies],
  ]) {
    assert.throws(() => createPlan({ ...input, replies }));
  }
  assert.throws(() => createPlan({ ...input, gradingEvidence: ' ' }));
});
test('日志独占、每步落盘；已存在日志不可重发', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ocb-journal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'task.jsonl');
  const plan = createPlan(input);
  const journal = openJournal(file, plan);
  journal.append({ state: 'intent', pid: 3000 });
  journal.close();
  assert.deepEqual(
    readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).state),
    ['started', 'intent'],
  );
  assert.throws(() => openJournal(file, plan));
});
test('JSON产物不覆盖现有文件', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ocb-output-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'result.json');
  writeJsonExclusive(path, { value: 1 });
  assert.throws(() => writeJsonExclusive(path, { value: 2 }));
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { value: 1 });
});
test('考试列表存在不等于开放，混合和未知情况不猜测', () => {
  assert.equal(classifyExam({ text: '期末考试', items: ['期末考试：已结束'] }), 'UNKNOWN');
  assert.equal(classifyExam({ text: '开始考试', actions: ['开始考试'] }), 'OPEN');
  assert.equal(classifyExam({ text: '尚未开放', items: [] }), 'NOT_OPEN');
  assert.equal(classifyExam({ text: '尚未开放，另一个开始考试', actions: ['开始考试'] }), 'UNKNOWN');
  assert.equal(classifyExam({ text: '请先登录', actions: ['开始考试'] }), 'UNKNOWN');
  assert.equal(classifyExam({ text: '尚不可进入考试', actions: ['尚不可进入考试'] }), 'UNKNOWN');
  assert.equal(classifyExam(), 'UNKNOWN');
});
