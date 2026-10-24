/** Explicit, local-only CDP configuration. No discovery outside the chosen directory. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function validateEndpoint(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error('CDP endpoint must be a local ws:// URL');
  }
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid CDP endpoint URL'); }
  if (!/^ws:\/\//i.test(value) || url.protocol !== 'ws:' || !LOOPBACK_HOSTS.has(url.hostname) || url.port === '0'
      || url.username || url.password || value.includes('?') || value.includes('#')
      || /[\s\\]/.test(value)) {
    throw new Error('CDP endpoint must use ws:// on localhost, 127.0.0.1, or [::1], without credentials, query, or fragment');
  }
  return url.href;
}

export function readDevToolsEndpoint(userDataDir, readFile = readFileSync) {
  const raw = readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8');
  const lines = raw.trim().split(/\r?\n/);
  if (lines.length !== 2 || !/^\d{1,5}$/.test(lines[0])
      || Number(lines[0]) < 1 || Number(lines[0]) > 65535
      || !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(lines[1])) {
    throw new Error('Invalid DevToolsActivePort: expected a port and /devtools/browser/<id>');
  }
  return validateEndpoint(`ws://127.0.0.1:${Number(lines[0])}${lines[1]}`);
}

export function resolveConnectionConfig(profileDir, opts = {}) {
  const env = opts.env ?? process.env;
  const explicitDir = opts.userDataDir ?? profileDir;
  const endpoint = opts.endpoint ?? (explicitDir === undefined ? env.CDP_ENDPOINT ?? env.CDP_RELAY_URL : undefined);
  const userDataDir = explicitDir ?? env.CHROME_USER_DATA_DIR;
  const expectProfile = opts.expectProfile ?? env.CDP_EXPECT_PROFILE ?? null;
  if (expectProfile !== null && (typeof expectProfile !== 'string' || !expectProfile.trim())) {
    throw new Error('expectProfile must be a non-empty string when provided');
  }
  if (endpoint !== undefined) {
    return {
      endpoint: validateEndpoint(endpoint), userDataDir: userDataDir ?? null, expectProfile,
      source: opts.endpoint !== undefined ? 'endpoint'
        : env.CDP_ENDPOINT !== undefined ? 'CDP_ENDPOINT' : 'CDP_RELAY_URL',
    };
  }
  if (typeof userDataDir !== 'string' || !userDataDir.trim()) {
    throw new Error('Specify --endpoint / CDP_ENDPOINT, or --user-data-dir / CHROME_USER_DATA_DIR');
  }
  return {
    endpoint: readDevToolsEndpoint(userDataDir, opts.readFile), userDataDir, expectProfile,
    source: 'DevToolsActivePort',
  };
}
