[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-core-clone

A GitHub-compatible git forge in a single Node 22 process, standard library only — no git
binary, no dependencies, no database. One in-memory store serves four surfaces at once: the
git smart-HTTP protocol (clone, fetch, push), the REST v3 API, a GraphQL API, and an MCP
server, so a repository created through any one of them is visible through all the others.

## What it does

- **Git smart HTTP** — protocol v2 (`ls-refs`, `fetch`) and v0, for `git clone`, `git fetch`,
  `git pull` and `git push` with the real git CLI. Shallow clones, `--deepen`, `--unshallow`,
  `deepen-since` / `deepen-not`, `blob:none` / `blob:limit` / `tree:0` filters, thin packs,
  OFS and REF deltas on read, fast-forward enforcement on push (`non-fast-forward` rejections),
  annotated tags with peeling.
- **REST v3** — repositories (create/read/update/delete, paginated listing), branches, commits,
  git refs, contents (create/update/delete files, works on unborn repos), labels, issues,
  comments, pull requests (create, list, files, squash/merge commits with three-way conflict
  detection). Every reply is JSON with an `X-GitHub-Request-Id`; errors carry a `message`.
- **GraphQL** — `viewer`, `repository`, `node`, `issues` / `pullRequests` connections with
  cursor paging, `__type` introspection, and mutations (`createIssue`, `closeIssue`,
  `createPullRequest`, `mergePullRequest`, `addComment`). Global ids are opaque and stable.
- **MCP** — Streamable HTTP JSON-RPC with `server/discover` (all five spec revisions), the
  legacy `initialize` handshake, and six tools: `create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`.

## Running it

The entrypoint is `main.ts`. Under make.fun it binds an ephemeral port, registers with
`$MAKEFUN_ENV_URL`, and polls for completion:

```sh
node --experimental-strip-types main.ts
```

It needs `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN` from the environment. For local
development, import `createApp()` from `app.ts` and listen on a fixed port:

```ts
import { createApp } from './app.ts';
createApp().listen(18080);
```

Then, with `MAKEFUN_SHOP_TOKEN` set to your test token:

```sh
# create a repo, add a file, clone it with real git
curl -X POST -H "Authorization: Bearer $TOKEN" -d '{"name":"demo"}' \
  localhost:18080/api/v3/user/repos
git -c http.extraHeader="Authorization: Bearer $TOKEN" \
  clone http://localhost:18080/adaiversen/demo.git
```

## Layout

| File | What it holds |
| --- | --- |
| `main.ts` | Lifecycle: bind, register, poll for done, exit. |
| `app.ts` | HTTP router, auth, request ids, the four surfaces. |
| `src/git-http.ts` | Smart HTTP: info/refs, upload-pack (v2/v0), receive-pack, fetch planning. |
| `src/pack.ts` | Packfile reading (deltas, thin packs) and writing (plain v2 packs). |
| `src/git-objects.ts` | SHA-1 object hashing, commit/tree/tag codecs, ancestry walks. |
| `src/pktline.ts` | pkt-line framing. |
| `src/store.ts` | The in-memory forge: repos, refs, objects, issues, pulls, comments. |
| `src/merge.ts` | Tree diffs, three-way merge, squash/merge commits. |
| `src/rest.ts` | The REST v3 handlers. |
| `src/graphql.ts` | The GraphQL parser and executor. |
| `src/mcp.ts` | The MCP JSON-RPC handlers and tools. |
| `src/util.ts` | Viewer identity, deterministic clock, global ids, paging helpers. |

## Design notes

- **All state is in memory**, in one `Forge` per process. Nothing is written to disk, which
  keeps the benchmark workloads fast (no fsync anywhere) and the entry self-contained.
- **Timestamps are deterministic**: a logical clock ticks from a fixed epoch instead of
  `Date.now()`, so repeated runs produce identical state.
- **Packs are plain on write, full on read**: the server writes undeltified v2 packs (valid,
  and the client never needs deltas) but resolves OFS_DELTA and REF_DELTA entries, including
  thin packs whose bases live in the store, when reading a push.
- **The fetch planner walks through held commits**: a held commit above a shallow boundary
  has unheld ancestors behind it, so stopping at held commits would break `--deepen` and
  `--unshallow`. The held-object exclusion likewise stops at shallow boundaries.
- **The v2 fetch response follows git's client state machine**: a request carrying `done`
  gets no acknowledgments section (the client is already in get-pack state); a request with
  haves but no `done` gets the acknowledgments section alone, ending in a bare flush.

## License

MIT — see [LICENSE](LICENSE).

<sub>Entered on [make.fun](https://make.fun/?ref=ykaz8n5y&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
