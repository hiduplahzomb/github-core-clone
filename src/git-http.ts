// Git smart HTTP: the wire a real git client speaks — info/refs advertisements, upload-pack
// (clone/fetch, protocol v2 and v0) and receive-pack (push). The framing is pkt-lines; the
// objects are real git objects from the store; the packs are plain version-2 packs.
//
// Protocol v2 is advertised when the client asks for it (Git-Protocol: version=2 on info/refs);
// v0 is the fallback and the only protocol receive-pack speaks. The response shapes follow the
// protocol documents (gitprotocol-v2, gitprotocol-pack) and the suite's client, which parses
// sections, sidebands and report-status strictly.

import {
  collectReachable,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
} from './git-objects.ts';
import { EMPTY_PACK, readPack, writePack } from './pack.ts';
import { DELIM, FLUSH, dataLines, parsePktLines, pktLine, pktLines, type Packet } from './pktline.ts';
import { storeObject, storeObjectWithOid, type Repo } from './store.ts';
import { DEFAULT_BRANCH, ZERO_OID } from './util.ts';

/** The agent string the forge advertises itself with. */
export const AGENT = 'github-core-clone/1.0';

/** An HTTP error the router renders as a JSON {message} body. */
export class GitHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The sideband chunk a pack is split into (a pkt-line holds at most 65520 bytes). */
const SIDEBAND_CHUNK = 32768;

/** One sideband packet: a band byte (1 = data) plus a slice of the payload. */
function sidebandPacket(band: 1 | 2 | 3, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

/** A whole buffer as band-1 sideband packets, chunked. At least one packet, even when empty. */
function sidebandData(data: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  if (data.length === 0) {
    packets.push(sidebandPacket(1, Buffer.alloc(0)));
    return packets;
  }
  for (let at = 0; at < data.length; at += SIDEBAND_CHUNK) {
    packets.push(sidebandPacket(1, data.subarray(at, Math.min(data.length, at + SIDEBAND_CHUNK))));
  }
  return packets;
}

// ---------------------------------------------------------------- advertisements

/** The v0 capabilities upload-pack advertises on its first ref line. */
const UPLOAD_CAPS_V0 = [
  'side-band-64k',
  'thin-pack',
  'ofs-delta',
  'multi_ack_detailed',
  'shallow',
  `symref=HEAD:refs/heads/${DEFAULT_BRANCH}`,
  `agent=${AGENT}`,
].join(' ');

/** The v0 capabilities receive-pack advertises. No report-status-v2: plain report-status is simpler. */
const RECEIVE_CAPS_V0 = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`].join(' ');

/** Refs in advertisement order: HEAD first, then refs sorted by name. */
function orderedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const head = repo.headTip();
  const out: Array<{ name: string; oid: string }> = [];
  if (head !== undefined) out.push({ name: 'HEAD', oid: head });
  out.push(...refs);
  return out;
}

/** The peeled target of an annotated tag ref, or undefined when the ref is not one. */
function peeledTarget(repo: Repo, refOid: string): string | undefined {
  const object = repo.objects.get(refOid);
  if (object === undefined || object.type !== 'tag') return undefined;
  return parseTag(object.data).object;
}

/** The v2 capability advertisement (upload-pack only). Constant bytes: computed once. */
const ADVERTISE_V2: Buffer = pktLines([
  '# service=git-upload-pack\n',
  'flush',
  'version 2\n',
  `agent=${AGENT}\n`,
  'ls-refs=unborn\n',
  'fetch=shallow filter\n',
  'object-format=sha1\n',
  'flush',
]);

function advertiseV2(): Buffer {
  return ADVERTISE_V2;
}

/** The v0 ref advertisement for a service. An empty repository advertises capabilities^{} only. */
function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const refs = orderedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.name !== 'HEAD') {
        const peeled = peeledTarget(repo, ref.oid);
        if (peeled !== undefined) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** GET info/refs: v2 when the client asked for it on upload-pack, v0 otherwise. */
export function handleInfoRefs(
  repo: Repo,
  service: string,
  gitProtocol: string | undefined,
): { contentType: string; body: Buffer } {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    throw new GitHttpError(400, `unknown git service ${JSON.stringify(service)}`);
  }
  const wantsV2 = service === 'git-upload-pack' && (gitProtocol ?? '').includes('version=2');
  if (wantsV2) {
    return { contentType: 'application/x-git-upload-pack-advertisement', body: advertiseV2() };
  }
  return {
    contentType: `application/x-${service}-advertisement`,
    body: advertiseV0(repo, service),
  };
}

// ---------------------------------------------------------------- fetch planning

/** A parsed fetch request: what the client wants, has, and how deep it wants to go. */
export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenRelative: boolean;
  deepenSince: number | null;
  deepenNot: string[];
  filter: string | null;
  done: boolean;
}

/** What a fetch sends back: the objects, the new shallow boundaries, and the acknowledgments. */
export interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/** A commit plus its whole tree (no parents): what a shallow clone holds for its tip. */
function commitContents(objects: ReadonlyMap<string, GitObject>, commitOid: string): Set<string> {
  const found = new Set<string>([commitOid]);
  const object = objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return found;
  const treeOid = parseCommit(object.data).tree;
  const queue = [treeOid];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (found.has(oid)) continue;
    const entry = objects.get(oid);
    if (entry === undefined) continue;
    found.add(oid);
    if (entry.type === 'tree') {
      for (const child of parseTree(entry.data)) {
        if (child.mode !== '160000') queue.push(child.oid);
      }
    } else if (entry.type === 'tag') {
      queue.push(parseTag(entry.data).object);
    }
  }
  return found;
}

/** Peel a want through annotated tags to its ultimate target, returning the tag chain too. */
function peelWant(objects: ReadonlyMap<string, GitObject>, oid: string): { target: string; tags: string[] } {
  const tags: string[] = [];
  let current = oid;
  for (;;) {
    const object = objects.get(current);
    if (object === undefined || object.type !== 'tag') return { target: current, tags };
    tags.push(current);
    current = parseTag(object.data).object;
  }
}

/**
 * Plan a fetch: which objects to pack, which commits become the client's new shallow boundary,
 * which of its shallow commits are now complete, and which of its haves the server knows.
 *
 * The walk starts at the wants (depth 1) and descends through parents, stopping at the depth
 * limit, at commits older than deepen-since, and at deepen-not cuts. Held commits are not sent,
 * but the walk passes through them: a held commit above a shallow boundary has unheld ancestors
 * behind it, and that is what deepen and unshallow fetches are for. Objects reachable from a
 * held commit are never re-sent.
 */
export function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const objects = repo.objects;
  const acks = args.haves.filter((oid) => objects.has(oid));
  const haveSet = new Set(args.haves);
  const clientShallow = new Set(args.shallow);

  // What the client already holds, as objects: everything reachable from a non-shallow have or a
  // deepen-not tip, plus a shallow have's own commit and tree (but not its parents). The two
  // exclusion reasons stay separate: a parent cut off by deepen-not makes its child a shallow
  // boundary, a parent the client already holds does not. The walk from the held tips stops at
  // the client's shallow commits — their parents are NOT held (that is what makes them shallow),
  // so a plain reachable-set from the tips would wrongly exclude the whole history below a
  // shallow boundary and an unshallow fetch would send nothing.
  const excluded = new Set<string>();
  const excludedCommits = new Set<string>();
  const heldCommits = new Set<string>();
  const excludedByNot = new Set<string>();
  const notTips: string[] = [];
  for (const ref of args.deepenNot) {
    const resolved = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? (isOid(ref) ? ref : undefined);
    if (resolved !== undefined) notTips.push(resolved);
  }
  const heldTips = args.haves.filter((oid) => !clientShallow.has(oid));
  const heldQueue = [...heldTips];
  const heldSeen = new Set<string>();
  while (heldQueue.length > 0) {
    const oid = heldQueue.pop() as string;
    if (heldSeen.has(oid)) continue;
    heldSeen.add(oid);
    const object = objects.get(oid);
    if (object === undefined) continue;
    excluded.add(oid);
    if (object.type === 'commit') {
      excludedCommits.add(oid);
      heldCommits.add(oid);
      const commit = parseCommit(object.data);
      heldQueue.push(commit.tree);
      if (!clientShallow.has(oid)) {
        for (const parent of commit.parents) heldQueue.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const child of parseTree(object.data)) {
        if (child.mode !== '160000') heldQueue.push(child.oid);
      }
    } else if (object.type === 'tag') {
      heldQueue.push(parseTag(object.data).object);
    }
  }
  for (const oid of collectReachable(objects, notTips)) {
    excluded.add(oid);
    excludedByNot.add(oid);
    if (objects.get(oid)?.type === 'commit') excludedCommits.add(oid);
  }
  for (const oid of args.shallow) {
    if (!haveSet.has(oid)) continue;
    for (const held of commitContents(objects, oid)) excluded.add(held);
    excludedCommits.add(oid);
    heldCommits.add(oid);
  }

  // deepen-relative: the deepen value counts from the client's current shallow boundary, not
  // from the wants. The boundary commits' depth from the wants (tip = depth 1) plus the deepen
  // value is the absolute limit; when no shallow commit is reachable from the wants, the
  // absolute value stands. The boundary is normally close to the tips, so this walk stops as
  // soon as every shallow commit is found.
  let depthLimit = args.depth;
  if (args.depth !== null && args.deepenRelative && args.shallow.length > 0) {
    const targets = new Set(args.shallow);
    const found = new Map<string, number>();
    const seen = new Map<string, number>();
    const probe: string[] = [];
    for (const want of args.wants) {
      const { target } = peelWant(objects, want);
      if (objects.get(target)?.type === 'commit' && !seen.has(target)) {
        seen.set(target, 1);
        probe.push(target);
      }
    }
    while (probe.length > 0 && found.size < targets.size) {
      const oid = probe.shift() as string;
      const depth = seen.get(oid) as number;
      if (targets.has(oid)) found.set(oid, depth);
      const object = objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!seen.has(parent) && objects.has(parent)) {
          seen.set(parent, depth + 1);
          probe.push(parent);
        }
      }
    }
    if (found.size > 0) depthLimit = Math.max(...found.values()) + args.depth;
  }

  // The commit walk: BFS from the wants, depth 1 at the tip.
  const sendCommits = new Set<string>();
  const shallow = new Set<string>();
  const extraObjects = new Set<string>();
  const depthOf = new Map<string, number>();
  const queue: string[] = [];
  for (const want of args.wants) {
    const { target, tags } = peelWant(objects, want);
    for (const tag of tags) extraObjects.add(tag);
    const object = objects.get(target);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      if (!depthOf.has(target)) {
        depthOf.set(target, 1);
        queue.push(target);
      }
    } else {
      extraObjects.add(target);
      if (object.type === 'tree' || object.type === 'tag') {
        for (const oid of collectReachable(objects, [target])) extraObjects.add(oid);
      }
    }
  }
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const depth = depthOf.get(oid) as number;
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    const atLimit = depthLimit !== null && depth >= depthLimit;
    const tooOld = args.deepenSince !== null && commit.committerTs < args.deepenSince;
    const cutByNot = commit.parents.some((parent) => excludedByNot.has(parent) && !heldCommits.has(parent));
    if (!excludedCommits.has(oid)) {
      sendCommits.add(oid);
      if (atLimit || tooOld || cutByNot) {
        shallow.add(oid);
        continue;
      }
    }
    // The walk continues through held commits too: a held commit above a shallow boundary has
    // unheld ancestors behind it (that is what an unshallow fetch is for), so stopping at held
    // commits would miss them. The depth limit and the cuts still bound the walk.
    if (atLimit || tooOld || cutByNot) continue;
    for (const parent of commit.parents) {
      if (!depthOf.has(parent) && objects.has(parent)) {
        depthOf.set(parent, depth + 1);
        queue.push(parent);
      }
    }
  }

  // The object set: every sent commit's contents, the extra objects, minus what the client holds.
  const included = new Set<string>(extraObjects);
  for (const oid of sendCommits) {
    for (const held of commitContents(objects, oid)) included.add(held);
  }
  for (const oid of excluded) included.delete(oid);

  // A filter trims the set further: blob:none drops every blob, blob:limit=N drops blobs over N
  // bytes, tree:0 drops trees and blobs alike.
  if (args.filter !== null) {
    if (args.filter === 'blob:none') {
      for (const oid of [...included]) if (objects.get(oid)?.type === 'blob') included.delete(oid);
    } else if (args.filter.startsWith('blob:limit=')) {
      const limit = Number.parseInt(args.filter.slice('blob:limit='.length), 10);
      if (Number.isFinite(limit)) {
        for (const oid of [...included]) {
          const object = objects.get(oid);
          if (object?.type === 'blob' && object.data.length > limit) included.delete(oid);
        }
      }
    } else if (args.filter === 'tree:0') {
      for (const oid of [...included]) {
        const type = objects.get(oid)?.type;
        if (type === 'tree' || type === 'blob') included.delete(oid);
      }
    }
  }

  // Unshallow: a client shallow commit whose parents the client now holds — sent in this fetch,
  // held already, or reachable from a held commit.
  const unshallow: string[] = [];
  for (const oid of args.shallow) {
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    const complete = parents.every((parent) => sendCommits.has(parent) || haveSet.has(parent) || excludedCommits.has(parent));
    if (complete) unshallow.push(oid);
  }

  const packed = [...included]
    .sort()
    .map((oid) => objects.get(oid))
    .filter((object): object is GitObject => object !== undefined);
  return {
    objects: packed,
    shallow: [...shallow].sort(),
    unshallow: unshallow.sort(),
    acks,
  };
}

// ---------------------------------------------------------------- upload-pack (v2)

/** A parsed ls-refs request: which attributes to include and which refs to list. */
interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(lines: readonly string[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of lines) {
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

/** A parsed v2 request: the command line before the delimiter, the arguments after it. */
function parseV2(packets: readonly Packet[]): { command: string; args: string[] } {
  let command = '';
  const args: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      // agent= and object-format= lines are acknowledged by ignoring them.
    } else {
      args.push(line);
    }
  }
  return { command, args };
}

/**
 * Parse fetch arguments from pkt-lines, v2 or v0. A v0 want line can carry capabilities after
 * the oid (`want <oid> side-band-64k ...`), so only the first token after the keyword is the oid.
 */
function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = {
    wants: [],
    haves: [],
    shallow: [],
    depth: null,
    deepenRelative: false,
    deepenSince: null,
    deepenNot: [],
    filter: null,
    done: false,
  };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim().split(' ')[0] as string);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim().split(' ')[0] as string);
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7), 10);
      if (Number.isFinite(n)) args.depth = n;
    } else if (line === 'deepen-relative') args.deepenRelative = true;
    else if (line.startsWith('deepen-since ')) {
      const n = Number.parseInt(line.slice(13), 10);
      if (Number.isFinite(n)) args.deepenSince = n;
    } else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    else if (line.startsWith('filter ')) args.filter = line.slice(7).trim();
    else if (line === 'done') args.done = true;
    // thin-pack, no-progress, ofs-delta and the like are acknowledged by ignoring them.
  }
  return args;
}

/** ls-refs: HEAD first (unborn when the default branch has no commit), then the matching refs. */
function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const include = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const head = repo.headTip();
  if (head === undefined) {
    if (args.unborn && include('HEAD')) {
      lines.push(pktLine(`unborn HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n`));
    }
  } else if (include('HEAD')) {
    let line = `${head} HEAD`;
    if (args.symrefs) line += ` symref-target:refs/heads/${DEFAULT_BRANCH}`;
    lines.push(pktLine(`${line}\n`));
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [name, oid] of refs) {
    if (!include(name)) continue;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const peeled = peeledTarget(repo, oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

/**
 * The cache key for an upload-pack fetch response. It names everything the response can depend
 * on: the protocol version and the `done` flag (they shape the sections), the resolved fetch
 * arguments (wants, haves, shallow boundaries, depth, filters — sorted, since their order does
 * not change the plan), the deepen-not refs resolved to oids (refs are the one input the plan
 * reads through names), and the object store's size. Objects are content-addressed and immutable
 * and only ever added, so the store's size is a complete fingerprint of what a fetch can see:
 * while the size is unchanged, no object appeared or vanished, and the plan for these arguments
 * is the same bytes. A push, a ref create, or a contents write grows the store (or resolves a
 * deepen-not ref differently) and misses the cache, so a cached response can never go stale.
 */
function fetchCacheKey(repo: Repo, version: 0 | 2, args: FetchArgs): string {
  const deepenNot: string[] = [];
  for (const ref of args.deepenNot) {
    const resolved = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? (isOid(ref) ? ref : undefined);
    if (resolved !== undefined) deepenNot.push(resolved);
  }
  return JSON.stringify({
    v: version,
    n: repo.objects.size,
    w: [...args.wants].sort(),
    h: [...args.haves].sort(),
    s: [...args.shallow].sort(),
    d: args.depth,
    dr: args.deepenRelative,
    ds: args.deepenSince,
    dn: deepenNot.sort(),
    f: args.filter,
    done: args.done,
  });
}

/** The most fetch responses one repository keeps; the oldest goes first when it fills. */
const FETCH_CACHE_MAX = 128;

/** Serve a fetch response from the repository's cache when this exact fetch ran before. */
function cachedFetch(repo: Repo, version: 0 | 2, args: FetchArgs, compute: () => Buffer): Buffer {
  const key = fetchCacheKey(repo, version, args);
  const hit = repo.fetchCache.get(key);
  if (hit !== undefined) return hit;
  const body = compute();
  if (repo.fetchCache.size >= FETCH_CACHE_MAX) {
    const oldest = repo.fetchCache.keys().next().value;
    if (oldest !== undefined) repo.fetchCache.delete(oldest);
  }
  repo.fetchCache.set(key, body);
  return body;
}

/**
 * The v2 fetch response, following git's client state machine (fetch-pack.c do_fetch_pack_v2):
 * when the client sent `done` it is already in get-pack state and expects the shallow-info
 * section, if any, then the packfile — no acknowledgments section at all. When the client sent
 * haves without `done` it is still negotiating, so the answer is the acknowledgments section
 * alone (ACKs, or NAK when nothing is held) ending in a bare flush; the client then sends
 * another fetch request carrying `done` for the pack. A have-less fetch (a fresh clone) also
 * gets no acknowledgments section. A missing want is a band-3 fatal in the packfile section.
 * An empty send is still a valid 32-byte empty pack in one band-1 packet — a packfile section
 * with no packets is a protocol error to the client.
 */
function handleFetchV2(repo: Repo, args: FetchArgs): Buffer {
  return cachedFetch(repo, 2, args, () => computeFetchV2(repo, args));
}

function computeFetchV2(repo: Repo, args: FetchArgs): Buffer {
  const missing = args.wants.filter((oid) => !repo.objects.has(oid));
  const plan = missing.length === 0 ? planFetch(repo, args) : null;
  const parts: Buffer[] = [];
  if (args.haves.length > 0 && !args.done) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan !== null && plan.acks.length > 0) {
      for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    // No `ready`, so no delimiter either — a delimiter would read as "another section
    // follows", which real git rejects after an acknowledgments section without `ready`.
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  if (plan !== null && (plan.shallow.length > 0 || plan.unshallow.length > 0)) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(pktLine('packfile\n'));
  if (plan === null) {
    parts.push(sidebandPacket(3, Buffer.from(`want ${missing[0] as string} not found\n`, 'utf8')));
  } else {
    const pack = plan.objects.length === 0 ? EMPTY_PACK : writePack(plan.objects);
    parts.push(...sidebandData(pack));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The v0 fetch response: shallow/unshallow lines, NAK or ACKs, then the sideband pack. */
function handleFetchV0(repo: Repo, args: FetchArgs): Buffer {
  return cachedFetch(repo, 0, args, () => computeFetchV0(repo, args));
}

function computeFetchV0(repo: Repo, args: FetchArgs): Buffer {
  const missing = args.wants.filter((oid) => !repo.objects.has(oid));
  const plan = missing.length === 0 ? planFetch(repo, args) : null;
  const parts: Buffer[] = [];
  if (plan !== null) {
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    if (plan.acks.length > 0) {
      for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    const pack = plan.objects.length === 0 ? EMPTY_PACK : writePack(plan.objects);
    parts.push(...sidebandData(pack));
  } else {
    parts.push(sidebandPacket(3, Buffer.from(`want ${missing[0] as string} not found\n`, 'utf8')));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** Parse every pkt-line in a buffer, across flush boundaries (a v0 fetch has two sections). */
function allPackets(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let rest = buffer;
  while (rest.length > 0) {
    const parsed = parsePktLines(rest);
    packets.push(...parsed.packets);
    if (parsed.rest.length === rest.length) break;
    rest = parsed.rest;
  }
  return packets;
}

/** POST git-upload-pack: v2 when the first line is a command, v0 when it is a want line. */
export function handleUploadPack(repo: Repo, body: Buffer): { contentType: string; body: Buffer } {
  let packets: Packet[];
  try {
    packets = allPackets(body);
  } catch (err) {
    throw new GitHttpError(400, `malformed upload-pack request: ${err instanceof Error ? err.message : String(err)}`);
  }
  const first = packets.find((packet) => packet.kind === 'data');
  const firstLine = first !== undefined && first.kind === 'data' ? first.payload.toString('utf8').replace(/\n$/, '') : '';
  const contentType = 'application/x-git-upload-pack-result';
  if (firstLine.startsWith('command=')) {
    const { command, args } = parseV2(packets);
    if (command === 'ls-refs') return { contentType, body: handleLsRefs(repo, parseLsRefsArgs(args)) };
    if (command === 'fetch') return { contentType, body: handleFetchV2(repo, parseFetchArgs(args)) };
    throw new GitHttpError(400, `unknown upload-pack command ${JSON.stringify(command)}`);
  }
  if (firstLine.startsWith('want ')) {
    return { contentType, body: handleFetchV0(repo, parseFetchArgs(dataLines(packets))) };
  }
  throw new GitHttpError(400, 'upload-pack request has no command or want line');
}

// ---------------------------------------------------------------- receive-pack

/** One push command: `<old> <new> <ref>`. */
interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/**
 * Apply one push command: null when the ref moved, else the ng reason. The old oid must match
 * the ref, the new oid must be in the store, and an update must be a fast-forward (the new tip
 * descends from the old). The reason for a refused non-fast-forward is exactly
 * `non-fast-forward`; creates and deletes have no fast-forward test.
 */
function applyPushCommand(repo: Repo, command: PushCommand): string | null {
  if (!command.ref.startsWith('refs/')) return 'invalid ref name';
  const current = repo.refs.get(command.ref);
  if (command.oldOid === ZERO_OID) {
    if (current !== undefined) return 'ref already exists';
  } else if (current !== command.oldOid) {
    return 'old object id does not match';
  }
  if (command.newOid === ZERO_OID) {
    if (current === undefined) return 'ref does not exist';
    repo.refs.delete(command.ref);
    return null;
  }
  if (!repo.objects.has(command.newOid)) return 'new object does not exist';
  if (current !== undefined && current !== command.newOid && !isAncestor(repo.objects, command.newOid, current)) {
    return 'non-fast-forward';
  }
  repo.refs.set(command.ref, command.newOid);
  return null;
}

/**
 * POST git-receive-pack: read the command list, unpack the pack that follows it (empty for a
 * delete-only push), apply each command on its own merits, and report with report-status. The
 * report is a pkt-line stream carried in sideband band 1 when the client asked for sideband
 * (one report line per band-1 packet, a flush inside band 1, then the outer flush), or plain
 * pkt-lines otherwise. Objects stay stored even when their ref update is refused.
 */
export function handleReceivePack(repo: Repo, body: Buffer): { contentType: string; body: Buffer } {
  let parsed: { packets: Packet[]; rest: Buffer };
  try {
    parsed = parsePktLines(body);
  } catch (err) {
    throw new GitHttpError(400, `malformed receive-pack request: ${err instanceof Error ? err.message : String(err)}`);
  }
  const commands: PushCommand[] = [];
  let sideband = false;
  let first = true;
  for (const packet of parsed.packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (first) {
      first = false;
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        sideband = line.slice(nul + 1).split(' ').includes('side-band-64k');
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length !== 3 || !isOid(parts[0] as string) || !isOid(parts[1] as string)) {
      throw new GitHttpError(400, `malformed push command ${JSON.stringify(line.slice(0, 80))}`);
    }
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  if (commands.length === 0) throw new GitHttpError(400, 'receive-pack request has no commands');

  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackError: string | null = null;
  if (parsed.rest.length > 0) {
    try {
      const objects = readPack(parsed.rest, (oid) => repo.objects.get(oid));
      for (const object of objects) storeObjectWithOid(repo, object.oid, object.type, object.data);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  } else if (updatesRef) {
    unpackError = 'missing packfile';
  }

  const report: string[] = [];
  if (unpackError !== null) {
    report.push(`unpack ${unpackError}`);
    for (const command of commands) report.push(`ng ${command.ref} unpacker error`);
  } else {
    report.push('unpack ok');
    for (const command of commands) {
      const refusal = applyPushCommand(repo, command);
      report.push(refusal === null ? `ok ${command.ref}` : `ng ${command.ref} ${refusal}`);
    }
  }

  const parts: Buffer[] = [];
  if (sideband) {
    for (const line of report) parts.push(sidebandPacket(1, pktLine(`${line}\n`)));
    parts.push(sidebandPacket(1, FLUSH));
  } else {
    for (const line of report) parts.push(pktLine(`${line}\n`));
    parts.push(FLUSH);
  }
  parts.push(FLUSH);
  return { contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(parts) };
}
