'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {spawnSync} = require('child_process');
const sirv = require('sirv');
const open = require('open');

const {generate} = require('./generator');

const WEB_DIR = path.join(__dirname, '..', 'web');
// force-graph ships dist/force-graph.min.js alongside its main entry
// (which resolves to dist/force-graph.mjs). Use the entry's directory so
// we never depend on package-internal paths that "exports" may not expose.
const FORCE_GRAPH_PATH = path.join(
  path.dirname(require.resolve('force-graph')),
  'force-graph.min.js',
);
const CACHE_DIR =
  process.env.MDG_CACHE_DIR || path.join(os.tmpdir(), 'markdown-graph-cache');

// ---------------------------------------------------------------------------
// Repo spec parsing
// ---------------------------------------------------------------------------

/**
 * Parse one repo spec into either `{kind:'local', path}` or
 * `{kind:'remote', repo}`. Accepted forms:
 *   "."              current working directory
 *   "./rel" "/abs"   local path
 *   "~/rel"          home-relative path
 *   "owner/name"     remote GitHub repo
 */
function parseRepoSpec(spec) {
  if (spec === '.' || spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) {
    return {kind: 'local', path: path.resolve(spec)};
  }
  if (spec === '~' || spec.startsWith('~/')) {
    return {kind: 'local', path: path.resolve(os.homedir(), spec.slice(2))};
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(spec)) {
    return {kind: 'remote', repo: spec};
  }
  throw new Error(
    `Cannot parse "${spec}". Expected "." | "./path" | "/abs/path" | "owner/name".`,
  );
}

function parseRepoList(csv) {
  return csv.split(',').map(s => s.trim()).filter(Boolean).map(parseRepoSpec);
}

const specName = s =>
  s.kind === 'remote' ? s.repo.replace('/', '__') : path.basename(s.path) || 'local';
const specLabel = s => (s.kind === 'remote' ? s.repo : path.basename(s.path) || s.path);

// ---------------------------------------------------------------------------
// Sparse clone (full history, *.md only in working tree)
// ---------------------------------------------------------------------------

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, {stdio: 'inherit', ...opts});
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} → exit ${r.status}`);
}

const hasCmd = cmd => spawnSync('which', [cmd], {stdio: 'ignore'}).status === 0;

/**
 * Idempotent sparse clone of a remote repo. Re-uses an existing clone by
 * fetching + hard-resetting to origin/HEAD; otherwise creates a partial
 * clone with `--filter=blob:none` and a sparse checkout limited to *.md
 * files. Full git history is preserved so contributor counts stay accurate.
 *
 * Tries plain `git clone` first (works for any public repo with no auth)
 * and only falls back to `gh repo clone` for private repos that need
 * GitHub credentials.
 */
function ensureSparseClone(repo, dest) {
  if (fs.existsSync(path.join(dest, '.git'))) {
    try {
      run('git', ['fetch', '--quiet', 'origin'], {cwd: dest, stdio: 'ignore'});
      run('git', ['reset', '--quiet', '--hard', 'origin/HEAD'], {cwd: dest, stdio: 'ignore'});
    } catch (err) {
      console.warn(`  fetch/reset failed for ${repo}: ${err.message}`);
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), {recursive: true});
  const cloneArgs = ['--filter=blob:none', '--no-checkout', '--single-branch'];
  try {
    run('git', ['clone', ...cloneArgs, `https://github.com/${repo}.git`, dest]);
  } catch {
    // Public-clone failed (probably a private repo). Clean up the partial
    // dest dir and retry with `gh`, which handles GitHub auth.
    fs.rmSync(dest, {recursive: true, force: true});
    if (!hasCmd('gh')) {
      throw new Error(
        `Cannot clone ${repo}: public clone failed and \`gh\` CLI is not installed for private-repo fallback.`,
      );
    }
    run('gh', ['repo', 'clone', repo, dest, '--', ...cloneArgs]);
  }
  run('git', ['sparse-checkout', 'init', '--no-cone'], {cwd: dest});
  run('git', ['sparse-checkout', 'set', '/**/*.md', '*.md'], {cwd: dest});
  run('git', ['checkout', 'HEAD'], {cwd: dest});
}

// ---------------------------------------------------------------------------
// Site builder — produces a self-contained static directory
// ---------------------------------------------------------------------------

async function generateOne(spec, outDir) {
  const name = specName(spec);
  const root =
    spec.kind === 'local'
      ? spec.path
      : path.join(CACHE_DIR, 'clones', spec.repo.replace('/', '__'));
  if (spec.kind === 'remote') {
    console.log(`  preparing ${spec.repo}`);
    ensureSparseClone(spec.repo, root);
  }
  console.log(`  generating ${specLabel(spec)}`);
  const stats = await generate({root, out: path.join(outDir, 'data', `${name}.json`)});
  console.log(
    `    → ${stats.nodeCount} nodes, ${stats.linkCount} links, ${stats.contributorCount} contributors`,
  );
  return {name, label: specLabel(spec)};
}

/**
 * Generate graphs for every repo in `repos` and write a complete static
 * site to `outDir`. Layout:
 *
 *   outDir/index.html
 *   outDir/vendor/force-graph.min.js
 *   outDir/datasets.json
 *   outDir/data/<name>.json
 *
 * The directory is suitable for serving with any static host (GH Pages,
 * S3, Netlify, `npx serve <dir>`).
 */
async function buildSite({repos, outDir}) {
  if (!repos.length) throw new Error('No repos to build');
  fs.mkdirSync(path.join(outDir, 'data'), {recursive: true});
  fs.mkdirSync(path.join(outDir, 'vendor'), {recursive: true});

  const entries = [];
  for (const spec of repos) {
    try {
      entries.push(await generateOne(spec, outDir));
    } catch (err) {
      console.error(`  ! ${specLabel(spec)} failed: ${err.message}`);
    }
  }
  if (!entries.length) throw new Error('No datasets generated');

  fs.cpSync(WEB_DIR, outDir, {recursive: true});
  fs.copyFileSync(FORCE_GRAPH_PATH, path.join(outDir, 'vendor', 'force-graph.min.js'));
  fs.writeFileSync(
    path.join(outDir, 'datasets.json'),
    JSON.stringify({datasets: entries}, null, 2),
  );
  return {outDir, entries};
}

// ---------------------------------------------------------------------------
// Serve — wraps buildSite with an HTTP server + cleanup
// ---------------------------------------------------------------------------

async function runRepos({repos, port = 8765, openBrowser = true}) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-graph-run-'));
  await buildSite({repos, outDir});

  const server = http.createServer(sirv(outDir, {dev: true, etag: true}));
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${port}/`;
  console.log(`\n  → ${url}`);
  if (openBrowser) await open(url).catch(() => {});

  const cleanup = () => fs.rmSync(outDir, {recursive: true, force: true});
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

  return {server, url, outDir};
}

module.exports = {runRepos, buildSite, parseRepoList};
