// Git objects: the four types, their SHA-1 identity, and their on-disk bytes. Every object the
// forge stores or sends is a real git object — a client that hashes what it receives gets the oid
// the server advertised. No git binary is involved anywhere; these are the formats from git's own
// documentation (gitformat-object, gitformat-commit, gitformat-tree, gitformat-tag).

import { createHash } from 'node:crypto';

/** The four git object types. */
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

/** One object: its type and its raw bytes (the payload after the `<type> <size>\0` header). */
export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** Whether a string is a 40-hex lowercase object id. */
export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** The SHA-1 identity of an object: sha1(`<type> <size>\0` + bytes). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** One tree entry: an octal mode, a name, and the oid it points at. */
export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/**
 * Encode a tree: entries sorted git-style (by name, with a directory's name compared as `name/`),
 * each `<mode> <name>\0<20-byte oid>`. Tree modes are written without a leading zero (`40000`).
 */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const left = a.mode === '40000' ? `${a.name}/` : a.name;
    const right = b.mode === '40000' ? `${b.name}/` : b.name;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Decode a tree's entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** A parsed commit: its tree, parents, identities, timestamps and message. */
export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  authorTs: number;
  committer: string;
  committerTs: number;
  message: string;
}

/** The identity line of a commit header: `Name <email> <epoch> +0000`. */
function identityLine(who: string, timestamp: number): string {
  return `${who} ${timestamp} +0000`;
}

/**
 * Encode a commit: `tree`, one `parent` per parent, `author`, `committer`, a blank line, then the
 * message verbatim. All timestamps are UTC (`+0000`).
 */
export function buildCommit(options: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines = [`tree ${options.tree}`];
  for (const parent of options.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${identityLine(options.author, options.timestamp)}`);
  lines.push(`committer ${identityLine(options.committer, options.timestamp)}`);
  return Buffer.from(`${lines.join('\n')}\n\n${options.message}`, 'utf8');
}

const IDENTITY_RE = /^(.*) (\d+) ([+-]\d{4})$/;

/** Decode a commit. Unknown header lines (gpgsig, encoding, mergetag) are ignored, not rejected. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let authorTs = 0;
  let committer = '';
  let committerTs = 0;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const match = IDENTITY_RE.exec(line.slice(7));
      if (match) {
        author = match[1] ?? '';
        authorTs = Number.parseInt(match[2] ?? '0', 10);
      } else author = line.slice(7);
    } else if (line.startsWith('committer ')) {
      const match = IDENTITY_RE.exec(line.slice(10));
      if (match) {
        committer = match[1] ?? '';
        committerTs = Number.parseInt(match[2] ?? '0', 10);
      } else committer = line.slice(10);
    }
  }
  return { tree, parents, author, authorTs, committer, committerTs, message };
}

/** A parsed annotated tag. */
export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Encode an annotated tag. */
export function buildTag(options: { object: string; type: string; tag: string; tagger: string; timestamp: number; message: string }): Buffer {
  const lines = [
    `object ${options.object}`,
    `type ${options.type}`,
    `tag ${options.tag}`,
    `tagger ${identityLine(options.tagger, options.timestamp)}`,
  ];
  return Buffer.from(`${lines.join('\n')}\n\n${options.message}`, 'utf8');
}

/** Decode an annotated tag. */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7).trim();
  }
  return { object, type, tag, tagger, message };
}

/**
 * Walk a commit's ancestry (all parents, not just first) and report whether `ancestor` is
 * reachable from `tip` — the fast-forward test. Both must be commits in the store; a missing
 * object answers false rather than throwing.
 */
export function isAncestor(objects: ReadonlyMap<string, GitObject>, tip: string, ancestor: string): boolean {
  if (tip === ancestor) return true;
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/**
 * Every object reachable from `tips`: commits walk their trees and parents, trees their entries,
 * tags their targets. Gitlinks (mode 160000) point outside the repository and are skipped. The
 * result includes the tips themselves when they are in the store.
 */
export function collectReachable(objects: ReadonlyMap<string, GitObject>, tips: readonly string[]): Set<string> {
  const found = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (found.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) continue;
    found.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return found;
}

/** The first-parent chain from `tip`, newest first, stopping at the store's edge. */
export function firstParentChain(objects: ReadonlyMap<string, GitObject>, tip: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = tip;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const object = objects.get(current);
    if (object === undefined || object.type !== 'commit') break;
    chain.push(current);
    current = parseCommit(object.data).parents[0];
  }
  return chain;
}
