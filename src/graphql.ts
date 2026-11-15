// GitHub GraphQL v4: a small recursive-descent parser for the documents gh and
// github-mcp-server send, and an executor over the same store the REST surface uses. No GraphQL
// library, no schema file: the field tables below are the schema, and an unknown field is a
// GraphQL error naming it (HTTP 200 with `errors`), never an HTTP error.
//
// Supported: query/mutation operations (named or anonymous), variable definitions and references,
// aliases, arguments (scalars, enums, lists, input objects), inline fragments and named fragment
// spreads, directives (parsed and ignored). Operation batching (a JSON array of documents) is
// answered with an array of envelopes in order.

import { mergePull, prConflicts, prFiles } from './merge.ts';
import {
  Repo,
  addComment,
  commentGlobalId,
  createIssue,
  createPull,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
  type Comment,
  type Forge,
  type Issue,
  type PullRequest,
} from './store.ts';
import { VIEWER, isRecord, iso, nowSec, parseGlobalId } from './util.ts';

// ---------------------------------------------------------------- the parser

/** A value in a document: a variable reference or a literal (scalars, enums, lists, objects). */
export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

/** One selection: a field, a named fragment spread, or an inline fragment. */
export type SelectionNode =
  | { kind: 'field'; name: string; alias: string | null; args: Record<string, ValueNode>; selections: SelectionNode[] }
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selections: SelectionNode[] };

/** One operation definition (query or mutation). */
export interface OperationNode {
  kind: 'operation';
  op: 'query' | 'mutation' | 'subscription';
  name: string | null;
  selections: SelectionNode[];
}

/** One named fragment definition. */
export interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

/** A parsed document: its operations and its named fragments. */
export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

/** A cursor-based parser over one document string. Throws on the first syntax error. */
export class Parser {
  private pos = 0;
  private readonly src: string;

  constructor(src: string) {
    this.src = src;
  }

  /** Skip whitespace, commas (insignificant in GraphQL) and #-comments. */
  private skipIgnored(): void {
    for (;;) {
      const ch = this.src[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
        this.pos += 1;
        continue;
      }
      if (ch === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      break;
    }
  }

  /** The next significant character, or '' at the end. */
  private peek(): string {
    this.skipIgnored();
    return this.src[this.pos] ?? '';
  }

  private expect(ch: string): void {
    this.skipIgnored();
    if (this.src[this.pos] !== ch) {
      throw new Error(`expected ${JSON.stringify(ch)} at offset ${this.pos}, got ${JSON.stringify(this.src[this.pos] ?? 'end')}`);
    }
    this.pos += 1;
  }

  private readName(): string {
    this.skipIgnored();
    const start = this.pos;
    const first = this.src[this.pos] ?? '';
    if (!/[A-Za-z_]/.test(first)) throw new Error(`expected a name at offset ${this.pos}`);
    this.pos += 1;
    while (/[A-Za-z0-9_]/.test(this.src[this.pos] ?? '')) this.pos += 1;
    return this.src.slice(start, this.pos);
  }

  private readString(): string {
    this.skipIgnored();
    if (this.src.startsWith('"""', this.pos)) {
      const end = this.src.indexOf('"""', this.pos + 3);
      if (end < 0) throw new Error('unterminated block string');
      const value = this.src.slice(this.pos + 3, end);
      this.pos = end + 3;
      return value;
    }
    this.expect('"');
    let out = '';
    for (;;) {
      const ch = this.src[this.pos];
      if (ch === undefined) throw new Error('unterminated string');
      if (ch === '"') {
        this.pos += 1;
        break;
      }
      if (ch === '\\') {
        this.pos += 1;
        const esc = this.src[this.pos] ?? '';
        this.pos += 1;
        switch (esc) {
          case '"':
            out += '"';
            break;
          case '\\':
            out += '\\';
            break;
          case '/':
            out += '/';
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 't':
            out += '\t';
            break;
          case 'u': {
            const hex = this.src.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad unicode escape in string');
            out += String.fromCharCode(Number.parseInt(hex, 16));
            this.pos += 4;
            break;
          }
          default:
            throw new Error(`bad escape \\${esc} in string`);
        }
        continue;
      }
      out += ch;
      this.pos += 1;
    }
    return out;
  }

  private readNumber(): number {
    this.skipIgnored();
    const start = this.pos;
    if (this.src[this.pos] === '-') this.pos += 1;
    while (/[0-9]/.test(this.src[this.pos] ?? '')) this.pos += 1;
    if (this.src[this.pos] === '.') {
      this.pos += 1;
      while (/[0-9]/.test(this.src[this.pos] ?? '')) this.pos += 1;
    }
    if (this.src[this.pos] === 'e' || this.src[this.pos] === 'E') {
      this.pos += 1;
      if (this.src[this.pos] === '+' || this.src[this.pos] === '-') this.pos += 1;
      while (/[0-9]/.test(this.src[this.pos] ?? '')) this.pos += 1;
    }
    return Number(this.src.slice(start, this.pos));
  }

  /** Parse a whole document. */
  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek() !== '') {
      if (this.peek() === '{') {
        operations.push({ kind: 'operation', op: 'query', name: null, selections: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.readName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | null = null;
        const next = this.peek();
        if (next !== '(' && next !== '{' && next !== '@') name = this.readName();
        if (this.peek() === '(') this.parseVariableDefinitions();
        this.parseDirectives();
        operations.push({ kind: 'operation', op: keyword, name, selections: this.parseSelectionSet() });
      } else if (keyword === 'fragment') {
        const name = this.readName();
        const on = this.readName();
        if (on !== 'on') throw new Error(`expected 'on' in fragment definition, got ${JSON.stringify(on)}`);
        const typeCondition = this.readName();
        this.parseDirectives();
        fragments.set(name, { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected definition ${JSON.stringify(keyword)}`);
      }
    }
    return { operations, fragments };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    this.skipIgnored();
    if (this.src.startsWith('...', this.pos)) {
      this.pos += 3;
      const next = this.peek();
      if (next === '{') {
        this.parseDirectives();
        return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
      }
      const name = this.readName();
      if (name === 'on') {
        const typeCondition = this.readName();
        this.parseDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      this.parseDirectives();
      return { kind: 'spread', name };
    }
    const first = this.readName();
    let alias: string | null = null;
    let name = first;
    if (this.peek() === ':') {
      this.pos += 1;
      alias = first;
      name = this.readName();
    }
    let args: Record<string, ValueNode> = {};
    if (this.peek() === '(') args = this.parseArguments();
    this.parseDirectives();
    let selections: SelectionNode[] = [];
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Record<string, ValueNode> {
    this.expect('(');
    const args: Record<string, ValueNode> = {};
    while (this.peek() !== ')') {
      if (this.peek() === '') throw new Error('unterminated argument list');
      const name = this.readName();
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  private parseValue(): ValueNode {
    const ch = this.peek();
    if (ch === '$') {
      this.pos += 1;
      return { kind: 'variable', name: this.readName() };
    }
    if (ch === '"') return { kind: 'string', value: this.readString() };
    if (ch === '[') {
      this.pos += 1;
      const items: ValueNode[] = [];
      while (this.peek() !== ']') {
        if (this.peek() === '') throw new Error('unterminated list value');
        items.push(this.parseValue());
      }
      this.expect(']');
      return { kind: 'list', items };
    }
    if (ch === '{') {
      this.pos += 1;
      const fields: Record<string, ValueNode> = {};
      while (this.peek() !== '}') {
        if (this.peek() === '') throw new Error('unterminated object value');
        const name = this.readName();
        this.expect(':');
        fields[name] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (ch === '-' || /[0-9]/.test(ch)) return { kind: 'number', value: this.readNumber() };
    const name = this.readName();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }

  /** Consume variable definitions (`($owner: String!, $n: Int = 3)`); values come from the request. */
  private parseVariableDefinitions(): void {
    this.expect('(');
    while (this.peek() !== ')') {
      if (this.peek() === '') throw new Error('unterminated variable definitions');
      this.skipIgnored();
      if (this.src[this.pos] !== '$') throw new Error('expected $ in variable definition');
      this.pos += 1;
      this.readName();
      this.expect(':');
      this.parseType();
      if (this.peek() === '=') {
        this.pos += 1;
        this.parseValue();
      }
    }
    this.expect(')');
  }

  /** Consume a type expression (a name, a list, either nullable or `!`). */
  private parseType(): void {
    if (this.peek() === '[') {
      this.pos += 1;
      this.parseType();
      this.expect(']');
    } else {
      this.readName();
    }
    if (this.peek() === '!') this.pos += 1;
  }

  /** Consume directives (`@include(if: $x)`); the documents here do not use them. */
  private parseDirectives(): void {
    while (this.peek() === '@') {
      this.pos += 1;
      this.readName();
      if (this.peek() === '(') this.parseArguments();
    }
  }
}

/** Resolve a parsed value against the request's variables. */
function resolveValue(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- the executor

/** An issue or pull request together with its repository (global ids need both). */
interface IssueRef {
  repo: Repo;
  issue: Issue;
}

/** A pull request together with its repository. */
interface PullRef {
  repo: Repo;
  pull: PullRequest;
}

/** A comment together with its repository. */
interface CommentRef {
  repo: Repo;
  comment: Comment;
}

/** What one field execution may read and write. */
interface Ctx {
  forge: Forge;
  variables: Readonly<Record<string, unknown>>;
  errors: Array<{ message: string }>;
  fragments: ReadonlyMap<string, FragmentNode>;
}

/** One field of one type: its result type and how to resolve it. */
interface FieldDef {
  /** The result type: a scalar name, an object type, `[T]` for a list, or a function of the value. */
  type: string | ((value: unknown) => string);
  resolve: (obj: any, args: Record<string, unknown>, ctx: Ctx) => unknown;
}

/** A page cursor: base64 of an issue or pull request number. */
function numberToCursor(number: number): string {
  return Buffer.from(String(number), 'utf8').toString('base64');
}

function cursorToNumber(cursor: string): number | null {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const value = Number.parseInt(decoded, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** The issues connection for a repository: states filter, CREATED_AT ordering, first/after paging. */
function issueConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let issues = [...repo.issues.values()];
  if (Array.isArray(args.states)) {
    const wanted = new Set(args.states as string[]);
    issues = issues.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : undefined;
  if (orderBy?.field === 'CREATED_AT') {
    const ascending = orderBy.direction === 'ASC';
    issues.sort((a, b) =>
      ascending ? a.createdAt - b.createdAt || a.number - b.number : b.createdAt - a.createdAt || b.number - a.number,
    );
  } else {
    issues.sort((a, b) => a.number - b.number);
  }
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const after = cursorToNumber(args.after);
    if (after !== null) {
      const index = issues.findIndex((issue) => issue.number === after);
      if (index >= 0) start = index + 1;
    }
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : issues.length;
  const page = issues.slice(start, start + first);
  const hasNextPage = start + page.length < issues.length;
  return {
    nodes: page.map((issue) => ({ repo, issue }) as IssueRef),
    totalCount: issues.length,
    pageInfo: {
      hasNextPage,
      endCursor: page.length > 0 ? numberToCursor(page[page.length - 1]?.number as number) : null,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? numberToCursor(page[0]?.number as number) : null,
    },
  };
}

/** The pull requests connection: creation order, first/after paging. */
function pullConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const after = cursorToNumber(args.after);
    if (after !== null) {
      const index = pulls.findIndex((pull) => pull.number === after);
      if (index >= 0) start = index + 1;
    }
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : pulls.length;
  const page = pulls.slice(start, start + first);
  const hasNextPage = start + page.length < pulls.length;
  return {
    nodes: page.map((pull) => ({ repo, pull }) as PullRef),
    totalCount: pulls.length,
    pageInfo: {
      hasNextPage,
      endCursor: page.length > 0 ? numberToCursor(page[page.length - 1]?.number as number) : null,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? numberToCursor(page[0]?.number as number) : null,
    },
  };
}

/** Decode a global id into the repository and item it names, or null. */
function decodeNodeId(
  forge: Forge,
  id: string,
): { repo: Repo; issue: Issue } | { repo: Repo; pull: PullRequest } | Repo | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.kind === 'Repository') {
    const repoId = Number.parseInt(parsed.key, 10);
    return Number.isSafeInteger(repoId) ? (forge.getRepoById(repoId) ?? null) : null;
  }
  const [repoIdRaw, numberRaw] = parsed.key.split(':');
  const repoId = Number.parseInt(repoIdRaw ?? '', 10);
  const number = Number.parseInt(numberRaw ?? '', 10);
  if (!Number.isSafeInteger(repoId) || !Number.isSafeInteger(number)) return null;
  const repo = forge.getRepoById(repoId);
  if (repo === undefined) return null;
  if (parsed.kind === 'Issue') {
    const issue = repo.issues.get(number);
    return issue === undefined ? null : { repo, issue };
  }
  if (parsed.kind === 'PullRequest') {
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : { repo, pull };
  }
  return null;
}

/** Introspection data for __type: the fields and enum values each named type carries. */
const TYPE_INFO: Readonly<Record<string, { fields: readonly string[]; enumValues: readonly string[]; kind: string }>> =
  Object.freeze({
    Issue: Object.freeze({
      fields: ['id', 'number', 'title', 'state', 'body'],
      enumValues: [],
      kind: 'OBJECT',
    }),
    PullRequest: Object.freeze({
      fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
      enumValues: [],
      kind: 'OBJECT',
    }),
    Repository: Object.freeze({
      fields: [
        'id',
        'databaseId',
        'name',
        'nameWithOwner',
        'owner',
        'defaultBranchRef',
        'viewerPermission',
        'hasIssuesEnabled',
        'issue',
        'issues',
        'pullRequests',
        'pullRequest',
      ],
      enumValues: [],
      kind: 'OBJECT',
    }),
    SearchType: Object.freeze({
      fields: [],
      enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'MARKETPLACE', 'COMMIT'],
      kind: 'ENUM',
    }),
    User: Object.freeze({ fields: ['id', 'login', 'name', 'email'], enumValues: [], kind: 'OBJECT' }),
    IssueConnection: Object.freeze({
      fields: ['nodes', 'pageInfo', 'totalCount', 'edges'],
      enumValues: [],
      kind: 'OBJECT',
    }),
    PullRequestConnection: Object.freeze({
      fields: ['nodes', 'pageInfo', 'totalCount', 'edges'],
      enumValues: [],
      kind: 'OBJECT',
    }),
    PageInfo: Object.freeze({
      fields: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
      enumValues: [],
      kind: 'OBJECT',
    }),
    Ref: Object.freeze({ fields: ['name', 'prefix'], enumValues: [], kind: 'OBJECT' }),
  });

/** The schema: every type's fields. An absent field is an error naming it. */
const FIELDS: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: {
      type: 'User',
      resolve: () => VIEWER,
    },
    repository: {
      type: 'Repository',
      resolve: (_obj, args, ctx) => {
        if (args.owner !== VIEWER.login) return null;
        return typeof args.name === 'string' ? (ctx.forge.getRepo(args.name) ?? null) : null;
      },
    },
    node: {
      type: (value: unknown) => {
        if (value instanceof Repo) return 'Repository';
        if (isRecord(value) && 'pull' in value) return 'PullRequest';
        return 'Issue';
      },
      resolve: (_obj, args, ctx) => {
        if (typeof args.id !== 'string') return null;
        return decodeNodeId(ctx.forge, args.id);
      },
    },
    __type: {
      type: '__Type',
      resolve: (_obj, args) => {
        if (typeof args.name !== 'string') return null;
        const info = TYPE_INFO[args.name];
        return info === undefined ? null : { name: args.name, ...info };
      },
    },
  },
  User: {
    id: { type: 'ID', resolve: (obj) => String(obj.id ?? '') },
    login: { type: 'String', resolve: (obj) => obj.login },
    name: { type: 'String', resolve: (obj) => obj.name ?? null },
    email: { type: 'String', resolve: (obj) => obj.email ?? null },
  },
  Repository: {
    id: { type: 'ID', resolve: (repo: Repo) => repoGlobalId(repo) },
    databaseId: { type: 'Int', resolve: (repo: Repo) => repo.id },
    name: { type: 'String', resolve: (repo: Repo) => repo.name },
    nameWithOwner: { type: 'String', resolve: (repo: Repo) => repo.fullName },
    description: { type: 'String', resolve: (repo: Repo) => repo.description },
    owner: { type: 'User', resolve: () => VIEWER },
    defaultBranchRef: {
      type: 'Ref',
      resolve: (repo: Repo) => (repo.headTip() === undefined ? null : { name: repo.defaultBranch }),
    },
    viewerPermission: { type: 'String', resolve: () => 'ADMIN' },
    hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
    issue: {
      type: 'Issue',
      resolve: (repo: Repo, args) => {
        const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
        return issue === undefined ? null : ({ repo, issue }) as IssueRef;
      },
    },
    issues: {
      type: 'IssueConnection',
      resolve: (repo: Repo, args) => issueConnection(repo, args),
    },
    pullRequests: {
      type: 'PullRequestConnection',
      resolve: (repo: Repo, args) => pullConnection(repo, args),
    },
    pullRequest: {
      type: 'PullRequest',
      resolve: (repo: Repo, args) => {
        const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
        return pull === undefined ? null : ({ repo, pull }) as PullRef;
      },
    },
  },
  Issue: {
    id: { type: 'ID', resolve: (ref: IssueRef) => issueGlobalId(ref.repo, ref.issue) },
    number: { type: 'Int', resolve: (ref: IssueRef) => ref.issue.number },
    title: { type: 'String', resolve: (ref: IssueRef) => ref.issue.title },
    body: { type: 'String', resolve: (ref: IssueRef) => ref.issue.body },
    state: { type: 'String', resolve: (ref: IssueRef) => (ref.issue.state === 'open' ? 'OPEN' : 'CLOSED') },
    createdAt: { type: 'String', resolve: (ref: IssueRef) => iso(ref.issue.createdAt) },
    updatedAt: { type: 'String', resolve: (ref: IssueRef) => iso(ref.issue.updatedAt) },
    author: { type: 'User', resolve: () => VIEWER },
  },
  PullRequest: {
    id: { type: 'ID', resolve: (ref: PullRef) => pullGlobalId(ref.repo, ref.pull) },
    number: { type: 'Int', resolve: (ref: PullRef) => ref.pull.number },
    title: { type: 'String', resolve: (ref: PullRef) => ref.pull.title },
    body: { type: 'String', resolve: (ref: PullRef) => ref.pull.body },
    state: {
      type: 'String',
      resolve: (ref: PullRef) => (ref.pull.merged ? 'MERGED' : ref.pull.state === 'open' ? 'OPEN' : 'CLOSED'),
    },
    merged: { type: 'Boolean', resolve: (ref: PullRef) => ref.pull.merged },
    headRefName: { type: 'String', resolve: (ref: PullRef) => ref.pull.headRef },
    baseRefName: { type: 'String', resolve: (ref: PullRef) => ref.pull.baseRef },
    mergeable: {
      type: 'String',
      resolve: (ref: PullRef) => {
        if (ref.pull.state !== 'open') return 'UNKNOWN';
        if (ref.repo.branchTip(ref.pull.headRef) === undefined || ref.repo.branchTip(ref.pull.baseRef) === undefined) {
          return 'UNKNOWN';
        }
        return prConflicts(ref.repo, ref.pull).length > 0 ? 'CONFLICTING' : 'MERGEABLE';
      },
    },
    files: {
      type: 'PullRequestFileConnection',
      resolve: (ref: PullRef, args) => {
        const files = prFiles(ref.repo, ref.pull);
        const first = typeof args.first === 'number' && args.first >= 0 ? args.first : files.length;
        const page = files.slice(0, first);
        return {
          nodes: page.map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions })),
          totalCount: files.length,
        };
      },
    },
    createdAt: { type: 'String', resolve: (ref: PullRef) => iso(ref.pull.createdAt) },
    updatedAt: { type: 'String', resolve: (ref: PullRef) => iso(ref.pull.updatedAt) },
    author: { type: 'User', resolve: () => VIEWER },
  },
  IssueConnection: {
    nodes: { type: '[Issue]', resolve: (conn: Record<string, unknown>) => conn.nodes ?? [] },
    totalCount: { type: 'Int', resolve: (conn: Record<string, unknown>) => conn.totalCount ?? 0 },
    pageInfo: { type: 'PageInfo', resolve: (conn: Record<string, unknown>) => conn.pageInfo ?? null },
    edges: {
      type: '[IssueEdge]',
      resolve: (conn: Record<string, unknown>) =>
        ((conn.nodes as IssueRef[] | undefined) ?? []).map((node) => ({
          node,
          cursor: numberToCursor(node.issue.number),
        })),
    },
  },
  PullRequestConnection: {
    nodes: { type: '[PullRequest]', resolve: (conn: Record<string, unknown>) => conn.nodes ?? [] },
    totalCount: { type: 'Int', resolve: (conn: Record<string, unknown>) => conn.totalCount ?? 0 },
    pageInfo: { type: 'PageInfo', resolve: (conn: Record<string, unknown>) => conn.pageInfo ?? null },
    edges: {
      type: '[PullRequestEdge]',
      resolve: (conn: Record<string, unknown>) =>
        ((conn.nodes as PullRef[] | undefined) ?? []).map((node) => ({
          node,
          cursor: numberToCursor(node.pull.number),
        })),
    },
  },
  IssueEdge: {
    node: { type: 'Issue', resolve: (edge: { node: IssueRef }) => edge.node },
    cursor: { type: 'String', resolve: (edge: { cursor: string }) => edge.cursor },
  },
  PullRequestEdge: {
    node: { type: 'PullRequest', resolve: (edge: { node: PullRef }) => edge.node },
    cursor: { type: 'String', resolve: (edge: { cursor: string }) => edge.cursor },
  },
  PageInfo: {
    hasNextPage: { type: 'Boolean', resolve: (info: Record<string, unknown>) => info.hasNextPage ?? false },
    endCursor: { type: 'String', resolve: (info: Record<string, unknown>) => info.endCursor ?? null },
    hasPreviousPage: { type: 'Boolean', resolve: (info: Record<string, unknown>) => info.hasPreviousPage ?? false },
    startCursor: { type: 'String', resolve: (info: Record<string, unknown>) => info.startCursor ?? null },
  },
  Ref: {
    name: { type: 'String', resolve: (ref: { name: string }) => ref.name },
    prefix: { type: 'String', resolve: () => 'refs/heads/' },
  },
  PullRequestFileConnection: {
    nodes: { type: '[PullRequestFile]', resolve: (conn: Record<string, unknown>) => conn.nodes ?? [] },
    totalCount: { type: 'Int', resolve: (conn: Record<string, unknown>) => conn.totalCount ?? 0 },
  },
  PullRequestFile: {
    path: { type: 'String', resolve: (file: { path: string }) => file.path },
    additions: { type: 'Int', resolve: (file: { additions: number }) => file.additions },
    deletions: { type: 'Int', resolve: (file: { deletions: number }) => file.deletions },
  },
  __Type: {
    name: { type: 'String', resolve: (info: { name: string }) => info.name },
    kind: { type: 'String', resolve: (info: { kind: string }) => info.kind },
    fields: {
      type: '[__Field]',
      resolve: (info: { fields: readonly string[] }) => info.fields.map((name) => ({ name })),
    },
    enumValues: {
      type: '[__EnumValue]',
      resolve: (info: { enumValues: readonly string[] }) => info.enumValues.map((name) => ({ name })),
    },
  },
  __Field: {
    name: { type: 'String', resolve: (field: { name: string }) => field.name },
    description: { type: 'String', resolve: () => '' },
  },
  __EnumValue: {
    name: { type: 'String', resolve: (value: { name: string }) => value.name },
    description: { type: 'String', resolve: () => '' },
  },
  IssueComment: {
    id: { type: 'ID', resolve: (ref: CommentRef) => commentGlobalId(ref.repo, ref.comment) },
    body: { type: 'String', resolve: (ref: CommentRef) => ref.comment.body },
    author: { type: 'User', resolve: () => VIEWER },
  },
  CommentEdge: {
    node: { type: 'IssueComment', resolve: (edge: { node: CommentRef }) => edge.node },
    cursor: { type: 'String', resolve: () => null },
  },
  CreateIssuePayload: {
    issue: { type: 'Issue', resolve: (payload: { issue: IssueRef | null }) => payload.issue },
    clientMutationId: { type: 'String', resolve: (payload: { clientMutationId: string | null }) => payload.clientMutationId },
  },
  CloseIssuePayload: {
    issue: { type: 'Issue', resolve: (payload: { issue: IssueRef | null }) => payload.issue },
    clientMutationId: { type: 'String', resolve: (payload: { clientMutationId: string | null }) => payload.clientMutationId },
  },
  CreatePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: (payload: { pullRequest: PullRef | null }) => payload.pullRequest },
    clientMutationId: { type: 'String', resolve: (payload: { clientMutationId: string | null }) => payload.clientMutationId },
  },
  MergePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: (payload: { pullRequest: PullRef | null }) => payload.pullRequest },
    clientMutationId: { type: 'String', resolve: (payload: { clientMutationId: string | null }) => payload.clientMutationId },
  },
  AddCommentPayload: {
    commentEdge: {
      type: 'CommentEdge',
      resolve: (payload: { commentEdge: { node: CommentRef } | null }) => payload.commentEdge,
    },
    clientMutationId: { type: 'String', resolve: (payload: { clientMutationId: string | null }) => payload.clientMutationId },
  },
  Mutation: {
    createIssue: {
      type: 'CreateIssuePayload',
      resolve: (_obj, args, ctx) => {
        const input = isRecord(args.input) ? args.input : {};
        const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
        const decoded = typeof input.repositoryId === 'string' ? decodeNodeId(ctx.forge, input.repositoryId) : null;
        if (!(decoded instanceof Repo)) throw new Error('repository not found');
        const title = typeof input.title === 'string' ? input.title : '';
        if (title === '') throw new Error('title is required');
        const body = typeof input.body === 'string' ? input.body : '';
        const issue = createIssue(ctx.forge, decoded, title, body, []);
        if ('error' in issue) throw new Error(issue.error);
        return { issue: { repo: decoded, issue } as IssueRef, clientMutationId };
      },
    },
    closeIssue: {
      type: 'CloseIssuePayload',
      resolve: (_obj, args, ctx) => {
        const input = isRecord(args.input) ? args.input : {};
        const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
        const decoded = typeof input.issueId === 'string' ? decodeNodeId(ctx.forge, input.issueId) : null;
        if (decoded === null || decoded instanceof Repo || !('issue' in decoded)) throw new Error('issue not found');
        decoded.issue.state = 'closed';
        decoded.issue.updatedAt = nowSec();
        return { issue: decoded as IssueRef, clientMutationId };
      },
    },
    createPullRequest: {
      type: 'CreatePullRequestPayload',
      resolve: (_obj, args, ctx) => {
        const input = isRecord(args.input) ? args.input : {};
        const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
        const decoded = typeof input.repositoryId === 'string' ? decodeNodeId(ctx.forge, input.repositoryId) : null;
        if (!(decoded instanceof Repo)) throw new Error('repository not found');
        const title = typeof input.title === 'string' ? input.title : '';
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        if (title === '' || head === '' || base === '') throw new Error('title, headRefName and baseRefName are required');
        const body = typeof input.body === 'string' ? input.body : '';
        const pull = createPull(ctx.forge, decoded, title, body, head, base);
        if ('error' in pull) throw new Error(pull.error);
        return { pullRequest: { repo: decoded, pull } as PullRef, clientMutationId };
      },
    },
    mergePullRequest: {
      type: 'MergePullRequestPayload',
      resolve: (_obj, args, ctx) => {
        const input = isRecord(args.input) ? args.input : {};
        const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
        const decoded = typeof input.pullRequestId === 'string' ? decodeNodeId(ctx.forge, input.pullRequestId) : null;
        if (decoded === null || decoded instanceof Repo || !('pull' in decoded)) throw new Error('pull request not found');
        const method = input.mergeMethod === 'MERGE' ? 'merge' : input.mergeMethod === 'SQUASH' ? 'squash' : null;
        if (method === null) throw new Error(`merge method ${JSON.stringify(input.mergeMethod)} is not supported`);
        const result = mergePull(decoded.repo, decoded.pull, method);
        if ('error' in result) throw new Error(result.error);
        return { pullRequest: decoded as PullRef, clientMutationId };
      },
    },
    addComment: {
      type: 'AddCommentPayload',
      resolve: (_obj, args, ctx) => {
        const input = isRecord(args.input) ? args.input : {};
        const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
        const decoded = typeof input.subjectId === 'string' ? decodeNodeId(ctx.forge, input.subjectId) : null;
        if (decoded === null || decoded instanceof Repo) throw new Error('subject not found');
        const body = typeof input.body === 'string' ? input.body : '';
        if (body === '') throw new Error('body is required');
        const subject = 'issue' in decoded ? decoded.issue : decoded.pull;
        const comment = addComment(subject, decoded.repo, body);
        return { commentEdge: { node: { repo: decoded.repo, comment } as CommentRef }, clientMutationId };
      },
    },
  },
};

/** Execute one selection set against an object of a type, collecting field errors. */
function executeSelections(
  selections: readonly SelectionNode[],
  obj: unknown,
  typeName: string,
  ctx: Ctx,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === typeName || fragment.typeCondition === 'Node')) {
        Object.assign(data, executeSelections(fragment.selections, obj, typeName, ctx));
      }
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(data, executeSelections(selection.selections, obj, typeName, ctx));
      }
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      data[responseKey] = typeName;
      continue;
    }
    const fieldDef = FIELDS[typeName]?.[selection.name];
    if (fieldDef === undefined) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      data[responseKey] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(selection.args)) args[name] = resolveValue(value, ctx.variables);
    let value: unknown;
    try {
      value = fieldDef.resolve(obj, args, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      data[responseKey] = null;
      continue;
    }
    if (value === null || value === undefined) {
      data[responseKey] = null;
      continue;
    }
    if (selection.selections.length === 0) {
      data[responseKey] = value;
      continue;
    }
    const resultType = typeof fieldDef.type === 'function' ? fieldDef.type(value) : fieldDef.type;
    if (resultType.startsWith('[')) {
      const itemType = resultType.slice(1, -1);
      if (!Array.isArray(value)) {
        data[responseKey] = null;
        continue;
      }
      data[responseKey] = value.map((item) =>
        item === null ? null : executeSelections(selection.selections, item, itemType, ctx),
      );
    } else {
      data[responseKey] = executeSelections(selection.selections, value, resultType, ctx);
    }
  }
  return data;
}

/** Execute one operation document into its {data, errors} envelope. */
function executeOne(forge: Forge, input: unknown): Record<string, unknown> {
  if (!isRecord(input) || typeof input.query !== 'string' || input.query.trim() === '') {
    return { data: null, errors: [{ message: 'query is required' }] };
  }
  let document: DocumentNode;
  try {
    document = new Parser(input.query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const variables = isRecord(input.variables) ? input.variables : {};
  const operationName = typeof input.operationName === 'string' ? input.operationName : null;
  const operation =
    operationName !== null
      ? document.operations.find((candidate) => candidate.name === operationName)
      : (document.operations[0] as OperationNode | undefined);
  if (operation === undefined) {
    return { data: null, errors: [{ message: `unknown operation ${JSON.stringify(operationName)}` }] };
  }
  const ctx: Ctx = { forge, variables, errors: [], fragments: document.fragments };
  const rootType = operation.op === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(operation.selections, {}, rootType, ctx);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

/**
 * POST /api/graphql: one operation document, or a JSON array of them answered in order. A
 * GraphQL-level failure (unknown field, bad argument) is a 200 whose body carries `errors`.
 */
export function handleGraphQL(forge: Forge, body: unknown): { status: number; body: unknown } {
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => executeOne(forge, entry)) };
  }
  return { status: 200, body: executeOne(forge, body) };
}
