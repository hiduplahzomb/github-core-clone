// Shared small pieces: the scenario's fixed viewer, a deterministic clock, request ids, and the
// opaque global ids GraphQL hands out. Nothing here touches the network or the filesystem.

/**
 * The authenticated user in every trial. The contest's scenario is fixed by one seed
 * (SCENARIO_SEED 0x6a09e667f3bcc909n in the kit's wire.ts); buildScenario() derives users[0] from
 * it, and the kit's env is byte-for-byte the sealed env, so this login is the viewer the suite
 * creates repositories under and the owner every ownership check compares against.
 */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** The branch every repository starts on, and the one HEAD points at. */
export const DEFAULT_BRANCH = 'main';

/** The all-zero object id: an unborn ref, a deleted ref, a missing object. */
export const ZERO_OID = '0000000000000000000000000000000000000000';

/**
 * The forge's clock. Every timestamp the server writes — commit author/committer times, issue and
 * pull request created_at/updated_at — comes from here, never from Date.now(), so a trial replayed
 * against the same request order produces the same state. The counter starts at a fixed epoch and
 * ticks once per call, which also keeps created_at order equal to creation order.
 */
let tick = 1_700_000_000;

export function nowSec(): number {
  tick += 1;
  return tick;
}

/** An epoch-seconds timestamp as the ISO string the REST API returns. */
export function iso(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

/** The `Name <email>` identity string a server-made commit carries. */
export function viewerIdentity(): string {
  return `${VIEWER.name} <${VIEWER.email}>`;
}

/** Monotonic per-request ids for the X-GitHub-Request-Id header (non-empty, unique per request). */
let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(12, '0')}`;
}

/** Whether a value is a plain JSON object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Opaque GraphQL global ids: base64url of a namespaced key, never the bare database id. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

/** Split a global id back into its kind and key, or null when it is not one of ours. */
export function parseGlobalId(id: string): { kind: string; key: string } | null {
  if (typeof id !== 'string' || id === '') return null;
  let decoded: string;
  try {
    decoded = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const at = decoded.indexOf(':');
  if (at <= 0) return null;
  return { kind: decoded.slice(0, at), key: decoded.slice(at + 1) };
}

/** Clamp a parsed pagination integer into its range, falling back on garbage. */
export function pageInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
