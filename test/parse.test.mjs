import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCourseUrl, normalizeReply, buildDwrBody, parseDwrResponse } from '../scripts/lib/parse.mjs';
import { inspectText, checkRelease } from '../scripts/check-release.mjs';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// All IDs, sessions, and response bodies in this suite are synthetic.
for (const prefix of ['', 'spoc/', 'mooc/']) {
  for (const host of ['icourse163.org', 'www.icourse163.org']) {
    for (const suffix of ['', '/', '/content', '/content/']) {
      test(`URL accepts ${host}/${prefix}learn + ${suffix || 'empty suffix'}`, () => {
        assert.deepEqual(
          parseCourseUrl(`https://${host}/${prefix}learn/EXAMPLE-123456${suffix}?tid=654321#/learn/content`),
          {
            prefix,
            school: 'EXAMPLE',
            courseId: '123456',
            termId: '654321',
          },
        );
      });
    }
  }
}

test('URL tid is optional, comes only from query, and IDs remain strings', () => {
  assert.deepEqual(parseCourseUrl('https://www.icourse163.org/learn/E1-123456#/learn/content?tid=999'), {
    prefix: '',
    school: 'E1',
    courseId: '123456',
    termId: null,
  });
  assert.equal(parseCourseUrl('https://www.icourse163.org/learn/E1-123456?tid=654321&x=1').termId, '654321');
});

for (const invalid of [
  null,
  123,
  {},
  '',
  '/learn/EXAMPLE-123456',
  'http://www.icourse163.org/learn/EXAMPLE-123456',
  'https://icourse163.org.evil.test/learn/EXAMPLE-123456',
  'https://evil.test/icourse163.org/learn/EXAMPLE-123456',
  'https://icourse163.org@evil.test/learn/EXAMPLE-123456',
  'https://user@icourse163.org/learn/EXAMPLE-123456',
  'https://@icourse163.org/learn/EXAMPLE-123456',
  'https://icourse163.org:9443/learn/EXAMPLE-123456',
  'https://icourse163.org./learn/EXAMPLE-123456',
  'https://icourse163.org/learn/EXAMPLE-123456extra',
  'https://icourse163.org/learn/EXAMPLE-123456/other',
  'https://icourse163.org/learn/EXAMPLE-0',
  'https://icourse163.org/learn/EXAMPLE-0123',
  'https://icourse163.org/learn/EXAMPLE-',
  'https://icourse163.org/learn/EXAMPLE-123456?tid=',
  'https://icourse163.org/learn/EXAMPLE-123456?tid=1e3',
  'https://icourse163.org/learn/EXAMPLE-123456?tid=1&tid=1',
  'https://icourse163.org/learn/EXAMPLE-123456?tid=1&%74id=2',
  'https://icourse163.org/learn/EXAMPLE-123456?tid=-1',
  'https://icourse163.org/other/../learn/EXAMPLE-123456',
  'https://icourse163.org/learn%2fEXAMPLE-123456',
  'https://icourse163.org\\learn\\EXAMPLE-123456',
  ' https://icourse163.org/learn/EXAMPLE-123456',
  'https://icourse163.org/learn/EXAMPLE-123456\n',
  'https://icourse163.org/learn/EXAMPLE-123456?tid=1\t2',
]) {
  test(`URL rejects ${JSON.stringify(invalid)}`, () => assert.equal(parseCourseUrl(invalid), null));
}

test('normalizeReply preserves intended HTML and canonicalizes decimal PID', () => {
  assert.deepEqual(normalizeReply({ pid: '123456', html: ' <p>你好 &amp; hello</p> ' }), {
    pid: 123456,
    html: ' <p>你好 &amp; hello</p> ',
  });
  assert.equal(normalizeReply({ pid: Number.MAX_SAFE_INTEGER, html: 'text' }).pid, Number.MAX_SAFE_INTEGER);
});

for (const pid of [
  true,
  false,
  [],
  [1],
  {},
  null,
  undefined,
  0,
  -1,
  1.5,
  NaN,
  Infinity,
  ' 1',
  '1 ',
  '+1',
  '01',
  '1e3',
  '1.0',
  '0x20',
  '',
  '9007199254740992',
  Number.MAX_SAFE_INTEGER + 1,
]) {
  test(`normalizeReply rejects PID ${String(pid)}`, () =>
    assert.equal(normalizeReply({ pid, html: '<p>x</p>' }), null));
}

test('normalizeReply rejects invalid objects and empty HTML', () => {
  for (const item of [null, [], {}, { pid: 1, html: '' }, { pid: 1, html: ' \n ' }, { pid: 1, html: 5 }]) {
    assert.equal(normalizeReply(item), null);
  }
});

const bodyInput = {
  pid: 123456,
  html: '<p>你好\n=hello & 🚀</p>',
  httpSessionId: 'SYNTHETIC_HTTP',
  scriptSessionId: 'SYNTHETIC_SCRIPT',
  batchId: 654321,
};

test('DWR body is deterministic, correlated, and encodes only HTML as a single value', () => {
  const body = buildDwrBody(bodyInput);
  const lines = body.split('\n');
  assert.equal(lines.length, 12);
  assert.ok(lines.includes('batchId=654321'));
  assert.ok(lines.includes('c0-e1=number:123456'));
  assert.ok(lines.includes('httpSessionId=SYNTHETIC_HTTP'));
  assert.ok(lines.includes('scriptSessionId=SYNTHETIC_SCRIPT'));
  assert.equal(
    decodeURIComponent(lines.find((line) => line.startsWith('c0-e2=string:')).slice(13)),
    bodyInput.html,
  );
});

for (const name of ['httpSessionId', 'scriptSessionId']) {
  for (const value of [
    '',
    null,
    123,
    'X\ncallCount=2',
    'X\rcallCount=2',
    'X\0Y',
    'X\tY',
    'X Y',
    'X\u2028Y',
  ]) {
    test(`DWR body rejects ${name} with ${JSON.stringify(value)}`, () => {
      assert.throws(() => buildDwrBody({ ...bodyInput, [name]: value }), TypeError);
    });
  }
}

test('DWR body rejects invalid reply and batch values without echoing secrets', () => {
  assert.throws(() => buildDwrBody({ ...bodyInput, pid: true }), /pid/);
  assert.throws(() => buildDwrBody({ ...bodyInput, html: ' ' }), /html/);
  for (const batchId of [0, true, '1e3', '1\ncallCount=2', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => buildDwrBody({ ...bodyInput, batchId }), /batchId/);
  }
  assert.throws(
    () => buildDwrBody({ ...bodyInput, httpSessionId: 'SECRET\nVALUE' }),
    (error) => !error.message.includes('SECRET'),
  );
});

const callback = (payload) => `dwr.engine._remoteHandleCallback('654321','0',${payload});`;
const correlated = (response) => parseDwrResponse(response, { batchId: 654321 });

test('DWR accepts inline object, escaped strings, dates and comments', () => {
  const response = `//#DWR-REPLY\n/* harmless */ ${callback('{id:123456,content:"quote: \\"; javaClassName: bad; throw x;",created:new Date(123)}')}`;
  assert.deepEqual(correlated(response), { ok: true, replyId: 123456 });
  assert.deepEqual(parseDwrResponse('_remoteHandleCallback("c0",0,{id:123456})'), {
    ok: true,
    replyId: 123456,
  });
  assert.deepEqual(correlated(callback('{"id":123456,content:"\\u4f60\\u597d\\x21"}')), {
    ok: true,
    replyId: 123456,
  });
});

test('DWR supports variable object graph without evaluating JavaScript', () => {
  const response = `var s0={};var s1=[];var s2={id:1};s1[0]=s2;s0.id=123456;s0.children=s1;s0.content='example';dwr.engine._remoteHandleCallback('654321','0',s0);`;
  assert.deepEqual(correlated(response), { ok: true, replyId: 123456 });
});

test('DWR string and comment contents cannot impersonate protocol structure', () => {
  const injected = String.raw`text \\"; _remoteHandleCallback('654321','0',{id:999}); javaClassName: evil; throw 'bad';`;
  assert.deepEqual(correlated(callback(JSON.stringify({ id: 123456, content: injected }))), {
    ok: true,
    replyId: 123456,
  });
  assert.equal(correlated('/* ' + callback('{id:123456}') + ' */').ok, false);
  assert.equal(correlated(`var s0=${JSON.stringify(callback('{id:123456}'))};`).ok, false);
  assert.equal(correlated(callback('{content:"id:123456"}')).ok, false);
  assert.equal(correlated(callback('{post:{id:123456}}')).ok, false);
});

test('DWR correlates exact batch/call and fails ambiguity', () => {
  assert.equal(parseDwrResponse(callback('{id:123456}'), { batchId: 1 }).ok, false);
  assert.equal(parseDwrResponse(callback('{id:123456}'), { batchId: 654321, callId: 1 }).ok, false);
  assert.equal(correlated(callback('{id:1}') + callback('{id:2}')).ok, false);
  assert.deepEqual(
    correlated(`dwr.engine._remoteHandleCallback('1','0',{id:2});${callback('{id:123456}')}`),
    { ok: true, replyId: 123456 },
  );
  assert.equal(
    parseDwrResponse(`dwr.engine._remoteHandleCallback('1','0',{id:2});${callback('{id:123456}')}`).ok,
    false,
  );
  assert.equal(correlated("dwr.engine._remoteHandleCallback([654321],'0',{id:123456});").ok, false);
  assert.equal(correlated("dwr.engine._remoteHandleCallback('654321',[0],{id:123456});").ok, false);
  assert.equal(
    correlated("var s0={};dwr.engine._remoteHandleCallback('654321','0',s0);s0.id=123456;").ok,
    false,
  );
});

for (const payload of [
  'null',
  '[]',
  'true',
  '123456',
  '"id:123456"',
  '{}',
  '{id:0}',
  '{id:-1}',
  '{id:1.5}',
  '{id:9007199254740992}',
  '{id:"123456"}',
  '{id:123456,id:999}',
  '{id:123456,javaClassName:"Exception"}',
  '{id:123456,__proto__:{}}',
]) {
  test(`DWR rejects payload ${payload}`, () => assert.equal(correlated(callback(payload)).ok, false));
}

test('DWR recognizes actual exception statements/calls without echoing response data', () => {
  for (const response of [
    "throw 'SECRET';",
    "dwr.engine._remoteHandleException('654321','0',{message:'SECRET'});",
    "dwr.engine._remoteHandleBatchException('654321',{message:'SECRET'});",
  ]) {
    const result = correlated(response);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'DWR exception');
    assert.ok(!result.reason.includes('SECRET'));
  }
});

test('DWR rejects executable and malformed syntax and leaves global state untouched', () => {
  for (const response of [
    `${callback('{id:123456}')}globalThis.__dwrExecuted=true;`,
    callback('{id:(globalThis.__dwrExecuted=true)}'),
    callback('{id:123456,content:evil()}'),
    callback('{id:123456,content:`template`}'),
    "evil._remoteHandleCallback('654321','0',{id:123456});",
    "var s0={};s0['__proto__']={};" + callback('s0'),
    'var s0={};s0.id=123456;s0.id=999;' + callback('s0'),
    '/* unterminated',
    callback('{id:123456,content:"unterminated}'),
    callback('{id:123456,content:"\\uXXXX"}'),
    callback('{id:123456,content:Infinity}'),
    callback('{id ":" 123456}'),
    '";";' + callback('{id:123456}'),
    'var dwr={};' + callback('{id:123456}'),
    callback('{id:123456}') + '\nthrow "bad";',
  ])
    assert.equal(correlated(response).ok, false, response);
  assert.equal(globalThis.__dwrExecuted, undefined);
});

test('DWR bounds response size and nesting', () => {
  assert.equal(correlated('x'.repeat(2_000_001)).ok, false);
  assert.equal(
    correlated(callback('{id:123456,items:' + '['.repeat(70) + '0' + ']'.repeat(70) + '}')).ok,
    false,
  );
  for (const value of ['', ' ', null, 1, {}]) assert.equal(correlated(value).ok, false);
});

test('release text inspection catches path/credential/course leaks without exposing values', () => {
  const personalPath = ['C:', 'Users', 'private-person', 'profile'].join('\\');
  const secret = 'NTESSTUDYSI=' + 'a'.repeat(32);
  const key = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  const course = 'https://www.icourse163.org/learn/EXAMPLE-' + '1234567890';
  const token = 'ghp_' + 'a'.repeat(35);
  assert.deepEqual(inspectText(personalPath), ['personal absolute path']);
  assert.deepEqual(inspectText(['D:', 'Documents', 'private-studies'].join('\\')), [
    'personal absolute path',
  ]);
  assert.deepEqual(inspectText(secret), ['cookie or token assignment']);
  assert.deepEqual(inspectText(key), ['private key material']);
  assert.deepEqual(inspectText(course), ['personal course instance']);
  assert.deepEqual(inspectText(token), ['credential-shaped value']);
  assert.deepEqual(inspectText('NTESSTUDYSI=<cookie>; example course /learn/EXAMPLE-123456?tid=654321'), []);
});

function releaseFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'online-course-release-test-'));
  // The exact temporary target is verified before registering recursive cleanup.
  assert.equal(dirname(root), resolve(tmpdir()));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ files: ['README.md', 'docs/'], scripts: { prepublishOnly: 'npm run check' } }),
  );
  writeFileSync(join(root, 'README.md'), '# Start\n\n[Guide](docs/guide.md#details)\n');
  writeFileSync(join(root, 'docs', 'guide.md'), '# Guide\n\n## Details\n\n[Home](../README.md#start)\n');
  return root;
}

test('release preflight accepts a self-contained, explicitly packaged source tree', (t) => {
  const result = checkRelease(releaseFixture(t));
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  assert.equal(result.filesChecked, 3);
});

test('release preflight catches missing files, anchors, and source escape links', (t) => {
  const root = releaseFixture(t);
  writeFileSync(
    join(root, 'README.md'),
    '# Start\n\n[x](docs/missing.md) [y](docs/guide.md#missing) [z](../outside.md)\n',
  );
  const result = checkRelease(root);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.message.includes('missing local link')));
  assert.ok(result.issues.some((issue) => issue.message.includes('missing Markdown anchor')));
  assert.ok(result.issues.some((issue) => issue.message.includes('escapes release source')));
});

test('release preflight rejects unreviewed root paths and package globs', (t) => {
  const root = releaseFixture(t);
  writeFileSync(join(root, 'session.json'), '{}');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ files: ['**/*'], scripts: { prepublishOnly: 'npm run check' } }),
  );
  const result = checkRelease(root);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.path === 'session.json'));
  assert.ok(result.issues.some((issue) => issue.message.includes('unreviewed entry')));
});

test('release preflight ignores code-fence links and excluded generated directories', (t) => {
  const root = releaseFixture(t);
  writeFileSync(join(root, 'README.md'), '# Start\n\n```md\n[not a link](nonexistent.md)\n```\n');
  for (const directory of ['artifacts', '.local']) {
    mkdirSync(join(root, directory));
    writeFileSync(join(root, directory, 'private.json'), JSON.stringify({ private: true }));
  }
  assert.equal(checkRelease(root).ok, true);
});
