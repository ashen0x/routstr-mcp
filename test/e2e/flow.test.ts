// End to end on a real local stack: two routstr-core nodes, one nutshell mint with fake
// Lightning, a fake AI. Run with KIT_CORE_DIR=<routstr-core checkout with .venv> npm run test:e2e
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { sats } from "../../src/format.js";
import { startCore, startMint, startMintProxy, startUpstream, type Service, type Upstream } from "./stack.js";

const coreDir = process.env.KIT_CORE_DIR;
const skip = coreDir ? false : "set KIT_CORE_DIR to a routstr-core checkout with its .venv";
const run = fs.mkdtempSync(path.join(os.tmpdir(), "routstr-mcp-e2e-"));
const SECRET = /sk-[A-Za-z0-9]|lnbc|lntb|lnbcrt|cashu[AB]/;

let upstream: Upstream;
let mint: Service;
let mintProxy: Awaited<ReturnType<typeof startMintProxy>>;
let nodeA: Service;
let nodeB: Service;
let client: Client;
let wallet: typeof import("../../src/wallet.js");

/** Calls a tool the way an agent does and checks no secret is in what the agent sees. */
async function tool(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const text = result.content.map((c) => c.text).join("\n");
  assert.doesNotMatch(text, SECRET, `${name} showed a secret to the agent`);
  return { text, isError: !!result.isError };
}

const satsOn = async (node: string) => (await wallet.balanceOf(wallet.keyFor(node)!)).sats!;

before(async () => {
  if (skip) return;
  upstream = await startUpstream();
  mint = await startMint(path.join(run, "mint"));
  mintProxy = await startMintProxy(mint.url);
  [nodeA, nodeB] = await Promise.all([
    startCore(coreDir!, path.join(run, "node-a"), mintProxy.url, upstream.url),
    startCore(coreDir!, path.join(run, "node-b"), mint.url, upstream.url),
  ]);
  process.env.ROUTSTR_MCP_HOME = path.join(run, "home");
  process.env.ROUTSTR_NODES = `${nodeA!.url},${nodeB!.url}`;
  wallet = await import("../../src/wallet.js");
  const { createServer } = await import("../../src/server.js");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "e2e", version: "0" });
  await Promise.all([createServer().connect(serverSide), client.connect(clientSide)]);
});

after(async () => {
  if (skip) return;
  await client?.close();
  await Promise.all([nodeA?.stop(), nodeB?.stop(), mint?.stop()]);
  await upstream?.close();
  await mintProxy?.close();
});

test("an empty wallet tells the agent how the user adds sats", { skip }, async () => {
  const { text } = await tool("balance");
  assert.match(text, /empty/);
  assert.match(text, /npx routstr-mcp fund/);
  const asked = await tool("ask", { model: "e2e-cheap", prompt: "hi" });
  assert.equal(asked.isError, true);
  assert.match(asked.text, /no sats/);
});

test("paying an invoice opens a key, and a second payment tops the same key up", { skip }, async () => {
  const first = await wallet.createInvoice(nodeA.url, 500);
  assert.equal(wallet.readWallet().pending.length, 1, "the invoice is saved before it can be paid");
  assert.equal(await wallet.settleInvoice(first), "paid");
  assert.equal(await satsOn(nodeA.url), 500);

  const second = await wallet.createInvoice(nodeA.url, 300);
  assert.ok(second.key, "a node that already has a key gets a top-up");
  // not settled here: the next look at the wallet picks it up, as after a stopped fund command
  const { text } = await tool("balance");
  assert.match(text, /800 sats on 1 node/);
  assert.equal(wallet.readWallet().keys.length, 1);
  assert.equal(wallet.readWallet().pending.length, 0);
});

test("an invoice paid after core calls it expired still lands in the wallet", { skip }, async () => {
  mintProxy.hidePayments(true);
  const late = await wallet.createInvoice(nodeA.url, 100);
  // core marks invoices expired by the clock after an hour, but credits a late payment for a day more
  execFileSync("python3", ["-I", "-c", "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute('UPDATE lightning_invoices SET expires_at=? WHERE id=?',(int(sys.argv[2]),sys.argv[3]));c.commit()",
    path.join(run, "node-a", "core.db"), String(Math.floor(Date.now() / 1000) - 5), late.invoiceId]);
  assert.equal(await wallet.settleInvoice(late), "expired");
  assert.equal(wallet.readWallet().pending.length, 1, "kept, because a payment can still land");
  mintProxy.hidePayments(false);
  assert.match((await tool("balance")).text, /900 sats on 1 node/);
  assert.equal(wallet.readWallet().pending.length, 0);
});

test("find_models lists both models with prices and marks the funded ones", { skip }, async () => {
  const { text } = await tool("find_models", { query: "e2e" });
  assert.match(text, /2 models match "e2e" on 2 nodes/);
  assert.match(text, /e2e-cheap · 2 nodes .* funded/);
  assert.ok(text.indexOf("e2e-cheap") < text.indexOf("e2e-smart"), "cheapest first");
});

test("ask answers, bills exactly what the node charged, and shows it", { skip }, async () => {
  const before = await satsOn(nodeA.url);
  const { text, isError } = await tool("ask", { model: "e2e-smart", prompt: "what is a sat?" });
  assert.equal(isError, false);
  assert.match(text, /^Echo: what is a sat\?/);
  const cost = Number(text.match(/· ([\d.,]+) sats ·/)![1]!.replace(/,/g, ""));
  assert.ok(cost > 0);
  const after = await satsOn(nodeA.url);
  assert.ok(Math.abs(before - after - cost) < 0.01, `balance fell by ${before - after}, footer said ${cost}`);
  assert.ok(text.includes(`${sats(after)} sats left there`), text);
});

test("max_sats caps the answer length the node reserves for", { skip }, async () => {
  await tool("ask", { model: "e2e-smart", prompt: "short one", max_sats: 6 });
  const sent = upstream.seen.at(-1)!;
  const models = (await (await fetch(`${nodeA.url}/v1/models`)).json()) as { data: { id: string; sats_pricing: { prompt: number; completion: number; request: number } }[] };
  const rates = models.data.find((m) => m.id === "e2e-smart")!.sats_pricing;
  const promptTokens = Math.ceil("short one".length / 2) + 8;
  assert.equal(sent.max_tokens, Math.floor((6 - rates.request - promptTokens * rates.prompt) / rates.completion));

  const tooLow = await tool("ask", { model: "e2e-smart", prompt: "x".repeat(3000), max_sats: 2 });
  assert.equal(tooLow.isError, true);
  assert.match(tooLow.text, /too little/);
});

test("an unknown model points the agent to find_models", { skip }, async () => {
  const { text, isError } = await tool("ask", { model: "no-such-model", prompt: "hi" });
  assert.equal(isError, true);
  assert.match(text, /find_models/);
});

test("council asks several models at once and totals the cost", { skip }, async () => {
  const { text } = await tool("council", { models: ["e2e-smart", "e2e-cheap"], prompt: "pick a number" });
  assert.match(text, /## e2e-smart\nEcho: pick a number/);
  assert.match(text, /## e2e-cheap\nEcho: pick a number/);
  assert.match(text, /Total: [\d.]+ sats/);
});

test("when a node is down, ask moves to the next node that has sats", { skip }, async () => {
  const invoice = await wallet.createInvoice(nodeB.url, 200);
  assert.equal(await wallet.settleInvoice(invoice), "paid");
  await nodeA.stop();
  const { text, isError } = await tool("ask", { model: "e2e-cheap", prompt: "still there?" });
  assert.equal(isError, false, text);
  assert.match(text, new RegExp(`on ${new URL(nodeB.url).host}`));
});

test("refund returns the whole balance as a Cashu token and forgets the key", { skip }, async () => {
  const key = wallet.keyFor(nodeB.url)!;
  const left = await satsOn(nodeB.url);
  const refund = await wallet.refundKey(key);
  assert.equal(refund.error, undefined);
  assert.match(refund.token!, /^cashu[AB]/);
  assert.equal(refund.sats, Math.floor(left));
  assert.equal(wallet.keyFor(nodeB.url), undefined);
  const saved = fs.readdirSync(wallet.refundFile());
  assert.equal(saved.length, 1);
  // asking again after a crash gives the same token back
  const again = await wallet.refundKey(key);
  assert.equal(again.token, refund.token);
});

const cliPath = new URL("../../src/index.js", import.meta.url).pathname;

/** Runs the CLI as a user would, against the same wallet. */
async function cli(args: string[], input?: string) {
  const child = promisify(execFile)(process.execPath, [cliPath, ...args], { env: process.env, timeout: 60_000 });
  if (input !== undefined) {
    child.child.stdin!.end(input);
  }
  return (await child).stdout;
}

test("the CLI funds with a QR invoice, shows the balance and refunds", { skip }, async () => {
  const funded = await cli(["fund", "150", "--node", nodeB.url]);
  assert.match(funded, /Pay 150 sats to open a key on/);
  assert.match(funded, /lnbc/);
  assert.match(funded, /Paid\. You have 150 sats on/);
  // node A was stopped by an earlier test, so its key shows as unreachable next to node B's
  const b = new URL(nodeB.url).host;
  assert.match(await cli(["balance"]), new RegExp(`- ${b}: 150 sats\n`));
  assert.match(await cli(["refund", "--node", nodeB.url]), /150 sats as a Cashu token/);
  assert.doesNotMatch(await cli(["balance"]), new RegExp(b));
});

test("the CLI imports a key made elsewhere, read from stdin", { skip }, async () => {
  const made = (await (await fetch(`${nodeB.url}/lightning/invoice`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amount_sats: 40, purpose: "create" }),
  })).json()) as { invoice_id: string };
  const status = (await (await fetch(`${nodeB.url}/lightning/invoice/${made.invoice_id}/status`)).json()) as { api_key: string };
  assert.match(await cli(["import", "--node", nodeB.url], `${status.api_key}\n`), /Added\. 40 sats on/);
  // 40 sats is less than the default cap reserves, so the answer is fitted to what is left
  const { text, isError } = await tool("ask", { model: "e2e-smart", prompt: "small balance" });
  assert.equal(isError, false, text);
  assert.ok(upstream.seen.at(-1)!.max_tokens! < 2048);
  await assert.rejects(cli(["import", "--node", nodeB.url], "sk-unknown\n"), /did not accept the key/);
});

test("the wallet file is private to the user", { skip }, async () => {
  const mode = fs.statSync(path.join(run, "home", "wallet.json")).mode & 0o777;
  assert.equal(mode, 0o600);
});
