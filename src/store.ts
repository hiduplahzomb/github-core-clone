// The forge's state: repositories, git objects, refs, issues, pull requests, labels and comments,
// all in memory. One Forge per server process; the REST, GraphQL and MCP surfaces all read and
// write this same store, so a repository created through one surface is visible through the
// others at once. Nothing here knows about HTTP: the handlers translate to and from the wire.

import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTree,
  type GitObject,
  type TreeEntry,
} from './git-objects.ts';
import { DEFAULT_BRANCH, VIEWER, globalId, iso, nowSec, viewerIdentity } from './util.ts';

/** One comment on an issue or a pull request. */
export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: number;
  updatedAt: number;
}

/** One label a repository defines; issues reference labels by name. */
export interface Label {
  name: string;
  color: string;
  description: string;
}

/** One issue. Numbers are shared with pull requests, one sequence per repository. */
export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  user: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Cached serialization of this issue's REST view, valid while `updatedAt` matches. Every
   * mutation of an issue (PATCH, close, comment) bumps `updatedAt` — see rest.ts, graphql.ts and
   * addComment — and labels are immutable once created, so the cached string cannot go stale.
   */
  jsonCache?: { updatedAt: number; json: string };
}

/** One pull request. headSha/baseSha are the branch tips recorded at creation. */
export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  comments: Comment[];
  user: string;
  createdAt: number;
  updatedAt: number;
}

/** A repository: its git object store and refs, plus its issues, pulls and labels. */
export class Repo {
  readonly id: number;
  name: string;
  readonly owner: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdAt: number;
  updatedAt: number;

  /** The object store: oid to object, per repository. */
  readonly objects = new Map<string, GitObject>();
  /** Refs by full name (`refs/heads/main`, `refs/tags/v1`) to the oid they point at. */
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, PullRequest>();
  /** The next issue/PR number; issues and pulls share one sequence, as on GitHub. */
  nextNumber = 1;
  nextCommentId = 1;
  /**
   * Cached upload-pack fetch responses, keyed by the resolved fetch arguments plus the object
   * store's size (see fetchCacheKey in git-http.ts). Objects are content-addressed and only ever
   * added, so a key that names the store size cannot go stale; the cache dies with the repo.
   */
  readonly fetchCache = new Map<string, Buffer>();

  constructor(id: number, name: string, description: string, isPrivate: boolean) {
    this.id = id;
    this.name = name;
    this.owner = VIEWER.login;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = DEFAULT_BRANCH;
    this.createdAt = nowSec();
    this.updatedAt = this.createdAt;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  /** The tip of a branch by short name, or undefined when the branch does not exist. */
  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }

  /** The tip of the default branch, or undefined while the repository is unborn. */
  headTip(): string | undefined {
    return this.branchTip(this.defaultBranch);
  }

  /** Branch short names, sorted. */
  branchNames(): string[] {
    const names: string[] = [];
    for (const ref of this.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    return names.sort();
  }

  /** Tag names, sorted. */
  tagNames(): string[] {
    const names: string[] = [];
    for (const ref of this.refs.keys()) {
      if (ref.startsWith('refs/tags/')) names.push(ref.slice('refs/tags/'.length));
    }
    return names.sort();
  }
}

/** The whole forge: every repository, by name and by id. All repositories belong to the viewer. */
export class Forge {
  readonly repos = new Map<string, Repo>();
  readonly reposById = new Map<number, Repo>();
  nextRepoId = 1;
  /** GitHub-wide ids for issues and pull requests, one sequence for both. */
  nextItemId = 10000;

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  getRepoById(id: number): Repo | undefined {
    return this.reposById.get(id);
  }

  /** Create a repository; null when a repository of that name already exists. */
  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(name)) return null;
    const repo = new Repo(this.nextRepoId, name, description, isPrivate);
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  /** Delete a repository and everything in it; false when it did not exist. */
  deleteRepo(name: string): boolean {
    const repo = this.repos.get(name);
    if (repo === undefined) return false;
    this.repos.delete(name);
    this.reposById.delete(repo.id);
    return true;
  }

  /** Rename a repository; false when the new name is taken. */
  renameRepo(repo: Repo, newName: string): boolean {
    if (newName !== repo.name && this.repos.has(newName)) return false;
    this.repos.delete(repo.name);
    repo.name = newName;
    this.repos.set(newName, repo);
    return true;
  }

  /** Repositories in creation order (ids ascend with creation). */
  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }
}

// ---------------------------------------------------------------- git primitives

/** Store an object, returning its oid. Storing the same bytes twice is a no-op. */
export function storeObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** Store an object whose oid the caller already computed (the pack reader hashes as it reads),
 * returning the oid. Storing the same oid twice is a no-op. */
export function storeObjectWithOid(repo: Repo, oid: string, type: GitObject['type'], data: Buffer): string {
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** Resolve a ref-ish to a commit oid: HEAD, a branch short name, a full ref, or an oid itself. */
export function resolveRef(repo: Repo, ref: string): string | null {
  if (ref === 'HEAD') return repo.headTip() ?? null;
  if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return tag;
  const object = repo.objects.get(ref);
  if (object !== undefined && object.type === 'commit') return ref;
  return null;
}

/** The tree oid of a commit, or null when the oid is not a commit in the store. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Create a commit on a tree with the given parents, store it, return its oid. */
export function commitTreeNow(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
  const identity = viewerIdentity();
  const commit = buildCommit({
    tree: treeOid,
    parents,
    message,
    author: identity,
    committer: identity,
    timestamp: nowSec(),
  });
  return storeObject(repo, 'commit', commit);
}

/** One flattened tree entry: a full path and the blob or subtree it points at. */
export interface FlatEntry {
  oid: string;
  mode: string;
}

/** Flatten a tree into path -> entry, recursing into subdirectories. Gitlinks are skipped. */
export function flattenTree(repo: Repo, treeOid: string | null): Map<string, FlatEntry> {
  const flat = new Map<string, FlatEntry>();
  if (treeOid === null) return flat;
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else if (entry.mode !== '160000') flat.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return flat;
}

/**
 * Build the nested trees for a flat path map, storing every tree, and return the root tree's oid.
 * Directories are created as needed; an empty map yields the empty tree.
 */
export function buildTreeFromFlat(repo: Repo, flat: ReadonlyMap<string, FlatEntry>): string {
  const buildLevel = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const subdirs = new Set<string>();
    for (const [path, entry] of flat) {
      if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash < 0) entries.push({ mode: entry.mode, name: rest, oid: entry.oid });
      else subdirs.add(rest.slice(0, slash));
    }
    for (const dir of subdirs) {
      const childPrefix = prefix === '' ? dir : `${prefix}/${dir}`;
      entries.push({ mode: '40000', name: dir, oid: buildLevel(childPrefix) });
    }
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return buildLevel('');
}

/**
 * Set one file in a tree (creating intermediate directories), storing the new trees, and return
 * the new root tree's oid. `baseTreeOid` is null for an empty tree.
 */
export function setPathInTree(repo: Repo, baseTreeOid: string | null, path: string, blobOid: string, mode: string): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  const build = (treeOid: string | null, at: number): string => {
    const entries = new Map<string, TreeEntry>();
    if (treeOid !== null) {
      const object = repo.objects.get(treeOid);
      if (object !== undefined && object.type === 'tree') {
        for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
      }
    }
    const segment = segments[at] as string;
    if (at === segments.length - 1) {
      entries.set(segment, { mode, name: segment, oid: blobOid });
    } else {
      const existing = entries.get(segment);
      const childTree = existing !== undefined && existing.mode === '40000' ? existing.oid : null;
      entries.set(segment, { mode: '40000', name: segment, oid: build(childTree, at + 1) });
    }
    return storeObject(repo, 'tree', buildTree([...entries.values()]));
  };
  return build(baseTreeOid, 0);
}

/**
 * Remove one file from a tree, pruning directories left empty, and return the new root tree's
 * oid — or null when the path was not in the tree.
 */
export function removePathFromTree(repo: Repo, baseTreeOid: string, path: string): string | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  const remove = (treeOid: string, at: number): string | null => {
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return null;
    const entries = new Map<string, TreeEntry>();
    for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
    const segment = segments[at] as string;
    if (at === segments.length - 1) {
      if (!entries.has(segment)) return null;
      entries.delete(segment);
    } else {
      const existing = entries.get(segment);
      if (existing === undefined || existing.mode !== '40000') return null;
      const child = remove(existing.oid, at + 1);
      if (child === null) return null;
      const childObject = repo.objects.get(child);
      const childEmpty = childObject !== undefined && childObject.type === 'tree' && parseTree(childObject.data).length === 0;
      if (childEmpty) entries.delete(segment);
      else entries.set(segment, { mode: '40000', name: segment, oid: child });
    }
    return storeObject(repo, 'tree', buildTree([...entries.values()]));
  };
  return remove(baseTreeOid, 0);
}

/** Read one path out of a tree: the blob entry, a directory's entries, or null when absent. */
export function readPathInTree(
  repo: Repo,
  treeOid: string | null,
  path: string,
): { kind: 'file'; entry: FlatEntry } | { kind: 'dir'; entries: TreeEntry[] } | null {
  if (treeOid === null) return null;
  const segments = path.split('/').filter((segment) => segment !== '');
  let current = treeOid;
  for (let at = 0; at < segments.length; at += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entries = parseTree(object.data);
    const segment = segments[at] as string;
    const found = entries.find((entry) => entry.name === segment);
    if (found === undefined) return null;
    if (at === segments.length - 1) {
      if (found.mode === '40000') {
        const dirObject = repo.objects.get(found.oid);
        if (dirObject === undefined || dirObject.type !== 'tree') return null;
        return { kind: 'dir', entries: parseTree(dirObject.data) };
      }
      return { kind: 'file', entry: { oid: found.oid, mode: found.mode } };
    }
    if (found.mode !== '40000') return null;
    current = found.oid;
  }
  const root = repo.objects.get(current);
  if (root === undefined || root.type !== 'tree') return null;
  return { kind: 'dir', entries: parseTree(root.data) };
}

// ---------------------------------------------------------------- domain operations

/** Create an issue; an unknown label name is an error naming it. */
export function createIssue(
  forge: Forge,
  repo: Repo,
  title: string,
  body: string,
  labelNames: readonly string[],
): Issue | { error: string } {
  for (const name of labelNames) {
    if (!repo.labels.has(name)) return { error: `label "${name}" does not exist` };
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const createdAt = nowSec();
  const issue: Issue = {
    id: forge.nextItemId,
    number,
    title,
    body,
    state: 'open',
    labels: [...labelNames],
    comments: [],
    user: VIEWER.login,
    createdAt,
    updatedAt: createdAt,
  };
  forge.nextItemId += 1;
  repo.issues.set(number, issue);
  return issue;
}

/** Create a pull request; a missing branch or a duplicate open PR is an error. */
export function createPull(
  forge: Forge,
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): PullRequest | { error: string } {
  const headSha = repo.branchTip(headRef);
  if (headSha === undefined) return { error: `head branch "${headRef}" does not exist` };
  const baseSha = repo.branchTip(baseRef);
  if (baseSha === undefined) return { error: `base branch "${baseRef}" does not exist` };
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
      return { error: `a pull request for ${headRef} into ${baseRef} already exists` };
    }
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const createdAt = nowSec();
  const pull: PullRequest = {
    id: forge.nextItemId,
    number,
    title,
    body,
    state: 'open',
    headRef,
    baseRef,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    comments: [],
    user: VIEWER.login,
    createdAt,
    updatedAt: createdAt,
  };
  forge.nextItemId += 1;
  repo.pulls.set(number, pull);
  return pull;
}

/** Append a comment to an issue or a pull request. */
export function addComment(item: Issue | PullRequest, repo: Repo, body: string): Comment {
  const createdAt = nowSec();
  const comment: Comment = { id: repo.nextCommentId, body, user: VIEWER.login, createdAt, updatedAt: createdAt };
  repo.nextCommentId += 1;
  item.comments.push(comment);
  item.updatedAt = createdAt;
  return comment;
}

// ---------------------------------------------------------------- JSON views (REST v3 shapes)

function userJson(login: string): Record<string, unknown> {
  return { login, id: login === VIEWER.login ? VIEWER.id : 0, type: 'User' };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: iso(repo.createdAt),
    updated_at: iso(repo.updatedAt),
    html_url: `https://github.com/${repo.fullName}`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    has_issues: true,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

export function commentJson(comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(comment.user),
    created_at: iso(comment.createdAt),
    updated_at: iso(comment.updatedAt),
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelJson(label) : { name, color: '', description: '' };
    }),
    user: userJson(issue.user),
    created_at: iso(issue.createdAt),
    updated_at: iso(issue.updatedAt),
    comments: issue.comments.length,
  };
}

/** The issue's REST view as a JSON string, cached on the issue while `updatedAt` is unchanged. */
export function issueJsonString(repo: Repo, issue: Issue): string {
  const cached = issue.jsonCache;
  if (cached !== undefined && cached.updatedAt === issue.updatedAt) return cached.json;
  const json = JSON.stringify(issueJson(repo, issue));
  issue.jsonCache = { updatedAt: issue.updatedAt, json };
  return json;
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt === null ? null : iso(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, repo: { full_name: repo.fullName } },
    base: { ref: pull.baseRef, sha: pull.baseSha, repo: { full_name: repo.fullName } },
    user: userJson(pull.user),
    created_at: iso(pull.createdAt),
    updated_at: iso(pull.updatedAt),
  };
}

// ---------------------------------------------------------------- GraphQL global ids

export function repoGlobalId(repo: Repo): string {
  return globalId('Repository', String(repo.id));
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.id}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return globalId('PullRequest', `${repo.id}:${pull.number}`);
}

export function commentGlobalId(repo: Repo, comment: Comment): string {
  return globalId('IssueComment', `${repo.id}:${comment.id}`);
}
