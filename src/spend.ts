import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/** One paid call. `unsure` means the call was lost after the node got it, so `sats` is its cap, not a known cost. */
export interface SpendEntry {
  at: string;
  model: string;
  node: string;
  sats: number;
  purpose: string;
  unsure?: boolean;
}

const spendFile = () => path.join(config.home, "spend.jsonl");

/** Never fails the call it records: an answer the user paid for still reaches them if the log cannot be written. */
export function logSpend(entry: Omit<SpendEntry, "at">) {
  try {
    fs.mkdirSync(config.home, { recursive: true, mode: 0o700 });
    fs.appendFileSync(spendFile(), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  } catch {
    /* the node's own record of the charge stands */
  }
}

export function readSpend(sinceMs = 0): SpendEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(spendFile(), "utf8");
  } catch {
    return [];
  }
  const entries: SpendEntry[] = [];
  for (const line of raw.split("\n")) {
    try {
      const e = JSON.parse(line) as SpendEntry;
      if (Number.isFinite(e.sats) && Date.parse(e.at) >= sinceMs) entries.push(e);
    } catch {
      /* a torn last line from a crash */
    }
  }
  return entries;
}

export const startOfToday = () => new Date().setHours(0, 0, 0, 0);

export const spentToday = () => readSpend(startOfToday()).reduce((sum, e) => sum + e.sats, 0);

let held = 0;

/** What may still be spent today under ROUTSTR_DAILY_SATS, counting what calls in flight may cost. */
export function allowance(): number {
  return config.dailySats === undefined ? Infinity : config.dailySats - spentToday() - held;
}

/** Sets sats aside for a call in flight, so calls running at once cannot pass the daily limit together. */
export function hold(sats: number): () => void {
  held += sats;
  let released = false;
  return () => {
    if (!released) held -= sats;
    released = true;
  };
}
