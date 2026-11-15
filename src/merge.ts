// Diffs and merges over the object store: the pull request files view and the squash/merge
// commit. Everything here works on flattened trees (path -> blob), so a diff is a per-path
// comparison and a merge is a per-path three-way decision against the merge-base.

import { buildTreeFromFlat, commitTree, commitTreeNow, flattenTree, type FlatEntry, type PullRequest, type Repo } from './store.ts';
import { nowSec } from './util.ts';

/** One file of a pull request's diff, in the REST v3 files shape. */
export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Split text into lines; a trailing newline does not make an empty last line. */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * How many lines an edit adds and deletes: the minimal edit script's counts, from the longest
 * common subsequence length (additions = new lines outside the LCS, deletions = old lines
 * outside it). Two rows of DP suffice for the length. Past a million cells the DP is swapped for
 * a multiset count, which is linear and exact for the common add/remove-only edits.
 */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length * newLines.length > 1_000_000) {
    const countOf = (lines: string[]): Map<string, number> => {
      const counts = new Map<string, number>();
      for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
      return counts;
    };
    const oldCounts = countOf(oldLines);
    const newCounts = countOf(newLines);
    let additions = 0;
    let deletions = 0;
    for (const [line, count] of newCounts) additions += Math.max(0, count - (oldCounts.get(line) ?? 0));
    for (const [line, count] of oldCounts) deletions += Math.max(0, count - (newCounts.get(line) ?? 0));
    return { additions, deletions };
  }
  let prev = new Uint32Array(newLines.length + 1);
  let curr = new Uint32Array(newLines.length + 1);
  for (let i = 1; i <= oldLines.length; i += 1) {
    for (let j = 1; j <= newLines.length; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j] as number, curr[j - 1] as number);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  const lcs = prev[newLines.length] as number;
  return { additions: newLines.length - lcs, deletions: oldLines.length - lcs };
}

/** A blob's bytes as text (binary blobs read with replacement characters; counts stay sane). */
function blobText(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'blob') return '';
  return object.data.toString('utf8');
}

/**
 * The file diff from one tree to another, sorted by path: added, removed and changed files with
 * their line counts. A mode-only change with identical content is not a file change.
 */
export function diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): FileDiff[] {
  const base = flattenTree(repo, baseTreeOid);
  const head = flattenTree(repo, headTreeOid);
  const paths = [...new Set([...base.keys(), ...head.keys()])].sort();
  const diffs: FileDiff[] = [];
  for (const path of paths) {
    const before = base.get(path);
    const after = head.get(path);
    if (before === undefined && after !== undefined) {
      const additions = splitLines(blobText(repo, after.oid)).length;
      diffs.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (before !== undefined && after === undefined) {
      const deletions = splitLines(blobText(repo, before.oid)).length;
      diffs.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (before !== undefined && after !== undefined && before.oid !== after.oid) {
      const { additions, deletions } = lineDiffCounts(blobText(repo, before.oid), blobText(repo, after.oid));
      diffs.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return diffs;
}

/**
 * The three-way merge of two trees against their base, per path: a path both sides agree on
 * stays as agreed; a path only one side changed takes that side; a path both sides changed
 * differently is a conflict (added-in-both-different and deleted-vs-modified included). The
 * result is the merged flat tree plus the conflicting paths.
 */
export function threeWayMerge(
  repo: Repo,
  baseTreeOid: string | null,
  oursTreeOid: string | null,
  theirsTreeOid: string | null,
): { flat: Map<string, FlatEntry>; conflicts: string[] } {
  const base = flattenTree(repo, baseTreeOid);
  const ours = flattenTree(repo, oursTreeOid);
  const theirs = flattenTree(repo, theirsTreeOid);
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const flat = new Map<string, FlatEntry>();
  const conflicts: string[] = [];
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (o?.oid === t?.oid) {
      if (o !== undefined) flat.set(path, o);
    } else if (o?.oid === b?.oid) {
      if (t !== undefined) flat.set(path, t);
    } else if (t?.oid === b?.oid) {
      if (o !== undefined) flat.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  return { flat, conflicts: conflicts.sort() };
}

/**
 * A pull request's files: the diff of its head against the merge-base, which is the base tip
 * recorded when the pull request was created.
 */
export function prFiles(repo: Repo, pull: PullRequest): FileDiff[] {
  const baseTree = commitTree(repo, pull.baseSha);
  const headTree = commitTree(repo, pull.headSha);
  return diffTrees(repo, baseTree, headTree);
}

/**
 * A pull request's conflicting paths, from the three-way merge of the current base tip and the
 * head tip against the base tip recorded at creation. An empty list means mergeable.
 */
export function prConflicts(repo: Repo, pull: PullRequest): string[] {
  const baseTree = commitTree(repo, pull.baseSha);
  const currentBase = repo.branchTip(pull.baseRef);
  const oursTree = currentBase === undefined ? null : commitTree(repo, currentBase);
  const theirsTree = commitTree(repo, pull.headSha);
  if (baseTree === null || oursTree === null || theirsTree === null) return [];
  return threeWayMerge(repo, baseTree, oursTree, theirsTree).conflicts;
}

/**
 * Merge an open pull request onto its base branch. Squash lands one commit (parent: the base
 * tip) whose tree is the three-way result; merge lands a two-parent commit with the same tree.
 * A conflicted or already-closed pull request is refused with 405, as GitHub refuses it.
 */
export function mergePull(
  repo: Repo,
  pull: PullRequest,
  method: 'squash' | 'merge',
): { sha: string } | { error: string; status: number } {
  if (pull.merged) return { error: 'pull request is already merged', status: 405 };
  if (pull.state !== 'open') return { error: 'pull request is closed', status: 405 };
  const currentBase = repo.branchTip(pull.baseRef);
  if (currentBase === undefined) return { error: `base branch "${pull.baseRef}" does not exist`, status: 422 };
  const baseTree = commitTree(repo, pull.baseSha);
  const oursTree = commitTree(repo, currentBase);
  const theirsTree = commitTree(repo, pull.headSha);
  if (baseTree === null || oursTree === null || theirsTree === null) {
    return { error: 'the pull request branches are missing commits', status: 422 };
  }
  const { flat, conflicts } = threeWayMerge(repo, baseTree, oursTree, theirsTree);
  if (conflicts.length > 0) return { error: `merge conflict in ${conflicts.join(', ')}`, status: 405 };
  const treeOid = buildTreeFromFlat(repo, flat);
  const message =
    method === 'squash'
      ? `${pull.title} (#${pull.number})\n`
      : `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
  const parents = method === 'squash' ? [currentBase] : [currentBase, pull.headSha];
  const sha = commitTreeNow(repo, treeOid, parents, message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowSec();
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  return { sha };
}
