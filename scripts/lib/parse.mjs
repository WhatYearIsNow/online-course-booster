// Pure protocol helpers. No browser, network access, eval, or executable response code.

const DECIMAL = /^[1-9]\d*$/;

function positiveInteger(value) {
  if (typeof value === 'string' && !DECIMAL.test(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** Parse an HTTPS learning URL on either exact official host. Query tid is optional. */
export function parseCourseUrl(value) {
  if (typeof value !== 'string' || value !== value.trim() || /[\u0000-\u0020\\]/u.test(value)) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (value.match(/^https:\/\/([^/?#]+)/i)?.[1].includes('@')) return null;
  if (
    url.protocol !== 'https:' ||
    !['icourse163.org', 'www.icourse163.org'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  )
    return null;
  const rawPath = value.match(/^https:\/\/[^/?#]+([^?#]*)/i)?.[1] || '';
  if (rawPath !== url.pathname) return null;
  const match = url.pathname.match(/^\/((?:spoc|mooc)\/)?learn\/([A-Za-z0-9]+)-([1-9]\d*)(?:\/content)?\/?$/);
  if (!match) return null;
  const tids = url.searchParams.getAll('tid');
  if (tids.length > 1 || (tids.length && !DECIMAL.test(tids[0]))) return null;
  return { prefix: match[1] || '', school: match[2], courseId: match[3], termId: tids[0] ?? null };
}

/** Reject JS coercion of booleans/arrays/exponent strings, and unsafe numeric IDs. */
export function normalizeReply(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const pid = positiveInteger(item.pid);
  if (pid === null || typeof item.html !== 'string' || !item.html.trim()) return null;
  // Input shape validation is not an HTML sanitizer. Content preview remains required.
  return { pid, html: item.html };
}

function sessionValue(value, name) {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f\u0085\u2028\u2029]/u.test(value)) {
    throw new TypeError(`${name} must be a non-empty string without whitespace or control characters`);
  }
  return value;
}

/** Build line-oriented DWR data; batchId can be injected for correlation and tests. */
export function buildDwrBody({ pid, html, httpSessionId, scriptSessionId, batchId = Date.now() }) {
  const reply = normalizeReply({ pid, html });
  if (!reply) throw new TypeError('pid must be a safe positive integer and html a non-empty string');
  const batch = positiveInteger(batchId);
  if (batch === null) throw new TypeError('batchId must be a safe positive integer');
  return [
    'callCount=1',
    'scriptSessionId=' + sessionValue(scriptSessionId, 'scriptSessionId'),
    'httpSessionId=' + sessionValue(httpSessionId, 'httpSessionId'),
    'c0-scriptName=MocForumBean',
    'c0-methodName=addReply',
    'c0-id=0',
    'c0-e1=number:' + reply.pid,
    'c0-e2=string:' + encodeURIComponent(reply.html),
    'c0-e3=number:0',
    'c0-param0=Object_Object:{postId:reference:c0-e1,content:reference:c0-e2,anonymous:reference:c0-e3}',
    'c0-param1=Array:[]',
    'batchId=' + batch,
  ].join('\n');
}

// DWR is JavaScript-shaped data. Read only this small grammar; never run it.
// Treating strings/comments as tokens prevents content from impersonating calls.
function tokenize(source) {
  const tokens = [];
  let i = 0;
  const fail = () => {
    throw new Error('invalid DWR syntax');
  };
  while (i < source.length) {
    const char = source[i];
    if (/\s/u.test(char)) {
      i++;
      continue;
    }
    if (source.startsWith('//', i)) {
      while (i < source.length && !/[\r\n\u2028\u2029]/u.test(source[i])) i++;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) fail();
      i = end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let value = '',
        closed = false;
      i++;
      while (i < source.length) {
        const next = source[i++];
        if (next === quote) {
          closed = true;
          break;
        }
        if (/[\r\n\u2028\u2029]/u.test(next)) fail();
        if (next !== '\\') {
          value += next;
          continue;
        }
        if (i >= source.length) fail();
        const escaped = source[i++];
        const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
        if (escaped === 'x' || escaped === 'u') {
          const size = escaped === 'x' ? 2 : 4;
          const hex = source.slice(i, i + size);
          if (!new RegExp(`^[0-9a-fA-F]{${size}}$`).test(hex)) fail();
          value += String.fromCharCode(parseInt(hex, 16));
          i += size;
        } else if (escaped === '\r' || escaped === '\n') {
          if (escaped === '\r' && source[i] === '\n') i++;
        } else if (Object.hasOwn(simple, escaped)) {
          if (escaped === '0' && /[0-9]/.test(source[i] || '')) fail();
          value += simple[escaped];
        } else if (escaped === '\\' || escaped === '"' || escaped === "'" || escaped === '/')
          value += escaped;
        else fail();
      }
      if (!closed) fail();
      tokens.push({ type: 'string', value });
    } else {
      const number = source.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      const identifier = source.slice(i).match(/^[A-Za-z_$][\w$]*/);
      if (number) {
        const value = Number(number[0]);
        if (!Number.isFinite(value)) fail();
        tokens.push({ type: 'number', value });
        i += number[0].length;
      } else if (identifier) {
        tokens.push({ type: 'identifier', value: identifier[0] });
        i += identifier[0].length;
      } else if ('{}[]():;,=.'.includes(char)) {
        tokens.push({ type: 'punctuation', value: char });
        i++;
      } else fail();
    }
    if (tokens.length > 100_000) fail();
  }
  return tokens;
}

function readDwr(source) {
  const tokens = tokenize(source);
  const variables = new Map(),
    calls = [];
  let position = 0;
  const peek = () => tokens[position];
  const matches = (token, value) =>
    token?.value === value && token.type === ('{}[]():;,=.'.includes(value) ? 'punctuation' : 'identifier');
  const take = (value) => {
    const token = tokens[position++];
    if (!token || (value !== undefined && !matches(token, value))) throw new Error('invalid DWR syntax');
    return token;
  };
  const maybe = (value) => {
    if (!matches(peek(), value)) return false;
    position++;
    return true;
  };
  const key = () => {
    const token = take();
    if (
      !['identifier', 'string', 'number'].includes(token.type) ||
      ['__proto__', 'constructor', 'prototype'].includes(String(token.value))
    )
      throw new Error('invalid property');
    return token.value;
  };
  const value = (depth = 0) => {
    if (depth > 64) throw new Error('DWR nesting limit');
    const token = take();
    if (token.type === 'number' || token.type === 'string') return token.value;
    if (token.value === 'null' || token.value === 'undefined') return null;
    if (token.value === 'true') return true;
    if (token.value === 'false') return false;
    if (token.value === '{') {
      const object = Object.create(null);
      if (!maybe('}')) {
        do {
          const name = key();
          take(':');
          if (Object.hasOwn(object, name)) throw new Error('duplicate DWR property');
          object[name] = value(depth + 1);
        } while (maybe(','));
        take('}');
      }
      return object;
    }
    if (token.value === '[') {
      const array = [];
      if (!maybe(']')) {
        do {
          array.push(value(depth + 1));
        } while (maybe(','));
        take(']');
      }
      return array;
    }
    if (token.value === 'new') {
      // Common DWR dates remain inert data; do not instantiate response objects.
      take('Date');
      take('(');
      const timestamp = take();
      if (timestamp.type !== 'number') throw new Error('invalid DWR date');
      take(')');
      return { timestamp: timestamp.value };
    }
    if (token.type === 'identifier' && variables.has(token.value)) return variables.get(token.value);
    throw new Error('unsupported DWR value');
  };
  while (position < tokens.length) {
    if (maybe(';')) continue;
    if (maybe('throw')) throw new Error('DWR exception');
    if (maybe('var')) {
      do {
        const name = take();
        if (name.type !== 'identifier' || !/^s\d+$/.test(name.value) || variables.has(name.value))
          throw new Error('invalid DWR variable');
        take('=');
        variables.set(name.value, value());
      } while (maybe(','));
    } else {
      const root = take();
      if (root.type !== 'identifier') throw new Error('unsupported DWR statement');
      const path = [];
      while (true) {
        if (maybe('.')) path.push(key());
        else if (maybe('[')) {
          path.push(key());
          take(']');
        } else break;
      }
      if (maybe('=')) {
        if (!variables.has(root.value) || !path.length) throw new Error('invalid DWR assignment');
        let target = variables.get(root.value);
        for (const part of path.slice(0, -1)) target = target?.[part];
        if (!target || typeof target !== 'object') throw new Error('invalid DWR assignment');
        const name = path.at(-1);
        if (Array.isArray(target) && (!/^\d+$/.test(String(name)) || Number(name) > 100_000)) {
          throw new Error('invalid DWR array index');
        }
        if (Object.hasOwn(target, name)) throw new Error('duplicate DWR assignment');
        target[name] = value();
      } else {
        const name = [root.value, ...path].join('.');
        if (!/^(?:dwr\.engine\.)?_remoteHandle(?:Callback|Exception|BatchException)$/.test(name)) {
          throw new Error('unsupported DWR call');
        }
        take('(');
        const args = [];
        if (!maybe(')')) {
          do {
            args.push(value());
          } while (maybe(','));
          take(')');
        }
        // A callback observes the payload at call time, before any later assignment.
        if (args[2] && typeof args[2] === 'object' && !Array.isArray(args[2])) args[2] = { ...args[2] };
        calls.push({ name: name.split('.').at(-1), args });
      }
    }
    if (position < tokens.length && !maybe(';')) throw new Error('missing DWR separator');
  }
  return calls;
}

/**
 * Read supported DWR data without running JavaScript. Pass request batchId in production.
 * Legacy single-argument calls accept exactly one callback for call 0.
 * Only the callback payload's own top-level numeric id can be the reply ID.
 */
export function parseDwrResponse(response, { batchId, callId = 0 } = {}) {
  if (typeof response !== 'string' || !response.trim()) return { ok: false, reason: 'empty response' };
  if (response.length > 2_000_000) return { ok: false, reason: 'DWR response too large' };
  try {
    const calls = readDwr(response);
    const selected = calls.filter(({ name, args }) => {
      if (!['string', 'number'].includes(typeof args[0]) || !['string', 'number'].includes(typeof args[1])) {
        return (
          name === '_remoteHandleBatchException' &&
          ['string', 'number'].includes(typeof args[0]) &&
          (batchId === undefined || String(args[0]) === String(batchId))
        );
      }
      if (batchId !== undefined && String(args[0]) !== String(batchId)) return false;
      return name === '_remoteHandleBatchException' || String(args[1]) === String(callId);
    });
    if (selected.length !== 1) return { ok: false, reason: 'missing or ambiguous DWR callback' };
    const { name, args } = selected[0];
    if (name !== '_remoteHandleCallback') return { ok: false, reason: 'DWR exception' };
    const payload = args[2];
    if (args.length !== 3 || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, reason: 'invalid DWR callback payload' };
    }
    if (Object.hasOwn(payload, 'javaClassName')) return { ok: false, reason: 'DWR exception' };
    if (
      !Object.hasOwn(payload, 'id') ||
      typeof payload.id !== 'number' ||
      positiveInteger(payload.id) === null
    ) {
      return { ok: false, reason: 'missing or invalid reply id' };
    }
    return { ok: true, replyId: payload.id };
  } catch (error) {
    return {
      ok: false,
      reason: error.message === 'DWR exception' ? 'DWR exception' : 'unsupported or invalid DWR response',
    };
  }
}
