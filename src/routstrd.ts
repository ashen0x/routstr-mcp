import { config } from "./config.js";
import { request } from "./http.js";
import { normalizeNode } from "./market.js";

export interface Routstrd {
  /** the nodes it can pay */
  nodes: Set<string>;
  /** in its wallet and its keys on nodes */
  sats: number;
}

/** routstrd, when it runs on this machine. */
export async function routstrd(): Promise<Routstrd | undefined> {
  if (!config.routstrd) return undefined;
  try {
    const [{ body: listed }, { body: balance }] = await Promise.all([
      request<{ output?: { providers?: unknown } } | null>(config.routstrd, "/providers", { timeoutMs: 3000 }),
      request<{ output?: { total?: unknown } } | null>(config.routstrd, "/keys/balance", { timeoutMs: 3000 }),
    ]);
    const sats = Number(balance?.output?.total);
    if (!Number.isFinite(sats)) return undefined;
    const providers = Array.isArray(listed?.output?.providers) ? (listed.output.providers as { baseUrl?: unknown; disabled?: unknown }[]) : [];
    const urls = providers.flatMap((p) => (typeof p?.baseUrl === "string" && URL.canParse(p.baseUrl) && !p.disabled ? [normalizeNode(p.baseUrl)] : []));
    return { nodes: new Set(urls), sats };
  } catch {
    return undefined;
  }
}
