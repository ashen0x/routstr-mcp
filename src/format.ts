import fs from "node:fs";

export const version: string = JSON.parse(
  fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")
).version;

const trim = (value: string) => value.replace(/\.?0+$/, "");

/** 1,987.4 · 12.4 · 0.042 */
export function sats(value: number): string {
  if (value >= 100) return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (value >= 1) return trim(value.toFixed(1));
  return trim(value.toFixed(3)) || "0";
}

/** Sats per million tokens, from a per-token rate. */
export const perMillion = (rate: number) => Math.round(rate * 1_000_000).toLocaleString("en-US");

export const host = (node: string) => new URL(node).host;

/** " · 120 sats left there", on the node, or in routstrd when it paid the node */
export const satsLeft = (balance?: number, via?: string) => (balance === undefined ? "" : ` · ${sats(balance)} sats left ${via ? `in ${via}` : "there"}`);

export function tokens(count: number | undefined): string {
  if (!count) return "?";
  return count >= 1_000_000 ? `${trim((count / 1_000_000).toFixed(1))}M` : `${Math.round(count / 1000)}k`;
}
