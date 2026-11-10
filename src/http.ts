import http from "node:http";
import https from "node:https";

export class NodeError extends Error {
  constructor(
    readonly node: string,
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
  }
}

interface ErrorBody {
  message?: string;
  code?: string;
}

/** Core answers errors as a string detail, `{detail: {error}}` or `{error}`. */
function readError(body: unknown): ErrorBody {
  if (!body || typeof body !== "object") return {};
  const record = body as Record<string, unknown>;
  const detail = record.detail;
  if (typeof detail === "string") return { message: detail };
  const error = (detail && typeof detail === "object"
    ? (detail as Record<string, unknown>).error
    : record.error) as Record<string, unknown> | string | undefined;
  if (typeof error === "string") return { message: error };
  if (error && typeof error === "object") {
    // a generic "Provider returned error" keeps the real reason in metadata.raw
    const raw = (error.metadata as { raw?: unknown } | undefined)?.raw;
    const message = typeof error.message === "string" ? error.message : undefined;
    return {
      message: typeof raw === "string" && raw ? `${message ?? "error"}: ${raw}` : message,
      code: typeof error.code === "string" ? error.code : undefined,
    };
  }
  return {};
}

/**
 * Status 0 with code "unreachable" means no connection was ever made, so the node never saw the request.
 * Once connected, a failure is "lost": the node may have taken the request and charged for it.
 */
function networkError(node: string, timedOut: boolean, connected: boolean, cancelled = false): NodeError {
  if (cancelled)
    return new NodeError(node, 0, connected ? `Cancelled after ${new URL(node).host} got the request, so it may still charge for it` : "Cancelled", "cancelled");
  const what = timedOut ? "timed out" : connected ? "dropped the connection" : "is unreachable";
  return new NodeError(node, 0, `${new URL(node).host} ${what}`, connected ? "lost" : "unreachable");
}

/** Model lists and answers are well under this; a node sending more is cut off before it can fill memory. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface NodeResponse<T> {
  body: T;
  headers: Headers;
}

/**
 * node:http rather than fetch: fetch gives up on any answer after 300 s, which a slow reasoning model
 * can need, and it cannot tell whether the request reached the node, which decides if retrying elsewhere
 * could pay twice. A fresh connection each time keeps that exact (a pooled one can be closed under us).
 * Redirects are not followed.
 */
export async function request<T>(
  node: string,
  path: string,
  init: { method?: string; body?: string; key?: string; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<NodeResponse<T>> {
  const { method = "GET", body: payload, key, timeoutMs = 15_000 } = init;
  const url = new URL(`${node}${path}`);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (payload) headers["Content-Type"] = "application/json";
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([timeout, init.signal]) : timeout;
  let connected = false;

  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).request(url, { method, headers, signal, agent: false }, resolve);
    req.once("socket", (socket) => {
      if (!socket.connecting) connected = true;
      else socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => (connected = true));
    });
    req.once("error", reject);
    req.end(payload);
  }).catch(() => {
    throw networkError(node, timeout.aborted, connected, init.signal?.aborted);
  });

  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of res as AsyncIterable<Buffer>) {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        res.destroy();
        throw new NodeError(node, 0, `${url.host} sent an answer over ${MAX_BODY_BYTES >> 20} MB`, "too_big");
      }
      chunks.push(chunk);
    }
  } catch (e) {
    if (e instanceof NodeError) throw e;
    throw networkError(node, timeout.aborted, true, init.signal?.aborted);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  const status = res.statusCode ?? 0;
  if (status < 200 || status > 299) {
    const error = readError(body);
    const message = error.message ?? (typeof body === "string" && body ? body : res.statusMessage ?? `status ${status}`);
    // node text goes to the agent: one line, short, no control characters
    throw new NodeError(node, status, message.replace(/[\p{C}\s]+/gu, " ").trim().slice(0, 300), error.code);
  }
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    try {
      if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
    } catch {
      // a header fetch would refuse is dropped, not fatal
    }
  }
  return { body: body as T, headers: responseHeaders };
}
