import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ask, council, type Answer } from "./calls.js";
import { config } from "./config.js";
import { host, perMillion, sats, tokens, version } from "./format.js";
import { Market, searchModels, unitCost } from "./market.js";
import { balances, readWallet } from "./wallet.js";

const FUND_HINT =
  "To add sats, the user runs `npx routstr-mcp fund <sats>` in a terminal and pays the Lightning invoice it shows. " +
  "`npx routstr-mcp refund` takes unspent sats back.";

const INSTRUCTIONS = `routstr-mcp lets you call AI models sold on Routstr, an open market of nodes paid in bitcoin, as tools.
Use it for a second opinion from a different model, to compare several models with council, or to hand a simple sub-task to a cheaper model.
Each call costs a few sats from the user's prepaid Routstr balance and shows the cost. The prepaid balance is a hard limit.
Use find_models when you are unsure of a model id. Never ask the user for API keys, Cashu tokens or invoices. ${FUND_HINT}`;

/** The agent never sees a wallet secret, even when a node echoes one back in an answer or an error. */
function redact(value: string): string {
  let secrets: string[];
  try {
    const wallet = readWallet();
    secrets = [...wallet.keys.map((k) => k.key), ...wallet.pending.flatMap((p) => [p.bolt11, p.key ?? ""])];
  } catch {
    return value;
  }
  return secrets
    .flatMap((secret) => [secret, secret.replace(/^sk-/, "")])
    .filter((secret) => secret.length >= 16)
    .reduce((out, secret) => out.split(secret).join("[secret removed]"), value);
}

const text = (value: string, isError = false) => ({ content: [{ type: "text" as const, text: redact(value) }], isError });

const footer = (a: Answer) =>
  `${a.model} on ${host(a.node)} · ${sats(a.costSats)} sats` +
  (a.leftSats !== undefined ? ` · ${sats(a.leftSats)} sats left there` : "");

const cutNote = "The answer reached its sats cap and was cut; ask again with a higher max_sats for a longer one.";

const maxSats = z
  .number()
  .positive()
  .max(config.maxSatsPerCall)
  .optional()
  .describe(`Most this call may cost, in sats (default ${config.defaultSatsPerCall}, at most ${config.maxSatsPerCall}).`);

export function createServer(market = new Market()): McpServer {
  const server = new McpServer({ name: "routstr", version }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "ask",
    {
      title: "Ask a Routstr model",
      description:
        "Ask any model sold on Routstr and get its answer, paid in sats from the user's prepaid balance. " +
        "Good for a second opinion, a model with different strengths, or a cheap model for a simple job. The cost is shown.",
      inputSchema: {
        model: z.string().min(1).describe("Model id, e.g. from find_models"),
        prompt: z.string().min(1).describe("The full question, with all context the model needs: it sees nothing else"),
        system: z.string().optional().describe("Optional system prompt"),
        max_sats: maxSats,
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ model, prompt, system, max_sats }) => {
      try {
        const answer = await ask(market, { model, prompt, system, maxSats: max_sats ?? config.defaultSatsPerCall });
        return text(`${answer.text || "(the model returned no text)"}\n\n— ${footer(answer)}${answer.cut ? `\n${cutNote}` : ""}`);
      } catch (e) {
        return text((e as Error).message, true);
      }
    }
  );

  server.registerTool(
    "council",
    {
      title: "Ask several Routstr models",
      description:
        "Ask 2 to 5 models the same question at once and get every answer with its cost, to compare them. " +
        "You weigh the answers yourself.",
      inputSchema: {
        models: z.array(z.string().min(1)).min(2).max(5).describe("Model ids"),
        prompt: z.string().min(1).describe("The full question, with all context the models need"),
        system: z.string().optional().describe("Optional system prompt"),
        max_sats_each: maxSats,
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ models, prompt, system, max_sats_each }) => {
      const seats = await council(market, models, {
        prompt,
        system,
        maxSats: max_sats_each ?? config.defaultSatsPerCall,
      });
      const total = seats.reduce((sum, s) => sum + ("answer" in s ? s.answer.costSats : 0), 0);
      const body = seats
        .map((s) =>
          "answer" in s
            ? `## ${s.model}\n${s.answer.text || "(no text)"}\n\n— ${footer(s.answer)}${s.answer.cut ? `\n${cutNote}` : ""}`
            : `## ${s.model}\nFailed: ${s.error}`
        )
        .join("\n\n");
      return text(`${body}\n\nTotal: ${sats(total)} sats`, seats.every((s) => "error" in s));
    }
  );

  server.registerTool(
    "find_models",
    {
      title: "Find Routstr models",
      description:
        "Search the models sold by approved Routstr nodes, cheapest first, with prices in sats. " +
        "Every word of the query must match, e.g. \"claude\", \"gpt 5\", \"qwen coder\". Empty lists the cheapest.",
      inputSchema: {
        query: z.string().optional().describe("Words to match in the model id or name"),
        limit: z.number().int().positive().max(100).optional().describe("Rows to return (default 20)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, limit }) => {
      try {
        const { offers, reached, missed } = await market.load();
        const funded = new Set(readWallet().keys.map((k) => k.node));
        const fundedIds = new Set(offers.filter((o) => funded.has(o.node)).map((o) => o.id.toLowerCase()));
        const rows = searchModels(offers, query);
        const shown = rows.slice(0, limit ?? 20).map(
          (m) =>
            `${m.id} · ${m.nodes} node${m.nodes > 1 ? "s" : ""} · ${tokens(m.context)} context · ` +
            `${perMillion(m.cheapest.promptRate)} / ${perMillion(m.cheapest.completionRate)} · ` +
            `typical ${sats(unitCost(m.cheapest))} sats${fundedIds.has(m.id.toLowerCase()) ? " · funded" : ""}`
        );
        const head =
          `${rows.length} model${rows.length === 1 ? "" : "s"}${query ? ` match "${query}"` : ""} on ${reached.length} node${reached.length === 1 ? "" : "s"}` +
          `${missed.length ? ` (${missed.length} did not answer)` : ""}. ` +
          "Prices are sats per 1M tokens in / out at the cheapest node; typical = 2k tokens in, 1k out; funded = you have sats where it is sold.";
        return text([head, ...shown, rows.length > shown.length ? `…and ${rows.length - shown.length} more.` : ""].filter(Boolean).join("\n"));
      } catch (e) {
        return text((e as Error).message, true);
      }
    }
  );

  server.registerTool(
    "balance",
    {
      title: "Routstr balance",
      description: "Show the sats left in the user's Routstr wallet, per node, and how to add more.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return text(await balanceReport());
      } catch (e) {
        return text((e as Error).message, true);
      }
    }
  );

  return server;
}

export async function balanceReport(): Promise<string> {
  const list = await balances();
  const pending = readWallet().pending;
  if (!list.length && !pending.length) return `The Routstr wallet is empty. ${FUND_HINT}`;
  const total = list.reduce((sum, b) => sum + (b.sats ?? 0), 0);
  const lines = [`Routstr wallet: ${sats(total)} sats on ${list.length} node${list.length === 1 ? "" : "s"}`];
  for (const b of list)
    lines.push(
      b.error
        ? `- ${host(b.node)}: could not check (${b.error})`
        : `- ${host(b.node)}: ${sats(b.sats!)} sats${b.reservedSats ? ` (${sats(b.reservedSats)} held for calls in flight)` : ""}`
    );
  for (const p of pending)
    lines.push(`- ${Date.now() / 1000 > p.expiresAt ? "expired invoice, still counted if paid late" : "waiting for payment"}: ${sats(p.sats)} sats on ${host(p.node)}`);
  lines.push(FUND_HINT);
  return lines.join("\n");
}

export async function serve(): Promise<void> {
  // stdout carries the MCP messages; anything a library logs there (nostr-tools prints relay notices) could pose as one
  console.log = console.info = console.debug = console.error;
  await createServer().connect(new StdioServerTransport());
}
