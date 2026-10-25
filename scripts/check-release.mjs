// Offline release preflight. Read only this project's explicitly controlled source tree.
// Heuristic secret checks complement human review; they cannot prove absence of secrets.
import { readFileSync, readdirSync, existsSync, lstatSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_FILES = new Set([
  'package.json', 'package-lock.json', 'SKILL.md', 'README.md', 'CHANGELOG.md',
  'CONTRIBUTING.md', 'SECURITY.md', 'LICENSE', 'LICENSE.md',
  '.gitignore', '.gitattributes', '.editorconfig', '.npmignore',
  '.prettierrc.json', '.prettierignore', 'maintenance.json', 'MAINTENANCE.md'
]);
const SOURCE_DIRS = new Set(['scripts', 'platforms', 'references', 'docs', 'examples', 'test', 'evals', '.github']);
const EXCLUDED_DIRS = new Set(['.git', '.local', 'node_modules', 'coverage', 'artifacts', '.artifacts', '.cache']);
const TEXT_EXTENSIONS = new Set(['.md', '.mjs', '.js', '.json', '.yml', '.yaml', '.txt']);
const PACK_ENTRIES = new Set([
  'SKILL.md', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'LICENSE', 'LICENSE.md', 'MAINTENANCE.md',
  'platforms/', 'references/', 'docs/', 'scripts/', 'examples/', 'test/', 'evals/'
]);

/** Return labels only, never matching source text or secret values. */
export function inspectText(text) {
  const rules = [
    ['personal absolute path', /(?:[A-Za-z]:[\\/]+(?:Users|Documents and Settings|Documents|Desktop|Downloads)[\\/]+(?!EXAMPLE(?:[\\/]|$)|USERNAME(?:[\\/]|$)|<|\$|%)[^\s<>"'`\\/]+|\/(?:Users|home)\/(?!example(?:\/|$)|<|\$)[^\s<>"'`/]+)/i],
    ['private key material', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['credential-shaped value', /(?:gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{30,}|Bearer\s+[A-Za-z0-9._~-]{30,})/],
    ['cookie or token assignment', /(?:NTESSTUDYSI|NTES_YD_PASSPORT|JSESSIONID|csrfToken|access[_-]?token|api[_-]?key)\s*[=:]\s*["']?(?!<|\$|process\.|SYNTHETIC|EXAMPLE)[A-Za-z0-9._%+/-]{24,}/i],
    ['personal course instance', /(?:\/(?:spoc\/|mooc\/)?learn\/[A-Za-z0-9]+-|[?&]tid=|--(?:course|term)\s+)[1-9]\d{6,}\b/]
  ];
  return rules.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

function withoutFences(markdown) {
  return markdown.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '');
}

function markdownLinks(markdown) {
  const text = withoutFences(markdown);
  const result = [];
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^\n]*["'])?\s*\)/g)) {
    result.push(match[1] || match[2]);
  }
  for (const match of text.matchAll(/^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm)) result.push(match[1] || match[2]);
  return result;
}

function headingAnchors(markdown) {
  const anchors = new Set(), counts = new Map();
  for (const match of withoutFences(markdown).matchAll(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/gm)) {
    const heading = match[1].replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '');
    const base = heading.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-');
    const count = counts.get(base) || 0;
    counts.set(base, count + 1);
    anchors.add(count ? `${base}-${count}` : base);
  }
  for (const match of markdown.matchAll(/\bid=["']([^"']+)["']/g)) anchors.add(match[1]);
  return anchors;
}

function inside(root, target) {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Run without browser, npm registry access, or reading a user's profiles/cookies. */
export function checkRelease(root) {
  root = resolve(root);
  const issues = [], source = new Map();
  const report = (path, message) => issues.push({ path, message });
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const path = relative(root, absolute).split(sep).join('/');
      if (entry.isSymbolicLink()) { report(path, 'symbolic links are not release source'); continue; }
      if (entry.isDirectory()) { visit(absolute); continue; }
      if (!entry.isFile()) { report(path, 'unsupported filesystem entry'); continue; }
      if (!TEXT_EXTENSIONS.has(extname(entry.name)) && !ROOT_FILES.has(path)) {
        report(path, 'unreviewed file type'); continue;
      }
      source.set(path, readFileSync(absolute, 'utf8'));
    }
  };
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = resolve(root, entry.name);
    if (entry.isSymbolicLink()) { report(entry.name, 'symbolic links are not release source'); continue; }
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    if (entry.isDirectory() && SOURCE_DIRS.has(entry.name)) visit(absolute);
    else if (entry.isFile() && ROOT_FILES.has(entry.name)) source.set(entry.name, readFileSync(absolute, 'utf8'));
    else report(entry.name, 'unreviewed path outside the source allowlist');
  }
  for (const [path, text] of source) {
    for (const label of inspectText(text)) report(path, label);
    if (!path.endsWith('.md')) continue;
    for (const link of markdownLinks(text)) {
      if (/^(?:https?:|mailto:)/i.test(link)) continue; // External availability is not checked offline.
      if (/^[A-Za-z][\w+.-]*:/.test(link)) { report(path, 'unsupported link scheme'); continue; }
      let decoded;
      try { decoded = decodeURIComponent(link); } catch { report(path, 'invalid URL encoding in link'); continue; }
      const [local, anchor] = decoded.split('#');
      const target = resolve(root, dirname(path), (local || '').split('?')[0]);
      const actual = local ? target : resolve(root, path);
      if (!inside(root, actual)) { report(path, 'link escapes release source'); continue; }
      // Avoid following a link into an excluded/uncontrolled file, including through symlinks.
      const targetPath = relative(root, actual).split(sep).join('/');
      if (!source.has(targetPath)) {
        if (!existsSync(actual) || !lstatSync(actual).isDirectory()) report(path, `missing local link: ${link}`);
        else if (!SOURCE_DIRS.has(targetPath.split('/')[0])) report(path, 'link points outside controlled source');
      } else if (anchor && actual.endsWith('.md') && !headingAnchors(source.get(targetPath)).has(anchor)) {
        report(path, `missing Markdown anchor: ${link}`);
      }
    }
  }
  let manifest;
  try { manifest = JSON.parse(source.get('package.json')); }
  catch { report('package.json', 'missing or invalid manifest'); }
  if (manifest) {
    if (!Array.isArray(manifest.files) || !manifest.files.length) report('package.json', 'explicit files allowlist required');
    else {
      for (const entry of manifest.files) {
        if (!PACK_ENTRIES.has(entry)) report('package.json', 'package.files contains an unreviewed entry');
        else if (!existsSync(resolve(root, entry))) report('package.json', `missing package entry: ${entry}`);
      }
    }
    if (manifest.scripts?.prepublishOnly !== 'npm run check') report('package.json', 'prepublishOnly must run npm run check');
    if (manifest.bundledDependencies || manifest.bundleDependencies) report('package.json', 'bundled dependencies require explicit review');
  }
  return { ok: issues.length === 0, filesChecked: source.size, issues };
}

const filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === filename) {
  const result = checkRelease(fileURLToPath(new URL('../', import.meta.url)));
  for (const issue of result.issues) console.error(`${issue.path}: ${issue.message}`);
  console.log(`Release preflight ${result.ok ? 'PASS' : 'FAIL'}: ${result.filesChecked} source files; ${result.issues.length} issues.`);
  process.exitCode = result.ok ? 0 : 1;
}
