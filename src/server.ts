import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ask, council, quote } from "./calls.js";
import { config } from "./config.js";
import { host, perMillion, sats, tokens, version } from "./format.js";
import { Market, searchModels, unitCost } from "./market.js";
import { reasoningEffortSchema, receiptSchema, type CostReceipt } from "./receipt.js";
import { balances, readWallet } from "./wallet.js";

const FUND_HINT =
  "To add sats, the user runs `npx routstr-mcp fund <sats>` in a terminal and pays the Lightning invoice it shows. " +
  "`npx routstr-mcp refund` takes unspent sats back.";

const INSTRUCTIONS = `routstr-mcp lets you call AI models sold on Routstr, an open market of nodes paid in bitcoin, as tools.
Use it for a second opinion from a different model, to compare several models with council, or to hand a simple sub-task to a cheaper model.
Paid calls draw from the user's prepaid Routstr balance and return cost receipts. Use quote to estimate a specific prompt before spending.
Use find_models when you are unsure of a model id. Never ask the user for API keys, Cashu tokens or invoices. ${FUND_HINT}`;

/** The agent never sees a wallet secret, even when a node echoes one back in an answer or an error. */
function redactor(): (value: string) => string {
  let secrets: string[];
  try {
    const wallet = readWallet();
    secrets = [...wallet.keys.map((k) => k.key), ...wallet.pending.flatMap((p) => [p.bolt11, p.key ?? ""])];
  } catch {
    return (value) => value;
  }
  const needles = secrets
    .filter((secret): secret is string => typeof secret === "string")
    .flatMap((secret) => [secret, secret.replace(/^sk-/, "")])
    .filter((secret) => secret.length >= 16);
  return (value) => needles.reduce((out, secret) => out.split(secret).join("[secret removed]"), value);
}

function text(value: string, isError = false, data?: Record<string, unknown>) {
  const redact = redactor();
  return {
    content: [{ type: "text" as const, text: redact(value) }],
    isError,
    structuredContent: data === undefined ? undefined : JSON.parse(
      JSON.stringify(data, (_key, entry) => typeof entry === "string" ? redact(entry) : entry)
    ) as Record<string, unknown>,
  };
}

function footer(receipt: CostReceipt): string {
  const cost = receipt.costSats === undefined ? "cost unavailable"
    : `${sats(receipt.costSats)} sats${receipt.costSource === "estimate" ? " (estimated)" : ""}`;
  return `${receipt.model} on ${host(receipt.node)} · ${cost}` +
    (receipt.balanceSats !== undefined ? ` · ${sats(receipt.balanceSats)} sats left there` : "") +
    (receipt.overTarget ? `\nThe node charged more than the ${sats(receipt.targetSats)} sat target.` : "") +
    (receipt.finishReason === "length" ? "\nThe model hit its output token limit." : "");
}

const nodePin = z.string().trim().min(1).optional().describe("Pin a listed Routstr node by its base URL, as returned by quote.");
const reasoningEffort = reasoningEffortSchema.optional().describe("Request a reasoning effort. The serving route determines support and behavior.");

const maxSats = z
  .number()
  .positive()
  .max(config.maxSatsPerCall)
  .optional()
  .describe(`Estimated spend target in sats (default ${config.defaultSatsPerCall}, at most ${config.maxSatsPerCall}). The node settles the final charge.`);

const askInput = {
  model: z.string().min(1).describe("Model id, e.g. from find_models"),
  prompt: z.string().min(1).describe("The full question, with all context the model needs"),
  system: z.string().optional().describe("Optional system prompt"),
  max_sats: maxSats,
  node: nodePin,
  reasoning_effort: reasoningEffort,
};

const quoteSchema = receiptSchema.pick({
  model: true,
  node: true,
  targetSats: true,
  estimatedInputTokens: true,
  maxOutputTokens: true,
  estimatedMaxSats: true,
  requestedReasoningEffort: true,
}).extend({
  estimatedMaxSats: z.number().optional(),
  minimumSats: z.number(),
  inputSatsPerToken: z.number(),
  outputSatsPerToken: z.number(),
  hasWalletKey: z.boolean(),
  fitsTarget: z.boolean(),
});

export function createServer(market = new Market()): McpServer {
  const server = new McpServer({ name: "routstr", version }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "quote",
    {
      title: "Estimate the cost of a Routstr call",
      description: "Estimate the initial request for this prompt using advertised model prices. No inference is sent.",
      inputSchema: askInput,
      outputSchema: { quote: quoteSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ model, prompt, system, max_sats, node, reasoning_effort }) => {
      try {
        const q = await quote(market, {
          model, prompt, system, node, reasoningEffort: reasoning_effort, maxSats: max_sats ?? config.defaultSatsPerCall,
        });
        const cost = q.estimatedMaxSats === undefined
          ? `Target too low for the minimum output. Estimated minimum: ${sats(q.minimumSats)} sats.`
          : `Estimated at up to ${sats(q.estimatedMaxSats)} sats for ${q.estimatedInputTokens.toLocaleString("en-US")} input tokens and up to ${q.maxOutputTokens.toLocaleString("en-US")} output tokens.`;
        return text(
          `${q.model} on ${q.node}\n${cost}\n` +
          (q.hasWalletKey ? "Wallet key available. " : "No wallet key on this node. ") +
          "Catalog estimate only. The node settles the final charge.",
          false,
          { quote: q }
        );
      } catch (e) {
        return text((e as Error).message, true);
      }
    }
  );

  server.registerTool(
    "ask",
    {
      title: "Ask a Routstr model",
      description:
        "Ask any model sold on Routstr and get its answer, paid in sats from the user's prepaid balance. " +
        "Returns a cost receipt with the node's charge when available.",
      inputSchema: askInput,
      outputSchema: { receipt: receiptSchema },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ model, prompt, system, max_sats, node, reasoning_effort }) => {
      try {
        const { text: answer, receipt } = await ask(market, {
          model, prompt, system, node, reasoningEffort: reasoning_effort, maxSats: max_sats ?? config.defaultSatsPerCall,
        });
        return text(`${answer || "(the model returned no text)"}\n\n— ${footer(receipt)}`, false, { receipt });
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
        node: nodePin,
        reasoning_effort: reasoningEffort,
      },
      outputSchema: {
        seats: z.array(z.union([
          z.object({ model: z.string(), receipt: receiptSchema }),
          z.object({ model: z.string(), error: z.string() }),
        ])),
        totalCostSats: z.number().optional(),
        allChargesReported: z.boolean(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ models, prompt, system, max_sats_each, node, reasoning_effort }) => {
      const seats = await council(market, models, {
        prompt,
        system,
        node,
        reasoningEffort: reasoning_effort,
        maxSats: max_sats_each ?? config.defaultSatsPerCall,
      });
      const receipts = seats.flatMap((seat) => "answer" in seat ? [seat.answer.receipt] : []);
      const costs = receipts.flatMap((receipt) => receipt.costSats === undefined ? [] : [receipt.costSats]);
      const totalCostSats = costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : undefined;
      const allChargesReported = receipts.length === seats.length && receipts.every((r) => r.overTarget !== undefined);
      const body = seats
        .map((s) =>
          "answer" in s
            ? `## ${s.model}\n${s.answer.text || "(no text)"}\n\n— ${footer(s.answer.receipt)}`
            : `## ${s.model}\nFailed: ${s.error}`
        )
        .join("\n\n");
      const total = totalCostSats === undefined ? "unavailable" : `${sats(totalCostSats)} sats`;
      return text(`${body}\n\nTotal: ${total}${allChargesReported ? "" : " (partial or estimated)"}`, receipts.length === 0, {
        seats: seats.map((seat) => "answer" in seat ? { model: seat.model, receipt: seat.answer.receipt } : seat),
        totalCostSats,
        allChargesReported,
      });
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
        const rows = searchModels(offers, query);
        const shown = rows.slice(0, limit ?? 20).map((m) => {
          // the price ask would pay: the cheapest node with sats on it, else the cheapest node
          const paid = m.offers.filter((o) => funded.has(o.node)).sort((a, b) => unitCost(a) - unitCost(b))[0];
          const at = paid ?? m.cheapest;
          return (
            `${m.id} · ${m.nodes} node${m.nodes > 1 ? "s" : ""} · ${tokens(m.context)} context · ` +
            `${perMillion(at.promptRate)} / ${perMillion(at.completionRate)} · ` +
            `typical ${sats(unitCost(at))} sats${paid ? ` · funded${at !== m.cheapest && unitCost(m.cheapest) < unitCost(at) ? ` (cheapest elsewhere: typical ${sats(unitCost(m.cheapest))})` : ""}` : ""}`
          );
        });
        const head =
          `${rows.length} model${rows.length === 1 ? "" : "s"}${query ? ` match "${query}"` : ""} on ${reached.length} node${reached.length === 1 ? "" : "s"}` +
          `${missed.length ? ` (${missed.length} did not answer)` : ""}. ` +
          "Prices are sats per 1M tokens in / out where ask would pay: the cheapest node you have sats on, else the cheapest node. typical = 2k tokens in, 1k out; funded = you have sats where it is sold.";
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
