#!/usr/bin/env node
'use strict';

const path = require('path');
const {Command} = require('commander');
const {runRepos, buildSite, parseRepoList} = require('../lib/runner');
const pkg = require('../package.json');

new Command()
  .name('markdown-graph')
  .description(pkg.description)
  .version(pkg.version)
  .option(
    '-r, --repos <list>',
    'comma-separated list: "." | "./path" | "/abs/path" | "owner/name"',
    '.',
  )
  .option('-p, --port <n>', 'port', v => Number(v) || 8765, 8765)
  .option('--no-open', "don't auto-open the browser")
  .option(
    '-b, --build <dir>',
    'build a static site to <dir> and exit (suitable for GitHub Pages); skips the server',
  )
  .action(async opts => {
    const repos = parseRepoList(opts.repos);
    if (opts.build) {
      await buildSite({repos, outDir: path.resolve(opts.build)});
      console.log(`\n  ✓ site built at ${path.resolve(opts.build)}`);
      return;
    }
    await runRepos({repos, port: opts.port, openBrowser: opts.open});
  })
  .parseAsync()
  .catch(err => {
    console.error(err.message || err);
    process.exit(1);
  });
