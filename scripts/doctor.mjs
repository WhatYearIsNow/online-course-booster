#!/usr/bin/env node
/** Read-only, local-only connection diagnostics; safe to import without connecting. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect } from './cdp.mjs';

export const HELP = `Usage: node scripts/doctor.mjs [options]

  --endpoint <ws://loopback/...>  Explicit local CDP WebSocket endpoint
  --user-data-dir <directory>    Read DevToolsActivePort from this directory
  --expect-profile <name>        Report a profile requirement (CDP cannot verify it)
  --json                         Print a machine-readable report
  --help                         Show this help without opening a connection

Environment: CDP_ENDPOINT, CDP_RELAY_URL (explicit relay), CHROME_USER_DATA_DIR,
CDP_EXPECT_PROFILE. No browser or relay process is started. Node.js >= 22.15.
Reports omit raw page URLs, page titles, cookies, and local profile paths.
Exit: 0 = connection works; 1 = connection failed or requested profile unverified;
2 = invalid arguments. A working connection does not prove account identity.
`;

export function parseArgs(args) {
  const options = {};
  const valueFlags = new Map([
    ['--endpoint', 'endpoint'], ['--user-data-dir', 'userDataDir'], ['--expect-profile', 'expectProfile'],
  ]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (valueFlags.has(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      const key = valueFlags.get(arg);
      if (options[key] !== undefined) throw new Error(`Duplicate option ${arg}`);
      options[key] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function classify(url) {
  let hostname;
  try { hostname = new URL(url).hostname; } catch { return null; }
  for (const [name, domain] of [
    ['chaoxing', 'chaoxing.com'], ['icourse163', 'icourse163.org'], ['zhihuishu', 'zhihuishu.com'],
  ]) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) return name;
  }
  return null;
}

/** dependencies.connect is injected by tests. No subprocess, process scan, or raw data logging. */
export async function runDoctor(options = {}, dependencies = {}) {
  const connectImpl = dependencies.connect ?? connect;
  let client;
  const report = {
    ok: false, connection: { status: 'failed' },
    capabilities: { cdp: false, targetListing: false },
    profile: { status: 'not-requested' },
    platforms: { chaoxing: 0, icourse163: 0, zhihuishu: 0 },
    warnings: [],
  };
  try {
    client = await connectImpl(undefined, options);
    report.connection = { status: 'connected', ...client.connectionInfo };
    report.capabilities.cdp = true;
    report.profile = { ...(client.connectionInfo?.profile ?? { status: 'not-requested' }) };
    delete report.profile.expected;
    delete report.connection.profile;
    const pages = await client.targets();
    report.capabilities.targetListing = true;
    for (const page of pages) {
      const platform = classify(page.url);
      if (platform) report.platforms[platform]++;
    }
    report.ok = report.profile.status !== 'unverified';
    if (!report.ok) report.warnings.push('Requested profile cannot be verified from this CDP connection. Verify the account in the chosen course page.');
  } catch {
    // Browser/OS errors can contain raw endpoints, profile paths, titles or tokens.
    report.warnings.push('CDP connection or target listing failed. Check the explicit endpoint or DevToolsActivePort and browser permission.');
  } finally {
    try { client?.close(); } catch {}
  }
  return report;
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const log = dependencies.log ?? console.log;
  let options;
  try { options = parseArgs(args); } catch (error) { log(error.message); return 2; }
  if (options.help) { log(HELP); return 0; }
  const report = await runDoctor(options, dependencies);
  if (options.json) log(JSON.stringify(report, null, 2));
  else {
    log(`CDP connection: ${report.connection.status}`);
    log(`Capabilities: CDP=${report.capabilities.cdp}, target listing=${report.capabilities.targetListing}`);
    log(`Profile identity: ${report.profile.status}`);
    log(`Course platform pages: ${Object.entries(report.platforms).map(([name, count]) => `${name}=${count}`).join(', ')}`);
    for (const warning of report.warnings) log(`Warning: ${warning}`);
  }
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
