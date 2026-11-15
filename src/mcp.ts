// Model Context Protocol over streamable HTTP: JSON-RPC 2.0 on POST /mcp, answered as plain
// JSON (no SSE). The modern handshake is `server/discover` (the 2026-07-28 era); the legacy
// `initialize` + `notifications/initialized` handshake is kept as a fallback. Six tools act on
// the same store as REST, so a repository created here reads back identically there.
//
// Wire discipline: every request answers within the client's timeout, an unknown method is
// -32601, an unknown tool or a missing argument is -32602, a tool that ran and failed is a
// result with isError, and a body that is not JSON is HTTP 400 with -32700.

import { mergePull } from './merge.ts';
import {
  createIssue,
  createPull,
  issueJson,
  pullJson,
  repoJson,
  type Forge,
  type Repo,
} from './store.ts';
import { VIEWER, isRecord } from './util.ts';

/** The protocol revisions this server speaks, newest first. */
export const MCP_VERSIONS: readonly string[] = Object.freeze([
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);

/** The server's identity, in initialize and discover answers alike. */
export const SERVER_INFO: Readonly<{ name: string; version: string }> = Object.freeze({
  name: 'github-core-clone',
  version: '1.0.0',
});

/** The tool list, built once: two tools/list calls answer byte-identically. */
const TOOLS: ReadonlyArray<Readonly<Record<string, unknown>>> = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: Object.freeze({ type: 'string', description: 'The repository name.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The issue title.' }),
        body: Object.freeze({ type: 'string', description: 'The issue body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues in a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        state: Object.freeze({
          type: 'string',
          description: 'Filter by state: open, closed or all.',
          enum: Object.freeze(['open', 'closed', 'all']),
        }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The pull request title.' }),
        head: Object.freeze({ type: 'string', description: 'The branch the changes are on.' }),
        base: Object.freeze({ type: 'string', description: 'The branch the changes merge into.' }),
        body: Object.freeze({ type: 'string', description: 'The pull request body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        pull_number: Object.freeze({ type: 'integer', description: 'The pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

// ---------------------------------------------------------------- tool arguments

/** A required argument that was not supplied: the call answers -32602. */
class MissingArgError extends Error {}

/** A tool that ran and failed (unknown repo, duplicate, conflict): the call answers isError. */
class ToolError extends Error {}

/** The first non-empty string among several synonym argument names. */
function argString(args: Readonly<Record<string, unknown>>, ...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** The first integer among several synonym argument names (a numeric string counts). */
function argNumber(args: Readonly<Record<string, unknown>>, ...names: readonly string[]): number | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  }
  return undefined;
}

/** The owner and repo an argument set names, splitting full_name when that is all it gives. */
function ownerRepo(args: Readonly<Record<string, unknown>>): { owner: string; repo: string } {
  let owner = argString(args, 'owner', 'org', 'organization');
  let repo = argString(args, 'repo', 'repository');
  const full = argString(args, 'full_name', 'fullName');
  if ((owner === undefined || repo === undefined) && full !== undefined) {
    const slash = full.indexOf('/');
    if (slash > 0) {
      owner ??= full.slice(0, slash);
      repo ??= full.slice(slash + 1);
    }
  }
  if (owner === undefined || repo === undefined) throw new MissingArgError('owner and repo are required');
  return { owner, repo };
}

/** The repository an argument set names, or a ToolError when it does not exist. */
function repoOf(forge: Forge, args: Readonly<Record<string, unknown>>): Repo {
  const { owner, repo } = ownerRepo(args);
  if (owner !== VIEWER.login) throw new ToolError(`repository ${owner}/${repo} not found`);
  const found = forge.getRepo(repo);
  if (found === undefined) throw new ToolError(`repository ${owner}/${repo} not found`);
  return found;
}

// ---------------------------------------------------------------- the tools

/** What a tool returns: the structured result and the text that carries it. */
interface ToolOutcome {
  structured: Record<string, unknown>;
  text: string;
}

type ToolImpl = (forge: Forge, args: Readonly<Record<string, unknown>>) => ToolOutcome;

const TOOL_IMPLS: Readonly<Record<string, ToolImpl>> = Object.freeze({
  create_repo: (forge, args) => {
    const name = argString(args, 'name', 'repo', 'repository');
    if (name === undefined) throw new MissingArgError('name is required');
    const description = argString(args, 'description') ?? '';
    const isPrivate = args.private === true;
    const repo = forge.createRepo(name, description, isPrivate);
    if (repo === null) throw new ToolError('name already exists on this account');
    const view = repoJson(repo);
    return { structured: view, text: JSON.stringify(view) };
  },
  get_repo: (forge, args) => {
    const repo = repoOf(forge, args);
    const view = repoJson(repo);
    return { structured: view, text: JSON.stringify(view) };
  },
  create_issue: (forge, args) => {
    const repo = repoOf(forge, args);
    const title = argString(args, 'title');
    if (title === undefined) throw new MissingArgError('title is required');
    const body = argString(args, 'body') ?? '';
    const issue = createIssue(forge, repo, title, body, []);
    if ('error' in issue) throw new ToolError(issue.error);
    const view = issueJson(repo, issue);
    return { structured: view, text: JSON.stringify(view) };
  },
  list_issues: (forge, args) => {
    const repo = repoOf(forge, args);
    const state = argString(args, 'state') ?? 'open';
    let issues = [...repo.issues.values()];
    if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
    else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    issues.sort((a, b) => a.number - b.number);
    const views = issues.map((issue) => issueJson(repo, issue));
    return { structured: { issues: views }, text: JSON.stringify(views) };
  },
  create_pull_request: (forge, args) => {
    const repo = repoOf(forge, args);
    const title = argString(args, 'title');
    const head = argString(args, 'head', 'headRef', 'head_ref', 'head_branch');
    const base = argString(args, 'base', 'baseRef', 'base_ref', 'base_branch');
    if (title === undefined) throw new MissingArgError('title is required');
    if (head === undefined) throw new MissingArgError('head is required');
    if (base === undefined) throw new MissingArgError('base is required');
    const body = argString(args, 'body') ?? '';
    const pull = createPull(forge, repo, title, body, head, base);
    if ('error' in pull) throw new ToolError(pull.error);
    const view = pullJson(repo, pull);
    return { structured: view, text: JSON.stringify(view) };
  },
  merge_pull_request: (forge, args) => {
    const repo = repoOf(forge, args);
    const number = argNumber(args, 'pull_number', 'pullNumber', 'number', 'pr_number', 'prNumber');
    if (number === undefined) throw new MissingArgError('pull_number is required');
    const pull = repo.pulls.get(number);
    if (pull === undefined) throw new ToolError(`pull request #${number} not found`);
    const result = mergePull(repo, pull, 'squash');
    if ('error' in result) throw new ToolError(result.error);
    const view = { merged: true, sha: result.sha, number, message: 'Pull Request successfully merged' };
    return { structured: view, text: JSON.stringify(view) };
  },
});

// ---------------------------------------------------------------- JSON-RPC plumbing

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * POST /mcp: one JSON-RPC request. Returns the HTTP status and the JSON body (null for a
 * notification, answered 202 with an empty body). Auth is the router's job, before this runs.
 */
export function handleMcp(forge: Forge, rawBody: Buffer): { status: number; body: unknown } {
  let request: unknown;
  try {
    request = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (!isRecord(request) || typeof request.method !== 'string') {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const hasId = 'id' in request && request.id !== undefined;
  const id = (hasId ? (request.id as JsonRpcId) : null) ?? null;
  const params = isRecord(request.params) ? request.params : {};

  switch (request.method) {
    case 'server/discover':
      return {
        status: 200,
        body: rpcResult(id, {
          supportedVersions: [...MCP_VERSIONS],
          capabilities: { tools: {} },
          serverInfo: { ...SERVER_INFO },
          _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
        }),
      };
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = (MCP_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-11-25';
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { ...SERVER_INFO },
        }),
      };
    }
    case 'notifications/initialized':
      return { status: 202, body: null };
    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const tool = TOOL_IMPLS[name];
      if (tool === undefined) {
        return { status: 200, body: rpcError(id, -32602, `unknown tool ${JSON.stringify(name)}`) };
      }
      try {
        const outcome = tool(forge, args);
        return {
          status: 200,
          body: rpcResult(id, {
            content: [{ type: 'text', text: outcome.text }],
            structuredContent: outcome.structured,
          }),
        };
      } catch (err) {
        if (err instanceof MissingArgError) {
          return { status: 200, body: rpcError(id, -32602, err.message) };
        }
        if (err instanceof ToolError) {
          return {
            status: 200,
            body: rpcResult(id, {
              content: [{ type: 'text', text: err.message }],
              structuredContent: { error: err.message },
              isError: true,
            }),
          };
        }
        throw err;
      }
    }
    default:
      if (!hasId) return { status: 202, body: null };
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${request.method}`) };
  }
}
