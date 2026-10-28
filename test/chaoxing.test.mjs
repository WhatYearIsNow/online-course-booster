import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertId,
  buildPlazaUrl,
  buildQuizPlan,
  buildRunPlan,
  buildStudyUrl,
  classifyQuestionType,
  detectBlocked,
  parseClassifyIds,
  parseKnowledgeIds,
  parseQuizResult,
  parseScoreDetail,
  selectOptions,
  validateQuizPlan,
  validateRunPlan,
} from '../scripts/lib/chaoxing.mjs';

test('ID 校验拒绝非数字，防止页面表达式注入', () => {
  assert.equal(assertId('123', 'courseId'), '123');
  for (const value of ['', '0', '01', '1;alert(1)', ' 1', 1]) {
    assert.throws(() => assertId(value, 'courseId'), TypeError);
  }
});

test('广场与学习页 URL 只接受合法身份', () => {
  assert.equal(buildPlazaUrl('100', '200'), 'https://tsjy.chaoxing.com/plaza/?courseId=100&classId=200');
  assert.equal(buildPlazaUrl('100'), 'https://tsjy.chaoxing.com/plaza/?courseId=100');
  const url = buildStudyUrl({
    domain: 'https://mooc1-1.chaoxing.com',
    courseId: '100',
    classId: '200',
    chapterId: '300',
    enc: 'ABC123',
  });
  assert.match(url, /^https:\/\/mooc1-1\.chaoxing\.com\/mycourse\/transfer\?/);
  assert.ok(url.includes(encodeURIComponent('chapterId=300')));
  assert.throws(
    () =>
      buildStudyUrl({
        domain: 'https://evil.example',
        courseId: '1',
        classId: '2',
        chapterId: '3',
        enc: 'A',
      }),
    TypeError,
  );
  assert.throws(
    () =>
      buildStudyUrl({
        domain: 'https://mooc1-1.chaoxing.com',
        courseId: '1',
        classId: '2',
        chapterId: '3',
        enc: 'a b',
      }),
    TypeError,
  );
});

test('知识点与分类 ID 只从明确结构提取', () => {
  const html =
    '<a onclick="goKnowledge(1, 111)">a</a><a onclick="goKnowledge( 2 , 222 )">b</a><a onclick="goKnowledge(1, 111)">c</a>';
  assert.deepEqual(parseKnowledgeIds(html), ['111', '222']);
  assert.deepEqual(parseKnowledgeIds(null), []);
  assert.deepEqual(parseClassifyIds({ data: [{ id: 11 }, { classifyId: '22' }] }, 'x?classifyId=33'), [
    '11',
    '22',
    '33',
  ]);
});

test('积分接口只解析数据，缺失字段为 null', () => {
  const parsed = parseScoreDetail({
    data: {
      totalScore: 1,
      courseMinScore: 800,
      dayScore: 1,
      dailyMaxScore: null,
      items: [{ name: '答题', score: 0, rule: '2积分/答对1道', unitScore: 2, dailyMaxScore: null }],
    },
  });
  assert.equal(parsed.total, 1);
  assert.equal(parsed.min, 800);
  assert.equal(parsed.dailyMax, null);
  assert.deepEqual(parsed.items[0], {
    name: '答题',
    score: 0,
    rule: '2积分/答对1道',
    unitScore: 2,
    dailyMaxScore: null,
  });
  assert.equal(parseScoreDetail({}), null);
  assert.equal(parseScoreDetail(null), null);
});

test('题型识别与启发式选项只按题型，不读题干', () => {
  assert.equal(classifyQuestionType('【单选题】下列哪项正确'), 'single');
  assert.equal(classifyQuestionType('【多选题】以下正确的是'), 'multiple');
  assert.equal(classifyQuestionType('【判断题】这是对的'), 'judge');
  assert.equal(classifyQuestionType('没有题型标记'), 'unknown');
  assert.deepEqual(selectOptions('judge'), [0]);
  assert.deepEqual(selectOptions('single'), [0]);
  assert.deepEqual(selectOptions('multiple'), [0, 1]);
  assert.deepEqual(selectOptions('unknown'), []);
  assert.throws(() => selectOptions('single', 'smart'));
});

test('成绩与风控文本解析', () => {
  assert.deepEqual(parseQuizResult('本次成绩 8 分 已完成'), { done: true, score: 8 });
  assert.deepEqual(parseQuizResult('尚未提交'), { done: false, score: null });
  assert.equal(detectBlocked('请输入验证码'), 'captcha');
  assert.equal(detectBlocked('拖动滑块完成验证'), 'captcha');
  assert.equal(detectBlocked('题目：验证码的作用是什么'), null);
  assert.equal(detectBlocked('您的账号已在其他页面学习'), 'single-tab-conflict');
  assert.equal(detectBlocked('enc 校验失败'), 'enc-invalid');
  assert.equal(detectBlocked('正常题目'), null);
});

test('测评计划摘要绑定课程、章节与题目结构', () => {
  const plan = buildQuizPlan({
    courseId: '100',
    classId: '200',
    chapterId: '300',
    questions: [
      { type: 'single', options: 4 },
      { type: 'multiple', options: 5 },
    ],
  });
  assert.match(plan.digest, /^[a-f0-9]{64}$/);
  assert.equal(validateQuizPlan(plan, plan, plan.digest).chapterId, '300');
  assert.throws(() => validateQuizPlan(plan, plan, 'bad'), /digest mismatch/);
  const changed = { ...plan, questions: [{ type: 'single', options: 3 }] };
  assert.throws(() => validateQuizPlan(changed, changed, changed.digest), /digest mismatch/);
  assert.throws(() => validateQuizPlan({ ...plan, platform: 'other' }, plan, plan.digest), /unknown/);
});

test('批量计划摘要绑定目标与章节列表', () => {
  const plan = buildRunPlan({ courseId: '100', classId: '200', target: 800, chapters: ['1', '2'] });
  assert.equal(
    validateRunPlan(plan, { courseId: '100', classId: '200', chapters: ['1', '2'] }, plan.digest).target,
    800,
  );
  assert.throws(
    () => validateRunPlan(plan, { courseId: '100', classId: '200', chapters: ['1'] }, plan.digest),
    /changed/,
  );
  assert.throws(() => buildRunPlan({ courseId: '100', classId: '200', target: 0, chapters: [] }), /target/);
});
