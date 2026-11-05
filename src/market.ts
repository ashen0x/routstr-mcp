import fs from "node:fs";
import path from "node:path";
import { SimplePool } from "nostr-tools/pool";
import { verifyEvent, type Event } from "nostr-tools/pure";
import { config } from "./config.js";
import { request } from "./http.js";

/** One model as one node sells it. Rates are sats per token. */
export interface Offer {
  node: string;
  id: string;
  name: string;
  aliases: string[];
  context?: number;
  maxOutput?: number;
  promptRate: number;
  completionRate: number;
}

const POSITIVE = new Set(["trusted", "verified", "lgtm", "lgtm2"]);
const NEGATIVE = new Set(["suspicious", "avoid", "blacklisted", "removed"]);
const FUTURE_SLACK_S = 3600;
const NODE_LIST_TTL_MS = 20 * 60_000;
const MODELS_TTL_MS = 5 * 60_000;

export function normalizeNode(url: string): string {
  const parsed = new URL(url.includes("://") ? url : `https://${url}`);
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/** Announced URLs are only used when they are public HTTPS hosts, never a LAN, localhost or onion. */
export function isPublicUrl(url: string): boolean {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (!host.includes(".") && !host.includes(":")) return false;
  if (/(^|\.)(localhost|local|lan|internal|home\.arpa|onion)$/.test(host)) return false;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return !(
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (host.includes(":")) return !/^(::|::1|f[cd]|fe[89ab]|::ffff:)/.test(host);
  return true;
}

const tag = (event: Event, name: string) =>
  event.tags.find((t) => t[0] === name && typeof t[1] === "string" && t[1])?.[1];

const newer = (a: Event, b: Event) =>
  a.created_at > b.created_at || (a.created_at === b.created_at && a.id > b.id);

function announcedUrls(event: Event): string[] {
  const urls = event.tags.filter((t) => t[0] === "u" && t[1]).map((t) => t[1]!);
  if (urls.length) return urls;
  try {
    const content = JSON.parse(event.content);
    const providers: unknown[] = Array.isArray(content) ? content : content?.providers ?? [];
    return providers
      .map((p) => (p as { endpoint_url?: unknown })?.endpoint_url)
      .filter((u): u is string => typeof u === "string");
  } catch {
    return [];
  }
}

/**
 * The SDK's rule: a node URL is used when some pubkey announcing it (kind 38421) has a
 * positive latest review from the curator (kind 38425) and none has a negative one.
 */
export function approvedNodes(
  announcements: Event[],
  reviews: Event[],
  curator: string,
  nowS = Math.floor(Date.now() / 1000)
): string[] {
  const trusted = (event: Event) =>
    event.created_at <= nowS + FUTURE_SLACK_S && verifyEvent(event);

  const latestAnnouncement = new Map<string, Event>();
  for (const event of announcements) {
    if (event.kind !== 38421 || !trusted(event)) continue;
    const address = `${event.pubkey}:${tag(event, "d") ?? ""}`;
    const previous = latestAnnouncement.get(address);
    if (!previous || newer(event, previous)) latestAnnouncement.set(address, event);
  }

  const latestReview = new Map<string, Event>();
  for (const event of reviews) {
    if (event.kind !== 38425 || event.pubkey !== curator || !tag(event, "t") || !trusted(event)) continue;
    for (const t of event.tags) {
      if (t[0] !== "node" || !t[1]) continue;
      const previous = latestReview.get(t[1]);
      if (!previous || newer(event, previous)) latestReview.set(t[1], event);
    }
  }
  const label = (pubkey: string) => {
    const review = latestReview.get(pubkey);
    return review && tag(review, "t")?.trim().toLowerCase();
  };

  const announcers = new Map<string, Set<string>>();
  for (const event of latestAnnouncement.values()) {
    for (const raw of announcedUrls(event)) {
      let url: string;
      try {
        url = normalizeNode(raw);
      } catch {
        continue;
      }
      if (!isPublicUrl(url)) continue;
      if (!announcers.has(url)) announcers.set(url, new Set());
      announcers.get(url)!.add(event.pubkey);
    }
  }

  return [...announcers]
    .filter(([, pubkeys]) => {
      const labels = [...pubkeys].map(label);
      return labels.some((l) => l && POSITIVE.has(l)) && !labels.some((l) => l && NEGATIVE.has(l));
    })
    .map(([url]) => url)
    .sort();
}

async function discoverNodes(): Promise<string[]> {
  const pool = new SimplePool();
  try {
    const [announcements, reviews] = await Promise.all([
      pool.querySync(config.relays, { kinds: [38421], limit: 100 }, { maxWait: 6000 }),
      pool.querySync(config.relays, { kinds: [38425], authors: [config.curator], limit: 500 }, { maxWait: 6000 }),
    ]);
    return approvedNodes(announcements, reviews, config.curator);
  } finally {
    pool.destroy();
  }
}

interface NodeListCache {
  fetchedAt: number;
  nodes: string[];
}

/** Approved node URLs: ROUTSTR_NODES if set, else Nostr discovery, cached on disk for 20 minutes. */
export async function nodeUrls(force = false): Promise<string[]> {
  if (config.nodes) return config.nodes.map(normalizeNode);
  const file = path.join(config.home, "nodes.json");
  let cached: NodeListCache | undefined;
  try {
    cached = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    cached = undefined;
  }
  if (!force && cached && Date.now() - cached.fetchedAt < NODE_LIST_TTL_MS && cached.nodes.length)
    return cached.nodes;
  let nodes: string[] = [];
  try {
    nodes = await discoverNodes();
  } catch {
    nodes = [];
  }
  if (!nodes.length) {
    if (cached?.nodes.length) return cached.nodes;
    throw new Error("Could not find any approved Routstr node on Nostr. Set ROUTSTR_NODES to a node URL to skip discovery.");
  }
  fs.mkdirSync(config.home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), nodes } satisfies NodeListCache));
  return nodes;
}

interface RawModel {
  id: string;
  name?: string;
  alias_ids?: string[] | null;
  context_length?: number;
  enabled?: boolean;
  architecture?: { output_modalities?: string[] };
  top_provider?: { context_length?: number | null; max_completion_tokens?: number | null } | null;
  sats_pricing?: { prompt?: number; completion?: number } | null;
}

/** Text models a node prices in sats. Zero-priced models are left out: their real price is unknown. */
export function parseOffers(node: string, models: RawModel[]): Offer[] {
  return models
    .filter((m) => m.enabled !== false && typeof m.id === "string")
    .filter((m) => (m.architecture?.output_modalities ?? ["text"]).includes("text"))
    .filter((m) => (m.sats_pricing?.prompt ?? 0) > 0 && (m.sats_pricing?.completion ?? 0) > 0)
    .map((m) => ({
      node,
      id: m.id,
      name: m.name || m.id,
      aliases: m.alias_ids ?? [],
      context: m.top_provider?.context_length ?? m.context_length,
      maxOutput: m.top_provider?.max_completion_tokens ?? undefined,
      promptRate: m.sats_pricing!.prompt!,
      completionRate: m.sats_pricing!.completion!,
    }));
}

export class Market {
  private cache?: { at: number; offers: Offer[]; reached: string[]; missed: string[] };

  async load(force = false) {
    if (!force && this.cache && Date.now() - this.cache.at < MODELS_TTL_MS) return this.cache;
    const urls = await nodeUrls(force);
    const results = await Promise.allSettled(
      urls.map(async (node) => {
        const { body } = await request<{ data?: RawModel[] }>(node, "/v1/models", { timeoutMs: 10_000 });
        return parseOffers(node, body?.data ?? []);
      })
    );
    const offers: Offer[] = [];
    const reached: string[] = [];
    const missed: string[] = [];
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        offers.push(...result.value);
        reached.push(urls[i]!);
      } else missed.push(urls[i]!);
    });
    this.cache = { at: Date.now(), offers, reached, missed };
    return this.cache;
  }
}

const bare = (id: string) => id.toLowerCase().split("/").pop()!;

/** Offers for a model name: exact id or alias first, else the same name without its maker prefix. */
export function offersFor(offers: Offer[], model: string): Offer[] {
  const wanted = model.trim().toLowerCase();
  const exact = offers.filter(
    (o) => o.id.toLowerCase() === wanted || o.aliases.some((a) => a.toLowerCase() === wanted)
  );
  if (exact.length) return exact;
  return offers.filter((o) => bare(o.id) === bare(wanted));
}

export interface ModelSummary {
  id: string;
  name: string;
  nodes: number;
  context?: number;
  cheapest: Offer;
}

/** Models matching every word of the query, one row per model id, cheapest node first. */
export function searchModels(offers: Offer[], query = ""): ModelSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const byId = new Map<string, Offer[]>();
  for (const offer of offers) {
    const haystack = `${offer.id} ${offer.name} ${offer.aliases.join(" ")}`.toLowerCase();
    if (!words.every((w) => haystack.includes(w))) continue;
    const key = offer.id.toLowerCase();
    byId.set(key, [...(byId.get(key) ?? []), offer]);
  }
  return [...byId.values()]
    .map((group) => {
      const cheapest = group.reduce((a, b) => (unitCost(b) < unitCost(a) ? b : a));
      return {
        id: cheapest.id,
        name: cheapest.name,
        nodes: new Set(group.map((o) => o.node)).size,
        context: cheapest.context,
        cheapest,
      };
    })
    .sort((a, b) => unitCost(a.cheapest) - unitCost(b.cheapest));
}

/** The cost of a typical tool call (2,000 tokens in, 1,000 out), used to rank nodes and models. */
export const unitCost = (offer: Offer) => 2000 * offer.promptRate + 1000 * offer.completionRate;
