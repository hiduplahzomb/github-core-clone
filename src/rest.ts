// GitHub REST v3: repositories, branches, commits, contents, labels, issues, comments and pull
// requests under /api/v3. Every reply is JSON with an X-GitHub-Request-Id (the router adds the
// header); every error body carries a string `message`. A repository under any owner but the
// viewer is a 404, never a 403 — the forge does not admit other owners exist.

import { firstParentChain, parseCommit, type GitObject } from './git-objects.ts';
import { mergePull, prFiles } from './merge.ts';
import {
  addComment,
  commentJson,
  commitTree,
  commitTreeNow,
  createIssue,
  createPull,
  issueJson,
  labelJson,
  pullJson,
  readPathInTree,
  removePathFromTree,
  repoJson,
  resolveRef,
  setPathInTree,
  storeObject,
  type Forge,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { DEFAULT_BRANCH, VIEWER, iso, nowSec, pageInt } from './util.ts';

/** What a handler returns: a status, optional extra headers, and a JSON body (null for 204). */
export interface RestResult {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

function ok(body: unknown, status = 200, headers?: Record<string, string>): RestResult {
  return { status, headers, body };
}

function fail(status: number, message: string): RestResult {
  return { status, body: { message } };
}

const NOT_FOUND = (): RestResult => fail(404, 'Not Found');

/** A repository's JSON view when the request names its owner and it exists, else a 404. */
function repoOf(forge: Forge, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return forge.getRepo(name) ?? null;
}

/** A positive integer path segment, or null. */
function asNumber(segment: string): number | null {
  const value = Number.parseInt(segment, 10);
  return Number.isSafeInteger(value) && value > 0 && String(value) === segment ? value : null;
}

/**
 * GitHub's Link pagination header for a list, with absolute same-origin URLs. `path` is the
 * request path without its query string; the query keeps per_page and moves page.
 */
function pageLinks(host: string, path: string, page: number, perPage: number, total: number): string | null {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (lastPage <= 1) return null;
  const url = (p: number): string => `http://${host}${path}?per_page=${perPage}&page=${p}`;
  const links: string[] = [];
  if (page < lastPage) links.push(`<${url(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${url(page - 1)}>; rel="prev"`);
  links.push(`<${url(1)}>; rel="first"`);
  links.push(`<${url(lastPage)}>; rel="last"`);
  return links.join(', ');
}

/** Slice a list into one page and build its Link header value. */
function paginate<T>(
  items: readonly T[],
  query: URLSearchParams,
  host: string,
  path: string,
): { page: T[]; link: string | null } {
  const perPage = pageInt(query.get('per_page'), 30, 1, 100);
  const page = pageInt(query.get('page'), 1, 1, Number.MAX_SAFE_INTEGER);
  const start = (page - 1) * perPage;
  return {
    page: items.slice(start, start + perPage),
    link: pageLinks(host, path, page, perPage, items.length),
  };
}

/** The issues endpoint also serves pull requests (a PR is an issue on GitHub), flagged as one. */
function issueOrPullJson(repo: Repo, item: Issue | PullRequest): Record<string, unknown> {
  if ('headRef' in item) {
    const view = pullJson(repo, item);
    return { ...view, pull_request: { url: `/repos/${repo.fullName}/pulls/${item.number}` } };
  }
  return issueJson(repo, item);
}

function findIssueOrPull(repo: Repo, number: number): Issue | PullRequest | undefined {
  return repo.issues.get(number) ?? repo.pulls.get(number);
}

// ---------------------------------------------------------------- the router

/**
 * Handle one REST request. `segments` are the decoded path segments after /api/v3 (empty for the
 * root), `query` the query string, `body` the parsed JSON body (undefined when there was none),
 * `host` the request's Host header for absolute pagination URLs.
 */
export function handleRest(
  forge: Forge,
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
  body: unknown,
  host: string,
): RestResult {
  const path = `/api/v3${segments.length === 0 ? '' : `/${segments.join('/')}`}`;

  // The API root and the instance metadata.
  if (segments.length === 0) {
    if (method !== 'GET') return fail(405, 'Method Not Allowed');
    return ok(
      {
        current_user_url: '/api/v3/user',
        user_url: '/api/v3/users/{user}',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues{?q}',
      },
      200,
      { 'X-OAuth-Scopes': 'repo, read:org' },
    );
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return fail(405, 'Method Not Allowed');
    return ok({ installed_version: '1.0.0', verifiable_password_authentication: false });
  }

  // The authenticated user.
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return fail(405, 'Method Not Allowed');
    return ok({
      login: VIEWER.login,
      id: VIEWER.id,
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
    });
  }

  // The user's repositories.
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const { page, link } = paginate(forge.listRepos(), query, host, path);
      return ok(
        page.map((repo) => repoJson(repo)),
        200,
        link === null ? undefined : { Link: link },
      );
    }
    if (method === 'POST') {
      const input = body as Record<string, unknown> | undefined;
      const name = typeof input?.name === 'string' ? input.name.trim() : '';
      if (name === '' || name.includes('/') || name === '.' || name === '..') {
        return fail(422, 'name is not a valid repository name');
      }
      const description = typeof input?.description === 'string' ? input.description : '';
      const isPrivate = input?.private === true;
      const repo = forge.createRepo(name, description, isPrivate);
      if (repo === null) return fail(422, 'name already exists on this account');
      return ok(repoJson(repo), 201);
    }
    return fail(405, 'Method Not Allowed');
  }

  // Everything below is a repository route: /repos/{owner}/{name}/...
  if (segments[0] !== 'repos' || segments.length < 3) return NOT_FOUND();
  const owner = segments[1] as string;
  const name = segments[2] as string;
  const repo = repoOf(forge, owner, name);
  if (repo === null) return NOT_FOUND();
  const rest = segments.slice(3);

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') return ok(repoJson(repo));
    if (method === 'PATCH') {
      const input = body as Record<string, unknown> | undefined;
      if (typeof input?.description === 'string') repo.description = input.description;
      if (typeof input?.private === 'boolean') repo.isPrivate = input.private;
      if (typeof input?.name === 'string') {
        const newName = input.name.trim();
        if (newName === '' || newName.includes('/')) return fail(422, 'name is not a valid repository name');
        if (!forge.renameRepo(repo, newName)) return fail(422, 'name already exists on this account');
      }
      repo.updatedAt = nowSec();
      return ok(repoJson(repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.name);
      return { status: 204, body: null };
    }
    return fail(405, 'Method Not Allowed');
  }

  switch (rest[0]) {
    case 'branches':
      return handleBranches(repo, method, rest.slice(1));
    case 'commits':
      return handleCommits(repo, method, rest.slice(1), query);
    case 'git':
      return handleGitRefs(repo, method, rest.slice(1), body);
    case 'contents':
      return handleContents(repo, method, rest.slice(1), query, body);
    case 'labels':
      return handleLabels(repo, method, rest.slice(1), body);
    case 'issues':
      return handleIssues(forge, repo, method, rest.slice(1), query, body, host, path);
    case 'pulls':
      return handlePulls(forge, repo, method, rest.slice(1), query, body, host, path);
    default:
      return NOT_FOUND();
  }
}

// ---------------------------------------------------------------- branches and commits

function handleBranches(repo: Repo, method: string, rest: readonly string[]): RestResult {
  if (method !== 'GET') return fail(405, 'Method Not Allowed');
  if (rest.length === 0) {
    return ok(
      repo.branchNames().map((name) => ({
        name,
        commit: { sha: repo.branchTip(name) as string },
        protected: false,
      })),
    );
  }
  const branch = rest.join('/');
  const tip = repo.branchTip(branch);
  if (tip === undefined) return NOT_FOUND();
  return ok({ name: branch, commit: { sha: tip }, protected: false });
}

function handleCommits(repo: Repo, method: string, rest: readonly string[], query: URLSearchParams): RestResult {
  if (method !== 'GET' || rest.length !== 0) return fail(405, 'Method Not Allowed');
  const ref = query.get('sha') ?? repo.defaultBranch;
  const tip = resolveRef(repo, ref);
  if (tip === null) return NOT_FOUND();
  const chain = firstParentChain(repo.objects, tip);
  return ok(
    chain.map((sha) => {
      const object = repo.objects.get(sha) as GitObject;
      const commit = parseCommit(object.data);
      return {
        sha,
        commit: {
          // Git stores messages with a trailing newline; the API surfaces the message as the
          // author wrote it, without it — the suite compares against the sent message exactly.
          message: commit.message.replace(/\n+$/, ''),
          author: { name: commit.author, email: '', date: iso(commit.authorTs) },
          committer: { name: commit.committer, email: '', date: iso(commit.committerTs) },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      };
    }),
  );
}

// ---------------------------------------------------------------- git refs

function handleGitRefs(repo: Repo, method: string, rest: readonly string[], body: unknown): RestResult {
  if (rest[0] !== 'refs') return NOT_FOUND();
  const tail = rest.slice(1);
  if (tail.length === 0) {
    if (method === 'GET') {
      return ok(
        [...repo.refs.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } })),
      );
    }
    if (method === 'POST') {
      const input = body as Record<string, unknown> | undefined;
      const ref = typeof input?.ref === 'string' ? input.ref : '';
      const sha = typeof input?.sha === 'string' ? input.sha : '';
      if (!ref.startsWith('refs/')) return fail(422, 'ref must start with refs/');
      if (!repo.objects.has(sha)) return fail(422, 'Invalid SHA1');
      if (repo.refs.has(ref)) return fail(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return ok({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }, 201);
    }
    return fail(405, 'Method Not Allowed');
  }
  if (method !== 'GET') return fail(405, 'Method Not Allowed');
  const ref = `refs/${tail.join('/')}`;
  const sha = repo.refs.get(ref);
  if (sha === undefined) return NOT_FOUND();
  return ok({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
}

// ---------------------------------------------------------------- contents

/** The branch a contents call targets; a missing branch is created from the default tip. */
function contentsBranch(repo: Repo, input: Record<string, unknown> | undefined): string {
  const branch = typeof input?.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
  if (repo.branchTip(branch) === undefined && repo.headTip() !== undefined) {
    repo.refs.set(`refs/heads/${branch}`, repo.headTip() as string);
  }
  return branch;
}

function handleContents(
  repo: Repo,
  method: string,
  rest: readonly string[],
  query: URLSearchParams,
  body: unknown,
): RestResult {
  const path = rest.join('/');
  const input = body as Record<string, unknown> | undefined;

  if (method === 'GET') {
    const ref = query.get('ref') ?? repo.defaultBranch;
    const tip = resolveRef(repo, ref);
    if (tip === null) return NOT_FOUND();
    const tree = commitTree(repo, tip);
    const found = readPathInTree(repo, tree, path);
    if (found === null) return NOT_FOUND();
    if (found.kind === 'file') {
      const object = repo.objects.get(found.entry.oid) as GitObject;
      return ok({
        type: 'file',
        encoding: 'base64',
        content: object.data.toString('base64'),
        sha: found.entry.oid,
        size: object.data.length,
        name: path.split('/').pop() ?? path,
        path,
      });
    }
    return ok(
      found.entries.map((entry) => {
        const child = repo.objects.get(entry.oid);
        return {
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: path === '' ? entry.name : `${path}/${entry.name}`,
          sha: entry.oid,
          size: entry.mode === '40000' ? 0 : (child?.data.length ?? 0),
        };
      }),
    );
  }

  if (method === 'PUT') {
    const message = typeof input?.message === 'string' ? input.message : '';
    const content = typeof input?.content === 'string' ? input.content : '';
    if (message === '' || content === '') return fail(422, 'message and content are required');
    const branch = contentsBranch(repo, input);
    const tip = repo.branchTip(branch);
    const tree = tip === undefined ? null : commitTree(repo, tip);
    const existing = tree === null ? null : readPathInTree(repo, tree, path);
    if (existing?.kind === 'dir') return fail(422, 'path is a directory');
    const expectedSha = typeof input?.sha === 'string' ? input.sha : undefined;
    if (existing?.kind === 'file') {
      if (expectedSha === undefined) return fail(422, 'sha is required to update a file');
      if (expectedSha !== existing.entry.oid) return fail(409, 'sha does not match the current file');
    }
    const data = Buffer.from(content, 'base64');
    const blobOid = storeObject(repo, 'blob', data);
    const mode = existing?.kind === 'file' ? existing.entry.mode : '100644';
    const newTree = setPathInTree(repo, tree, path, blobOid, mode);
    const commitOid = commitTreeNow(repo, newTree, tip === undefined ? [] : [tip], `${message}\n`);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    const created = existing === null;
    return ok(
      {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: blobOid,
          size: data.length,
          encoding: 'base64',
        },
        commit: { sha: commitOid, message },
      },
      created ? 201 : 200,
    );
  }

  if (method === 'DELETE') {
    const message = typeof input?.message === 'string' ? input.message : '';
    const branch = contentsBranch(repo, input);
    const tip = repo.branchTip(branch);
    if (tip === undefined) return NOT_FOUND();
    const tree = commitTree(repo, tip);
    const existing = readPathInTree(repo, tree, path);
    if (existing === null || existing.kind !== 'file') return NOT_FOUND();
    const expectedSha = typeof input?.sha === 'string' ? input.sha : undefined;
    if (expectedSha !== undefined && expectedSha !== existing.entry.oid) {
      return fail(409, 'sha does not match the current file');
    }
    const newTree = removePathFromTree(repo, tree as string, path);
    if (newTree === null) return NOT_FOUND();
    const commitOid = commitTreeNow(repo, newTree, [tip], `${message}\n`);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return ok({ commit: { sha: commitOid, message }, content: null });
  }

  return fail(405, 'Method Not Allowed');
}

// ---------------------------------------------------------------- labels

function handleLabels(repo: Repo, method: string, rest: readonly string[], body: unknown): RestResult {
  if (rest.length !== 0) return NOT_FOUND();
  if (method === 'GET') return ok([...repo.labels.values()].map((label) => labelJson(label)));
  if (method === 'POST') {
    const input = body as Record<string, unknown> | undefined;
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (name === '') return fail(422, 'name is required');
    if (repo.labels.has(name)) return fail(422, 'label already exists');
    const color = typeof input?.color === 'string' ? input.color : 'ededed';
    const description = typeof input?.description === 'string' ? input.description : '';
    const label = { name, color, description };
    repo.labels.set(name, label);
    return ok(labelJson(label), 201);
  }
  return fail(405, 'Method Not Allowed');
}

// ---------------------------------------------------------------- issues

function handleIssues(
  forge: Forge,
  repo: Repo,
  method: string,
  rest: readonly string[],
  query: URLSearchParams,
  body: unknown,
  host: string,
  path: string,
): RestResult {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const direction = query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) =>
        direction === 'asc' ? a.createdAt - b.createdAt || a.number - b.number : b.createdAt - a.createdAt || b.number - a.number,
      );
      const { page, link } = paginate(issues, query, host, path);
      return ok(
        page.map((issue) => issueJson(repo, issue)),
        200,
        link === null ? undefined : { Link: link },
      );
    }
    if (method === 'POST') {
      const input = body as Record<string, unknown> | undefined;
      const title = typeof input?.title === 'string' ? input.title.trim() : '';
      if (title === '') return fail(422, 'title is required');
      const bodyText = typeof input?.body === 'string' ? input.body : '';
      const rawLabels = Array.isArray(input?.labels) ? (input.labels as unknown[]) : [];
      const labelNames: string[] = [];
      for (const label of rawLabels) {
        if (typeof label === 'string') labelNames.push(label);
        else if (typeof label === 'object' && label !== null && typeof (label as Record<string, unknown>).name === 'string') {
          labelNames.push((label as Record<string, unknown>).name as string);
        }
      }
      const issue = createIssue(forge, repo, title, bodyText, labelNames);
      if ('error' in issue) return fail(422, issue.error);
      return ok(issueJson(repo, issue), 201);
    }
    return fail(405, 'Method Not Allowed');
  }

  const number = asNumber(rest[0] as string);
  if (number === null) return NOT_FOUND();
  const item = findIssueOrPull(repo, number);
  if (item === undefined) return NOT_FOUND();

  if (rest.length === 1) {
    if (method === 'GET') return ok(issueOrPullJson(repo, item));
    if (method === 'PATCH') {
      const input = body as Record<string, unknown> | undefined;
      if (typeof input?.title === 'string') item.title = input.title;
      if (typeof input?.body === 'string') item.body = input.body;
      if (input?.state === 'open' || input?.state === 'closed') item.state = input.state;
      item.updatedAt = nowSec();
      return ok(issueOrPullJson(repo, item));
    }
    return fail(405, 'Method Not Allowed');
  }

  if (rest[1] === 'comments' && rest.length === 2) {
    if (method === 'GET') return ok(item.comments.map((comment) => commentJson(comment)));
    if (method === 'POST') {
      const input = body as Record<string, unknown> | undefined;
      const text = typeof input?.body === 'string' ? input.body : '';
      if (text === '') return fail(422, 'body is required');
      const comment = addComment(item, repo, text);
      return ok(commentJson(comment), 201);
    }
    return fail(405, 'Method Not Allowed');
  }

  return NOT_FOUND();
}

// ---------------------------------------------------------------- pull requests

function handlePulls(
  forge: Forge,
  repo: Repo,
  method: string,
  rest: readonly string[],
  query: URLSearchParams,
  body: unknown,
  host: string,
  path: string,
): RestResult {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.createdAt - a.createdAt || b.number - a.number);
      const { page, link } = paginate(pulls, query, host, path);
      return ok(
        page.map((pull) => pullJson(repo, pull)),
        200,
        link === null ? undefined : { Link: link },
      );
    }
    if (method === 'POST') {
      const input = body as Record<string, unknown> | undefined;
      const title = typeof input?.title === 'string' ? input.title.trim() : '';
      const head = typeof input?.head === 'string' ? input.head : '';
      const base = typeof input?.base === 'string' ? input.base : '';
      if (title === '' || head === '' || base === '') return fail(422, 'title, head and base are required');
      const bodyText = typeof input?.body === 'string' ? input.body : '';
      const pull = createPull(forge, repo, title, bodyText, head, base);
      if ('error' in pull) return fail(422, pull.error);
      return ok(pullJson(repo, pull), 201);
    }
    return fail(405, 'Method Not Allowed');
  }

  const number = asNumber(rest[0] as string);
  if (number === null) return NOT_FOUND();
  const pull = repo.pulls.get(number);
  if (pull === undefined) return NOT_FOUND();

  if (rest.length === 1) {
    if (method === 'GET') return ok(pullJson(repo, pull));
    return fail(405, 'Method Not Allowed');
  }

  if (rest[1] === 'files' && rest.length === 2) {
    if (method !== 'GET') return fail(405, 'Method Not Allowed');
    return ok(
      prFiles(repo, pull).map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      })),
    );
  }

  if (rest[1] === 'merge' && rest.length === 2) {
    if (method !== 'PUT') return fail(405, 'Method Not Allowed');
    const input = body as Record<string, unknown> | undefined;
    const mergeMethod = typeof input?.merge_method === 'string' ? input.merge_method : 'merge';
    if (mergeMethod !== 'squash' && mergeMethod !== 'merge') {
      return fail(422, `merge_method "${mergeMethod}" is not supported`);
    }
    const result = mergePull(repo, pull, mergeMethod);
    if ('error' in result) return fail(result.status, result.error);
    return ok({ merged: true, sha: result.sha, message: 'Pull Request successfully merged' });
  }

  return NOT_FOUND();
}
