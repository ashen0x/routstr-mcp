import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { NodeError, request } from "./http.js";
import { normalizeNode } from "./market.js";

/**
 * The wallet holds Routstr API keys, one per node. A key's balance lives on its node, so
 * the most anything can ever spend is what was paid in. Keys and invoices are secrets:
 * whoever holds a create invoice can recover its key, so neither ever reaches the agent.
 */
export interface Key {
  node: string;
  key: string;
  addedAt: number;
}

export interface Pending {
  node: string;
  invoiceId: string;
  bolt11: string;
  sats: number;
  /** set for a top-up of an existing key */
  key?: string;
  expiresAt: number;
}

interface WalletFile {
  version: 1;
  keys: Key[];
  pending: Pending[];
}

const walletFile = () => path.join(config.home, "wallet.json");
const lockFile = () => path.join(config.home, "wallet.lock");

export function readWallet(): WalletFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(walletFile(), "utf8")) as WalletFile;
    return { version: 1, keys: parsed.keys ?? [], pending: parsed.pending ?? [] };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, keys: [], pending: [] };
    throw new Error(`Cannot read ${walletFile()}: ${(e as Error).message}`);
  }
}

function writeWallet(wallet: WalletFile) {
  fs.mkdirSync(config.home, { recursive: true, mode: 0o700 });
  const tmp = `${walletFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(wallet, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, walletFile());
}

const LOCK_STALE_MS = 10_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read, change and write the wallet under a lock, so the server and the CLI never lose each other's writes. */
async function updateWallet<T>(change: (wallet: WalletFile) => T): Promise<T> {
  fs.mkdirSync(config.home, { recursive: true, mode: 0o700 });
  for (let tries = 0; ; tries++) {
    try {
      fs.closeSync(fs.openSync(lockFile(), "wx"));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lockFile()).mtimeMs > LOCK_STALE_MS) fs.rmSync(lockFile(), { force: true });
      } catch {
        /* the holder just released it */
      }
      // wait past the stale age, so a lock left by a crashed process is cleared rather than failing the write
      if (tries * 25 > LOCK_STALE_MS + 5000) throw new Error(`The wallet is locked by another process (${lockFile()})`);
      await sleep(25);
    }
  }
  try {
    const wallet = readWallet();
    const result = change(wallet);
    writeWallet(wallet);
    return result;
  } finally {
    fs.rmSync(lockFile(), { force: true });
  }
}

export const keyFor = (node: string) => readWallet().keys.find((k) => k.node === normalizeNode(node));

interface InvoiceCreated {
  invoice_id: string;
  bolt11: string;
  amount_sats: number;
  expires_at: number;
}

/** Asks the node for a Lightning invoice: a top-up when a key for that node exists, else a new key. */
export async function createInvoice(nodeUrl: string, sats: number): Promise<Pending> {
  const node = normalizeNode(nodeUrl);
  const existing = keyFor(node);
  const { body } = await request<InvoiceCreated>(node, "/lightning/invoice", {
    method: "POST",
    key: existing?.key,
    body: JSON.stringify({ amount_sats: sats, purpose: existing ? "topup" : "create" }),
  });
  const pending: Pending = {
    node,
    invoiceId: body.invoice_id,
    bolt11: body.bolt11,
    sats: body.amount_sats,
    key: existing?.key,
    expiresAt: body.expires_at,
  };
  // recorded before anyone can pay it, so a crash after payment still finds the key
  await updateWallet((wallet) => wallet.pending.push(pending));
  return pending;
}

export type InvoiceState = "paid" | "waiting" | "expired";

/** Checks one invoice and moves a paid one into the wallet. Safe to repeat. */
export async function settleInvoice(pending: Pending): Promise<InvoiceState> {
  const { body } = await request<{ status: string; api_key?: string | null }>(
    pending.node,
    `/lightning/invoice/${encodeURIComponent(pending.invoiceId)}/status`
  );
  if (body.status === "paid") {
    const key = body.api_key ?? pending.key;
    await updateWallet((wallet) => {
      if (key && !wallet.keys.some((k) => k.node === pending.node && k.key === key))
        wallet.keys.push({ node: pending.node, key, addedAt: Date.now() });
      wallet.pending = wallet.pending.filter((p) => p.invoiceId !== pending.invoiceId);
    });
    return "paid";
  }
  if (body.status === "expired") {
    await updateWallet((wallet) => {
      wallet.pending = wallet.pending.filter((p) => p.invoiceId !== pending.invoiceId);
    });
    return "expired";
  }
  return "waiting";
}

/** Picks up invoices paid since the last look, e.g. after a fund command was stopped. */
export async function settleAll(): Promise<void> {
  await Promise.allSettled(readWallet().pending.map(settleInvoice));
}

export interface Balance {
  node: string;
  sats?: number;
  reservedSats?: number;
  error?: string;
}

export async function balanceOf(key: Key): Promise<Balance> {
  try {
    const { body } = await request<{ balance: number; reserved: number }>(key.node, "/v1/balance/info", {
      key: key.key,
    });
    if (!Number.isFinite(body?.balance)) throw new Error(`${new URL(key.node).host} sent a balance that is not a number`);
    return { node: key.node, sats: body.balance / 1000, reservedSats: Number.isFinite(body.reserved) ? body.reserved / 1000 : 0 };
  } catch (e) {
    return { node: key.node, error: (e as Error).message };
  }
}

export async function balances(): Promise<Balance[]> {
  await settleAll();
  return Promise.all(readWallet().keys.map(balanceOf));
}

export interface Refund {
  node: string;
  sats?: number;
  /** a Cashu token when no Lightning address was given */
  token?: string;
  sentTo?: string;
  error?: string;
}

/**
 * Takes a key's whole balance back, to a Lightning address or as a Cashu token, and drops
 * the key once the node confirms. Asking again after a crash returns the same refund.
 */
export async function refundKey(key: Key, lightningAddress?: string): Promise<Refund> {
  try {
    const { body } = await request<{ token?: string; sats?: string; msats?: string; recipient?: string }>(
      key.node,
      "/v1/balance/refund",
      {
        method: "POST",
        key: key.key,
        body: lightningAddress ? JSON.stringify({ lightning_address: lightningAddress }) : undefined,
        timeoutMs: 60_000,
      }
    );
    const sats = body.sats !== undefined ? Number(body.sats) : body.msats !== undefined ? Number(body.msats) / 1000 : undefined;
    if (body.token) saveRefundToken(key.node, body.token);
    await updateWallet((wallet) => {
      wallet.keys = wallet.keys.filter((k) => k.key !== key.key);
    });
    return { node: key.node, sats, token: body.token, sentTo: body.recipient };
  } catch (e) {
    return { node: key.node, error: e instanceof NodeError ? e.message : String(e) };
  }
}

function saveRefundToken(node: string, token: string) {
  const dir = path.join(config.home, "refunds");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${new URL(node).host}-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
  fs.writeFileSync(path.join(dir, name), `${token}\n`, { mode: 0o600 });
}

export const refundFile = () => path.join(config.home, "refunds");

/** Adds a key you already have (for example from Routstr Chat) after the node confirms it. */
export async function importKey(nodeUrl: string, key: string): Promise<Balance> {
  const node = normalizeNode(nodeUrl);
  if (!/^sk-[A-Za-z0-9_-]+$/.test(key)) throw new Error("That is not a Routstr API key (they start with sk-).");
  const balance = await balanceOf({ node, key, addedAt: 0 });
  if (balance.error) throw new Error(`${new URL(node).host} did not accept the key: ${balance.error}`);
  await updateWallet((wallet) => {
    if (!wallet.keys.some((k) => k.node === node && k.key === key)) wallet.keys.push({ node, key, addedAt: Date.now() });
  });
  return balance;
}
