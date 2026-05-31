'use strict';

/**
 * generate({root, out, concurrency}) → writes graphData JSON to `out`.
 *
 * Walks every tracked `.md` file in `root` (via `git ls-files`), extracts
 * internal cross-references (standard markdown links, wiki-links,
 * @-includes, backtick-wrapped relative paths), and tallies the top-3
 * contributors per file via `git log`. Output shape:
 *
 *   {
 *     nodes: [{id, label, path, contributors: [{name, commits, color}, …]}],
 *     links: [{source, target}],
 *     meta:  {generatedAt, nodeCount, linkCount, contributorCount, palette}
 *   }
 *
 * Pure-ish: no CLI, no process.exit. Returns a stats object.
 */

const fs = require('fs');
const path = require('path');
const {execFileSync, execFile} = require('child_process');
const {promisify} = require('util');

const execFileAsync = promisify(execFile);

// ---------- filename filters / patterns ----------

const SKIP_BASENAME_RE = /^changelog\.md$/i;

const MD_LINK_RE = /\[([^\]\n]+)\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g;
const WIKI_LINK_RE = /\[\[([^\]\n|]+?)(?:\|[^\]\n]+)?\]\]/g;
// Claude Code / Agent SDK `@path/to/file.md` include syntax.
const AT_LINK_RE = /(?<![\w/])@([./\w][\w./-]*\.md)\b/g;
// Backtick-wrapped relative path refs (`docs/setup.md`). Require at least
// one `/` so bare basenames in backticks (`README.md`) — usually nouns —
// don't create false-positive edges.
const BACKTICK_PATH_RE = /`([./\w][\w./-]*\/[\w./-]+\.md)`/g;

const toPosix = p => p.split(path.sep).join('/');

// ---------- helpers ----------

function listTrackedMarkdown(root) {
  const raw = execFileSync('git', ['ls-files', '-z', '*.md'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return raw
    .split('\0')
    .filter(Boolean)
    .map(toPosix)
    .filter(p => !SKIP_BASENAME_RE.test(path.basename(p)))
    .sort();
}

function stripFences(md) {
  return md.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '');
}

function stripInlineCode(md) {
  return md.replace(/`[^`\n]*`/g, '');
}

function extractLinks(raw) {
  const noFences = stripFences(raw);
  const stripped = stripInlineCode(noFences);
  const out = [];
  let m;
  for (const [re, kind, group, source] of [
    [MD_LINK_RE, 'md', 2, stripped],
    [WIKI_LINK_RE, 'wiki', 1, stripped],
    [AT_LINK_RE, 'md', 1, stripped],
    [BACKTICK_PATH_RE, 'md', 1, noFences],
  ]) {
    re.lastIndex = 0;
    while ((m = re.exec(source))) out.push({raw: m[group].trim(), kind});
  }
  return out;
}

function resolveLink(link, fromFile, fileSet, basenameIndex, root) {
  const {raw, kind} = link;
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  if (raw.startsWith('#')) return null;
  let target = raw.split('#')[0].split('?')[0].trim();
  if (!target) return null;
  try {
    target = decodeURI(target);
  } catch {
    /* malformed URI — keep as-is */
  }
  if (kind === 'wiki') {
    for (const c of [target, `${target}.md`]) {
      const hit = basenameIndex.get(c.toLowerCase());
      if (hit) return hit;
    }
    return null;
  }
  const fromAbs = path.resolve(root, fromFile);
  const resolved = target.startsWith('/')
    ? path.resolve(root, target.replace(/^\/+/, ''))
    : path.resolve(path.dirname(fromAbs), target);
  const candidates = [resolved];
  if (!/\.md$/i.test(resolved)) {
    candidates.push(`${resolved}.md`);
    candidates.push(path.join(resolved, 'index.md'));
  }
  for (const c of candidates) {
    const rel = toPosix(path.relative(root, c));
    if (fileSet.has(rel)) return rel;
  }
  return null;
}

// ---------- contributor resolution ----------

function canonicalName(names) {
  const candidates = [...names];
  const score = n => {
    let s = 0;
    if (/\s/.test(n)) s += 4; // looks like "First Last"
    if (/^[A-Z]/.test(n)) s += 2; // proper-noun capitalization
    if (!/\[bot\]$/i.test(n)) s += 1;
    s += Math.min(n.length, 30) / 100;
    return s;
  };
  candidates.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
  return candidates[0];
}

async function topContributors(file, root) {
  let stdout = '';
  try {
    // %aE / %aN are mailmap-aware.
    const r = await execFileAsync('git', ['log', '--format=%aE%x09%aN', '--', file], {
      cwd: root,
      maxBuffer: 8 * 1024 * 1024,
    });
    stdout = r.stdout;
  } catch {
    return [];
  }
  const byEmail = new Map();
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const email = line.slice(0, tab).trim().toLowerCase();
    const name = line.slice(tab + 1).trim();
    if (!email || !name) continue;
    let entry = byEmail.get(email);
    if (!entry) {
      entry = {commits: 0, names: new Set()};
      byEmail.set(email, entry);
    }
    entry.commits++;
    entry.names.add(name);
  }
  // Collapse multiple emails that share the same canonical name (same human,
  // multiple addresses).
  const byName = new Map();
  for (const [, entry] of byEmail) {
    const name = canonicalName(entry.names);
    const m = byName.get(name) || {commits: 0};
    m.commits += entry.commits;
    byName.set(name, m);
  }
  return [...byName.entries()]
    .sort((a, b) => b[1].commits - a[1].commits || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([name, e]) => ({name, commits: e.commits}));
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  const total = items.length;
  let lastLog = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
      done++;
      const now = Date.now();
      if (now - lastLog > 1000 || done === total) {
        lastLog = now;
        process.stderr.write(`\r  contributors: ${done}/${total}`);
      }
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  process.stderr.write('\n');
  return results;
}

// ---------- palette ----------

function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function paletteFor(names) {
  const sorted = [...names].sort();
  const golden = 137.508;
  const palette = {};
  sorted.forEach((name, i) => {
    palette[name] = hslToHex((i * golden) % 360, 65, 55);
  });
  return palette;
}

// ---------- main ----------

const EMPTY_GRAPH = () => ({
  nodes: [],
  links: [],
  meta: {
    generatedAt: new Date().toISOString(),
    nodeCount: 0,
    linkCount: 0,
    contributorCount: 0,
    palette: {},
  },
});

async function generate({root, out, concurrency = 8} = {}) {
  if (!root) throw new Error('generate(): `root` is required');
  if (!out) throw new Error('generate(): `out` is required');
  root = path.resolve(root);
  out = path.resolve(out);

  const files = listTrackedMarkdown(root);
  if (files.length === 0) {
    fs.mkdirSync(path.dirname(out), {recursive: true});
    fs.writeFileSync(out, JSON.stringify(EMPTY_GRAPH(), null, 2));
    return {nodeCount: 0, linkCount: 0, contributorCount: 0, files: 0};
  }

  // Build lookups for link resolution
  const fileSet = new Set(files);
  const basenameIndex = new Map();
  for (const f of files) {
    const base = path.basename(f).toLowerCase();
    if (!basenameIndex.has(base)) basenameIndex.set(base, f);
    const noExt = base.replace(/\.md$/, '');
    if (!basenameIndex.has(noExt)) basenameIndex.set(noExt, f);
  }

  // Extract links
  const links = [];
  const seenEdge = new Set();
  for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(root, file), 'utf8');
    } catch (err) {
      console.warn(`  skip ${file}: ${err.message}`);
      continue;
    }
    for (const link of extractLinks(raw)) {
      const target = resolveLink(link, file, fileSet, basenameIndex, root);
      if (!target || target === file) continue;
      const key = `${file}\0${target}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      links.push({source: file, target});
    }
  }

  // Contributors per file (parallel)
  const contribLists = await mapWithConcurrency(files, concurrency, f =>
    topContributors(f, root),
  );

  // Global name dedup: collapse spelling variants (JaneDoe / Jane Doe).
  const variants = new Map();
  const normKey = n => n.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const list of contribLists)
    for (const c of list) {
      const k = normKey(c.name);
      if (!k) continue;
      if (!variants.has(k)) variants.set(k, new Set());
      variants.get(k).add(c.name);
    }
  const rename = new Map();
  for (const names of variants.values()) {
    const canon = canonicalName(names);
    for (const n of names) rename.set(n, canon);
  }

  const dedupedLists = contribLists.map(list => {
    const merged = new Map();
    for (const c of list) {
      const name = rename.get(c.name) || c.name;
      merged.set(name, (merged.get(name) || 0) + c.commits);
    }
    return [...merged.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([name, commits]) => ({name, commits}));
  });

  const allNames = new Set();
  for (const list of dedupedLists) for (const c of list) allNames.add(c.name);
  const palette = paletteFor(allNames);

  const nodes = files.map((file, i) => ({
    id: file,
    label: path.basename(file),
    path: file,
    contributors: dedupedLists[i].map(c => ({...c, color: palette[c.name]})),
  }));

  const graph = {
    nodes,
    links,
    meta: {
      generatedAt: new Date().toISOString(),
      nodeCount: nodes.length,
      linkCount: links.length,
      contributorCount: allNames.size,
      palette,
    },
  };

  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, JSON.stringify(graph, null, 2));
  return {
    nodeCount: nodes.length,
    linkCount: links.length,
    contributorCount: allNames.size,
    files: files.length,
  };
}

module.exports = {generate};
