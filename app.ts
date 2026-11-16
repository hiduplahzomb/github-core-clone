// The HTTP server: one Node http server, one Forge, and the router that ties the surfaces
// together. Every response carries a non-empty X-GitHub-Request-Id and, for JSON surfaces, an
// application/json content type — including errors. The bearer token is MAKEFUN_SHOP_TOKEN (the
// same token the suite presents); without it configured the server allows all requests, which is
// only for local development — a trial always sets it.
//
// Routing:
//   GET  /healthz                          the boot probe, no auth
//   GET  /api/v3/                          the API root, no auth (as on GitHub)
//   /api/v3/...                            REST v3, bearer auth
//   POST /api/graphql                      GraphQL v4, bearer auth
//   POST /mcp                              MCP, bearer auth
//   /{owner}/{repo}.git/info/refs          git advertisement, bearer auth
//   /{owner}/{repo}.git/git-upload-pack    clone/fetch, bearer auth
//   /{owner}/{repo}.git/git-receive-pack   push, bearer auth
//   anything else                          JSON 404
//
// A handler that throws never takes the server down: the request answers 500 and the process
// keeps serving (the suite proves the server stays healthy after a malformed packet).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { GitHttpError, handleInfoRefs, handleReceivePack, handleUploadPack } from './src/git-http.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest } from './src/rest.ts';
import { Forge } from './src/store.ts';
import { VIEWER, nextRequestId } from './src/util.ts';

/** The largest request body the server reads (a push pack is at most a few hundred KiB here). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Read a request's whole body, rejecting when it passes the size cap. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

/** Whether the request's Authorization header carries the configured token. `bearer` is the
 * precomputed `Bearer <token>` string (empty when no token is configured: allow all). */
function authorized(req: IncomingMessage, bearer: string): boolean {
  if (bearer === '') return true;
  return (req.headers.authorization ?? '') === bearer;
}

/** Send a JSON response with the request id. A null body sends an empty body (204/202). */
function sendJson(res: ServerResponse, requestId: string, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = body === null || body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(payload);
}

/** Send a pre-serialized JSON payload with the request id, without stringifying again. */
function sendJsonRaw(res: ServerResponse, requestId: string, status: number, payload: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(payload);
}

/** Send a binary response (a git advertisement, pack or report) with the request id. */
function sendRaw(res: ServerResponse, requestId: string, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': requestId,
  });
  res.end(body);
}

/** Split a path into decoded segments, dropping a trailing slash. Null on a bad escape.
 * Segments without a '%' carry no escape and skip the decoder. */
function splitPath(pathname: string): string[] | null {
  const trimmed = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (trimmed === '' || trimmed === '/') return [];
  const parts = trimmed.split('/').filter((part) => part !== '');
  try {
    return parts.map((part) => (part.includes('%') ? decodeURIComponent(part) : part));
  } catch {
    return null;
  }
}

/** Create the server. The caller binds it (main.ts listens on an ephemeral port). */
export function createApp(): Server {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const bearer = token === '' ? '' : `Bearer ${token}`;
  const server = createServer((req, res) => {
    void handleRequest(forge, bearer, req, res).catch((err) => {
      process.stderr.write(`[entry] unhandled request error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      if (!res.headersSent) {
        try {
          sendJson(res, nextRequestId(), 500, { message: 'Internal Server Error' });
        } catch {
          res.destroy();
        }
      } else {
        res.destroy();
      }
    });
  });
  return server;
}

async function handleRequest(forge: Forge, bearer: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = nextRequestId();
  const method = (req.method ?? 'GET').toUpperCase();
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    sendJson(res, requestId, 400, { message: 'Bad Request' });
    return;
  }
  const segments = splitPath(url.pathname);
  if (segments === null) {
    sendJson(res, requestId, 400, { message: 'Bad Request' });
    return;
  }

  // The boot probe: no auth, no body.
  if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
    sendJson(res, requestId, 200, { ok: true });
    return;
  }

  const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

  // REST v3.
  if (segments[0] === 'api' && segments[1] === 'v3') {
    const rest = segments.slice(2);
    const isRoot = rest.length === 0 && method === 'GET';
    if (!isRoot && !authorized(req, bearer)) {
      sendJson(res, requestId, 401, { message: 'Bad credentials' });
      return;
    }
    let parsed: unknown;
    if (body.length > 0) {
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(res, requestId, 400, { message: 'Problems parsing JSON' });
        return;
      }
    }
    try {
      const result = handleRest(forge, method, rest, url.searchParams, parsed, req.headers.host ?? 'localhost');
      if (result.rawBody !== undefined) {
        sendJsonRaw(res, requestId, result.status, result.rawBody, result.headers ?? {});
      } else {
        sendJson(res, requestId, result.status, result.body, result.headers ?? {});
      }
    } catch (err) {
      process.stderr.write(`[entry] REST error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      sendJson(res, requestId, 500, { message: 'Internal Server Error' });
    }
    return;
  }

  // GraphQL v4.
  if (segments[0] === 'api' && segments[1] === 'graphql' && segments.length === 2) {
    if (method !== 'POST') {
      sendJson(res, requestId, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!authorized(req, bearer)) {
      sendJson(res, requestId, 401, { message: 'Bad credentials' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, requestId, 400, { data: null, errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    try {
      const result = handleGraphQL(forge, parsed);
      sendJson(res, requestId, result.status, result.body);
    } catch (err) {
      process.stderr.write(`[entry] GraphQL error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      sendJson(res, requestId, 500, { data: null, errors: [{ message: 'Internal Server Error' }] });
    }
    return;
  }

  // MCP.
  if (segments.length === 1 && segments[0] === 'mcp') {
    if (method !== 'POST') {
      sendJson(res, requestId, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!authorized(req, bearer)) {
      sendJson(res, requestId, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } });
      return;
    }
    try {
      const result = handleMcp(forge, body);
      sendJson(res, requestId, result.status, result.body);
    } catch (err) {
      process.stderr.write(`[entry] MCP error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      sendJson(res, requestId, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
    }
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}.
  const gitService =
    segments.length >= 3 && segments[1] !== undefined && segments[1].endsWith('.git')
      ? segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs'
        ? 'info/refs'
        : segments.length === 3 && (segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack')
          ? (segments[2] as string)
          : null
      : null;
  if (gitService !== null) {
    const owner = segments[0] as string;
    const repoName = (segments[1] as string).slice(0, -'.git'.length);
    if (!authorized(req, bearer)) {
      sendJson(res, requestId, 401, { message: 'Bad credentials' });
      return;
    }
    if (owner !== VIEWER.login) {
      sendJson(res, requestId, 404, { message: 'Not Found' });
      return;
    }
    const repo = forge.getRepo(repoName);
    if (repo === undefined) {
      sendJson(res, requestId, 404, { message: 'Not Found' });
      return;
    }
    try {
      if (gitService === 'info/refs') {
        if (method !== 'GET') {
          sendJson(res, requestId, 405, { message: 'Method Not Allowed' });
          return;
        }
        const service = url.searchParams.get('service') ?? '';
        const protocol = req.headers['git-protocol'];
        const result = handleInfoRefs(repo, service, Array.isArray(protocol) ? protocol[0] : protocol);
        sendRaw(res, requestId, 200, result.contentType, result.body);
        return;
      }
      if (method !== 'POST') {
        sendJson(res, requestId, 405, { message: 'Method Not Allowed' });
        return;
      }
      const result =
        gitService === 'git-upload-pack' ? handleUploadPack(repo, body) : handleReceivePack(repo, body);
      sendRaw(res, requestId, 200, result.contentType, result.body);
    } catch (err) {
      if (err instanceof GitHttpError) {
        sendJson(res, requestId, err.status, { message: err.message });
        return;
      }
      process.stderr.write(`[entry] git error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      sendJson(res, requestId, 500, { message: 'Internal Server Error' });
    }
    return;
  }

  sendJson(res, requestId, 404, { message: 'Not Found' });
}
