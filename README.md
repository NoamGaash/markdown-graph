# markdown-graph

[![npm](https://img.shields.io/npm/v/markdown-graph)](https://www.npmjs.com/package/markdown-graph)
[![license](https://img.shields.io/npm/l/markdown-graph)](LICENSE)

Interactive force-directed knowledge graph of a repository's Markdown
corpus. Every tracked `.md` file becomes a node, internal cross-references
become edges, and each node renders as a **pie chart sliced by its top 3
git contributors**. Folder regions render as translucent hulls under the
nodes so codebase structure is visible at a glance.

Built for "LLM context visualization" — seeing what a model would traverse
when reading your docs — but works equally well as a generic
"what's connected to what" tool for any repo with non-trivial Markdown.

## Quick start

```bash
cd path/to/your/repo
npx -y markdown-graph
# → opens http://127.0.0.1:8765/ in your browser
```

That's the whole flow. The tool finds your tracked `.md` files via
`git ls-files`, builds the graph, vendors `force-graph` from the local
`node_modules` (no CDN), and serves the viewer.

## Compare with other repos

Pass `--repos` to combine the current directory with one or more remote
GitHub repos:

```bash
npx -y markdown-graph --repos vercel/next.js,facebook/react
npx -y markdown-graph --repos .,vercel/next.js
```

Each `owner/name` is sparse-cloned (`--filter=blob:none` +
`sparse-checkout` for `*.md` only) into `$TMPDIR/markdown-graph-cache/`,
so re-runs reuse the clone. The viewer's dropdown lets you switch between
datasets without reloading.

## Options

```
-r, --repos <list>   comma-separated: "." | "./path" | "/abs/path" | "owner/name"
-p, --port <n>       port (default 8765)
    --no-open        don't auto-open the browser
-b, --build <dir>    build a static site to <dir> and exit (no server)
```

`--build` is what the CI workflow uses to deploy the example site to
GitHub Pages. The directory is self-contained — `index.html`,
`vendor/force-graph.min.js`, `datasets.json`, and `data/<name>.json` —
so any static host serves it.

## What gets parsed

Every tracked `.md` file is a node. Edges come from four kinds of
references:

| Syntax | Example |
| --- | --- |
| Standard markdown link | `[text](path/to/file.md)` |
| Wiki-link | `[[basename]]` |
| Claude Code `@`-include | `@path/to/file.md` |
| Backtick relative path | `` `path/to/file.md` `` (requires a `/`) |

Bare basenames inside backticks (`` `CLAUDE.md` ``, `` `README.md` ``)
are intentionally skipped — they're usually nouns, not references, and
would resolve ambiguously when the same basename exists in many
subdirectories.

`CHANGELOG.md` files are excluded from the corpus. Contributor name
variants (case, whitespace) are collapsed via a normalization pass and
`%aE/%aN` are mailmap-aware, so a `.mailmap` in the source repo merges
transliterations and nicknames.

## Library use

```js
const {generate} = require('markdown-graph/lib/generator');
const {runRepos, parseRepoList} = require('markdown-graph/lib/runner');

// Produce just the JSON:
await generate({root: '.', out: 'graph.json'});

// Generate + serve programmatically:
await runRepos({repos: parseRepoList('.,vercel/next.js'), port: 3000});
```

## Layout

```
bin/markdown-graph.js   CLI (commander)
lib/generator.js        pure  generate({root, out, concurrency})
lib/runner.js           pure  runRepos({repos, port, openBrowser}) + sparse-clone
web/index.html          Viewer (vanilla JS + force-graph)
```

## Dependencies

Four small runtime deps, vendored or required:

| | Why |
|---|---|
| `commander` | CLI parsing |
| `sirv` | static HTTP serving |
| `open` | cross-platform browser launch |
| `force-graph` | the renderer; copied into the served temp dir at runtime |

`git` (and optionally `gh` for private repos) must be on `PATH`. Node 18+.

## License

MIT
