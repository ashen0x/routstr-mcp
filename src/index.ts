#!/usr/bin/env node
import readline from "node:readline";
import { parseArgs } from "node:util";
import qrcode from "qrcode-terminal";
import { host, sats, version } from "./format.js";
import { Market, normalizeNode, offersFor, unitCost } from "./market.js";
import { config } from "./config.js";
import { balanceReport, serve } from "./server.js";
import { readSpend, startOfToday } from "./spend.js";
import { balanceOf, createInvoice, importKey, keyFor, readWallet, refundFile, refundKey, settleInvoice } from "./wallet.js";

const USAGE = `routstr-mcp ${version}: Routstr models as tools for your agent, paid in sats.

  routstr-mcp                         start the MCP server (what your MCP app runs)
  routstr-mcp fund <sats>             pay a Lightning invoice to add sats
      --model <id>                    on the cheapest node that sells this model
      --node <url>                    on this node
  routstr-mcp balance                 sats left, per node
  routstr-mcp refund                  take all unspent sats back as a Cashu token
      --to <lightning address>        or send them to a Lightning address
      --node <url>                    only from this node
  routstr-mcp spend                   what calls cost: today, per day and per model
      --days <n>                      look back this many days (default 7)
  routstr-mcp nodes                   approved nodes and how many models each sells
  routstr-mcp import --node <url>     add a Routstr key you already have (read from stdin)

Add it to Claude Code:  claude mcp add routstr -- npx -y routstr-mcp`;

const EXPIRED = "The invoice expired unpaid. If it gets paid anyway, the sats are picked up the next time the wallet is used.";

/** Node text goes to the terminal without control characters, so a node cannot send escape sequences. */
const clean = (value: string) => value.replace(/[\p{Cc}]/gu, "");

/** The amount a bolt11 invoice asks for, in sats, from its human-readable part. */
function invoiceSats(bolt11: string): number | undefined {
  const m = bolt11.toLowerCase().match(/^ln(?:bcrt|bc|tbs|tb|sb)(\d+)([munp]?)1/);
  if (!m) return undefined;
  const scale = { "": 1e8, m: 1e5, u: 1e2, n: 1e-1, p: 1e-4 }[m[2] as "" | "m" | "u" | "n" | "p"];
  return Math.round(Number(m[1]) * scale * 1000) / 1000;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function pickNode(market: Market, node?: string, model?: string): Promise<string> {
  if (node) return normalizeNode(node);
  const { offers } = await market.load();
  if (model) {
    const cheapest = offersFor(offers, model).sort((a, b) => unitCost(a) - unitCost(b))[0];
    if (!cheapest) throw new Error(`No approved node sells "${model}".`);
    console.log(`${host(cheapest.node)} sells ${cheapest.id} cheapest.`);
    return cheapest.node;
  }
  const funded = readWallet().keys.find((k) => offers.some((o) => o.node === k.node));
  if (funded) return funded.node;
  const counts = new Map<string, number>();
  for (const o of offers) counts.set(o.node, (counts.get(o.node) ?? 0) + 1);
  const [best] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!best) throw new Error("No approved node answered. Try again, or pass --node <url>.");
  console.log(`${host(best[0])} sells the most models (${best[1]}).`);
  return best[0];
}

async function fund(amountArg: string | undefined, node?: string, model?: string) {
  const amount = Number(amountArg);
  if (!Number.isInteger(amount) || amount < 1 || amount > 1_000_000)
    throw new Error("Say how many sats to add, a whole number from 1 to 1,000,000. Example: routstr-mcp fund 2000");
  const target = await pickNode(new Market(), node, model);
  const invoice = await createInvoice(target, amount);
  const asked = invoiceSats(invoice.bolt11);
  if (asked !== amount)
    throw new Error(`${host(target)} sent an invoice for ${asked === undefined ? "an unreadable amount" : `${sats(asked)} sats`} instead of ${sats(amount)}. Do not pay it.`);
  console.log(`\nPay ${sats(amount)} sats to ${invoice.key ? "top up your key on" : "open a key on"} ${host(target)}:\n`);
  qrcode.generate(invoice.bolt11, { small: true });
  console.log(`\n${invoice.bolt11}\n\nWaiting for the payment. Ctrl-C is safe: a payment made later is picked up the next time the wallet is used.`);
  while (Date.now() / 1000 < invoice.expiresAt + 60) {
    await sleep(2000);
    let state;
    try {
      state = await settleInvoice(invoice);
    } catch {
      continue;
    }
    if (state === "expired") throw new Error(EXPIRED);
    if (state === "paid") {
      const key = keyFor(target);
      const balance = key ? await balanceOf(key) : undefined;
      console.log(`\nPaid. ${balance?.sats !== undefined ? `You have ${sats(balance.sats)} sats on ${host(target)}.` : ""}`);
      return;
    }
  }
  throw new Error(EXPIRED);
}

async function refund(to?: string, node?: string) {
  const keys = readWallet().keys.filter((k) => !node || k.node === normalizeNode(node));
  if (!keys.length) return console.log("There is nothing to refund.");
  for (const key of keys) {
    const r = await refundKey(key, to);
    if (r.error) console.log(`${host(r.node)}: could not refund: ${clean(r.error)}`);
    else if (r.token)
      console.log(`${host(r.node)}: ${sats(r.sats ?? 0)} sats as a Cashu token (also saved in ${refundFile()}):\n${clean(r.token)}\n`);
    else console.log(`${host(r.node)}: sent ${sats(r.sats ?? 0)} sats to ${clean(r.sentTo ?? to ?? "")}.`);
  }
}

function spend(daysArg?: string) {
  const days = Math.min(Math.max(Math.floor(Number(daysArg ?? 7)) || 7, 1), 365);
  const since = startOfToday() - (days - 1) * 86_400_000;
  const entries = readSpend(since);
  const today = entries.filter((e) => Date.parse(e.at) >= startOfToday());
  const sum = (list: typeof entries) => list.reduce((total, e) => total + e.sats, 0);
  const limit = config.dailySats ? ` of a ${sats(config.dailySats)} sat daily limit` : "";
  console.log(`Today: ${sats(sum(today))} sats in ${today.length} call${today.length === 1 ? "" : "s"}${limit}.`);
  if (!entries.length) return;
  const byDay = new Map<string, typeof entries>();
  const byModel = new Map<string, typeof entries>();
  for (const e of entries) {
    const day = new Date(e.at).toLocaleDateString("en-CA");
    byDay.set(day, [...(byDay.get(day) ?? []), e]);
    byModel.set(e.model, [...(byModel.get(e.model) ?? []), e]);
  }
  console.log(`\nLast ${days} day${days === 1 ? "" : "s"}: ${sats(sum(entries))} sats`);
  for (const [day, list] of [...byDay].sort()) console.log(`  ${day}  ${sats(sum(list)).padStart(9)} sats  ${list.length} calls`);
  console.log("\nBy model:");
  for (const [model, list] of [...byModel].sort((a, b) => sum(b[1]) - sum(a[1]))) console.log(`  ${sats(sum(list)).padStart(9)} sats  ${model} (${list.length})`);
  console.log("\nLatest:");
  for (const e of entries.slice(-10))
    console.log(`  ${e.at.slice(0, 16).replace("T", " ")}  ${clean(e.model)} on ${host(e.node)}  ${e.unsure ? "up to " : ""}${sats(e.sats)} sats  (${e.purpose})`);
  if (entries.some((e) => e.unsure)) console.log("\n\"up to\" marks a call that was lost after the node got it, counted at its cap.");
}

async function nodes() {
  const { offers, reached, missed } = await new Market().load(true);
  for (const node of reached)
    console.log(`${host(node)}  ${offers.filter((o) => o.node === node).length} models`);
  for (const node of missed) console.log(`${host(node)}  did not answer`);
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    return data.trim();
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  process.stdout.write(prompt);
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
  const answer = await new Promise<string>((resolve) => rl.question("", resolve));
  rl.close();
  process.stdout.write("\n");
  return answer.trim();
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      node: { type: "string" },
      model: { type: "string" },
      to: { type: "string" },
      days: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [command, arg] = positionals;
  if (values.help || command === "help") return console.log(USAGE);
  if (values.version) return console.log(version);
  switch (command) {
    case undefined:
    case "serve":
      return serve();
    case "fund":
      return fund(arg, values.node, values.model);
    case "balance":
      return console.log(await balanceReport());
    case "refund":
      return refund(values.to, values.node);
    case "nodes":
      return nodes();
    case "spend":
      return spend(values.days);
    case "import": {
      if (!values.node) throw new Error("Say which node the key belongs to: routstr-mcp import --node <url>");
      const balance = await importKey(values.node, await readSecret("Paste the sk- key (hidden): "));
      return console.log(`Added. ${sats(balance.sats ?? 0)} sats on ${host(balance.node)}.`);
    }
    default:
      throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
