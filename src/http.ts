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
  if (error && typeof error === "object")
    return {
      message: typeof error.message === "string" ? error.message : undefined,
      code: typeof error.code === "string" ? error.code : undefined,
    };
  return {};
}

export interface NodeResponse<T> {
  body: T;
  headers: Headers;
}

export async function request<T>(
  node: string,
  path: string,
  init: RequestInit & { key?: string; timeoutMs?: number } = {}
): Promise<NodeResponse<T>> {
  const { key, timeoutMs = 15_000, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (key) headers.set("Authorization", `Bearer ${key}`);
  if (rest.body) headers.set("Content-Type", "application/json");
  let res: Response;
  try {
    res = await fetch(`${node}${path}`, {
      ...rest,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const reason = e instanceof Error && e.name === "TimeoutError" ? "timed out" : "unreachable";
    throw new NodeError(node, 0, `${new URL(node).host} is ${reason}`);
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const error = readError(body);
    throw new NodeError(
      node,
      res.status,
      error.message ?? (typeof body === "string" && body ? body.slice(0, 200) : res.statusText),
      error.code
    );
  }
  return { body: body as T, headers: res.headers };
}
