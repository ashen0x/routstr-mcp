import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { continueAgent, findSession, report, startAgent, type AgentResult } from "./agent.js";
import { ask, AskError, council, quote, type ContentPart } from "./calls.js";
import { config } from "./config.js";
import { host, perMillion, sats, tokens, version } from "./format.js";
import { Market, searchModels, unitCost } from "./market.js";
import { reasoningEffortSchema, receiptSchema, type CostReceipt } from "./receipt.js";
import { closeSandbox, sandboxProblem } from "./sandbox.js";
import { spentToday } from "./spend.js";
import { balances, readWallet } from "./wallet.js";
import { usableRoot, Workspace, WorkspaceError, type Access } from "./workspace.js";

/** Where the MCP app started this server: the project folder for most apps. */
const STARTED_IN = process.cwd();

const FUND_HINT =
  "To add sats, the user runs `npx routstr-mcp fund <sats>` in a terminal and pays the Lightning invoice it shows. " +
  "`npx routstr-mcp refund` takes unspent sats back.";

const INSTRUCTIONS = `routstr-mcp lets you call AI models sold on Routstr, an open market of nodes paid in bitcoin, as tools.
Use ask for a second opinion from a different model, council to compare several models, and delegate to hand a whole task to another model that works in the project on its own (reading, searching, and with the user's say-so editing files or running commands in a sandbox).
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

const filesInput = z.array(z.string().min(1)).max(20).optional().describe("Project files to send along, relative to the project root. Secret files (.env, keys) are refused.");
const imagesInput = z.array(z.string().min(1)).max(4).optional().describe("Images for a vision model: project file paths (PNG, JPEG, GIF, WebP up to 1 MB) or https URLs.");

interface Extra {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification: (n: { method: "notifications/progress"; params: { progressToken: string | number; progress: number; total?: number; message?: string } }) => Promise<void>;
}

/** Progress notes for the MCP app; they also keep apps that reset their timeout on progress from giving up. */
function progress(extra: Extra) {
  const token = extra._meta?.progressToken;
  let count = 0;
  return (message: string) => {
    if (token === undefined) return;
    extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++count, message } }).catch(() => {});
  };
}

/** A note every 15 seconds while a single slow call runs. */
function heartbeat(extra: Extra, what: string): () => void {
  const note = progress(extra);
  const started = Date.now();
  const timer = setInterval(() => note(`waiting for ${what} · ${Math.round((Date.now() - started) / 1000)} s`), 15_000);
  return () => clearInterval(timer);
}

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
  files: filesInput,
  images: imagesInput,
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

  /** The project folders the MCP app has open, or ROUTSTR_WORKSPACE, or the folder the app started us in. */
  const projectRoots = async (): Promise<string[]> => {
    let dirs: string[] = [];
    if (server.server.getClientCapabilities()?.roots) {
      try {
        const { roots } = await server.server.listRoots(undefined, { timeout: 5000 });
        dirs = roots.filter((r) => r.uri.startsWith("file://")).map((r) => fileURLToPath(r.uri));
      } catch {
        /* the app said it has roots but did not answer */
      }
    }
    if (!dirs.length) dirs = config.workspace ?? [STARTED_IN];
    const usable = [...new Set(dirs.map(usableRoot).filter((d): d is string => !!d))];
    if (!usable.length)
      throw new WorkspaceError("No project folder is open (the app started this server in the home folder or at the disk root). Set ROUTSTR_WORKSPACE to the project folder.");
    return usable;
  };

  const attachments = async (files?: string[], images?: string[]): Promise<ContentPart[] | undefined> => {
    if (!files?.length && !images?.length) return undefined;
    const local = (files?.length || images?.some((i) => !/^https:\/\//i.test(i))) ? new Workspace(await projectRoots()) : undefined;
    const parts: ContentPart[] = [];
    for (const file of files ?? []) {
      const { name, text } = local!.attach(file);
      parts.push({ type: "text", text: `<file path="${name}">\n${text}\n</file>` });
    }
    for (const image of images ?? [])
      parts.push({ type: "image_url", image_url: { url: /^https:\/\//i.test(image) ? image : local!.image(image) } });
    return parts;
  };

  server.registerTool(
    "quote",
    {
      title: "Estimate the cost of a Routstr call",
      description: "Estimate the initial request for this prompt using advertised model prices. No inference is sent.",
      inputSchema: askInput,
      outputSchema: { quote: quoteSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ model, prompt, system, files, images, max_sats, node, reasoning_effort }) => {
      try {
        const q = await quote(market, {
          model, prompt, system, node, reasoningEffort: reasoning_effort, maxSats: max_sats ?? config.defaultSatsPerCall,
          attachments: await attachments(files, images),
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
    async ({ model, prompt, system, files, images, max_sats, node, reasoning_effort }, extra) => {
      const stop = heartbeat(extra as Extra, model);
      try {
        const { text: answer, receipt } = await ask(market, {
          model, prompt, system, node, reasoningEffort: reasoning_effort, maxSats: max_sats ?? config.defaultSatsPerCall,
          attachments: await attachments(files, images), signal: extra.signal,
        });
        return text(`${answer || "(the model returned no text)"}\n\n— ${footer(receipt)}`, false, { receipt });
      } catch (e) {
        return text((e as Error).message, true);
      } finally {
        stop();
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
        files: filesInput,
        images: imagesInput,
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
    async ({ models, prompt, system, files, images, max_sats_each, node, reasoning_effort }, extra) => {
      let parts: ContentPart[] | undefined;
      try {
        parts = await attachments(files, images);
      } catch (e) {
        return text((e as Error).message, true);
      }
      const stop = heartbeat(extra as Extra, models.join(", "));
      const seats = await council(market, models, {
        prompt,
        system,
        node,
        attachments: parts,
        reasoningEffort: reasoning_effort,
        maxSats: max_sats_each ?? config.defaultSatsPerCall,
        signal: extra.signal,
      }).finally(stop);
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
    "delegate",
    {
      title: "Hand a task to another model",
      description:
        "Give a whole task to a model sold on Routstr (for example Kimi, GLM, DeepSeek or Qwen), which works on its own in the user's project with " +
        "tools to list, read, glob, grep and git (status, diff, log, show). With access \"edit\" it also edits and writes files; with \"shell\" it also runs " +
        "commands in a sandbox with no network. With the default \"read\" access its edits come back as a patch you can apply. " +
        "Good for a code or security review, exploring unfamiliar code, or a self-contained change done by a cheaper or different model. " +
        "It returns the model's report, changed files, commands run and the cost. max_sats bounds the whole run; each step is paid as it goes. " +
        "Pass the session id from a report to send a follow-up. Ask the user before using edit or shell access.",
      inputSchema: {
        task: z.string().min(1).describe("The whole job, written so it makes sense on its own: the subagent does not see this conversation"),
        model: z.string().min(1).optional().describe("Model id, e.g. from find_models"),
        models: z.array(z.string().min(1)).min(1).max(3).optional().describe("1 to 3 model ids that each do the same task at once (read access only), to compare their work"),
        access: z.enum(["read", "edit", "shell"]).optional().describe("read (default): look only, edits come back as a patch. edit: may change files. shell: may also run commands in a sandbox"),
        cwd: z.string().optional().describe("Folder inside the project to work in (default: the project root)"),
        files: filesInput,
        system: z.string().optional().describe("Extra instructions for the subagent"),
        max_sats: z.number().positive().max(config.maxSatsPerTask).optional().describe(`Budget for the whole run, per model (default ${config.defaultSatsPerTask}, at most ${config.maxSatsPerTask})`),
        max_steps: z.number().int().positive().max(100).optional().describe("Most model calls in the run (default 30)"),
        node: nodePin,
        reasoning_effort: reasoningEffort,
        session: z.string().optional().describe("Session id from an earlier report, to continue that run; task is then the follow-up message"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ task, model, models, access, cwd, files, system, max_sats, max_steps, node, reasoning_effort, session }, extra) => {
      const note = progress(extra as Extra);
      const budget = { maxSats: max_sats ?? config.defaultSatsPerTask, maxSteps: max_steps ?? 30, signal: extra.signal, onProgress: note };
      try {
        if (session) {
          const run = findSession(session);
          if (!run) return text(`There is no session ${session} (sessions last 30 minutes and end when the server restarts). Start a new run.`, true);
          const result = await continueAgent(market, run, { task, ...budget });
          return text(report(result), result.stopped === "error");
        }
        const chosen = models?.length ? models : model ? [model] : [];
        if (!chosen.length) return text("Say which model to use: model, or models for up to 3 at once. find_models lists them.", true);
        const level: Access = access ?? "read";
        if (chosen.length > 1 && level !== "read") return text("Several models at once only work with read access, so they cannot change the same files. Run one model for edit or shell.", true);
        if (level === "shell") {
          const problem = await sandboxProblem();
          if (problem) return text(`Shell access needs a sandbox, and ${problem}. Use edit access, or install what it names (Linux: bubblewrap, socat and ripgrep).`, true);
        }
        let roots = await projectRoots();
        if (cwd) roots = [new Workspace(roots).resolve(cwd)];
        const results: AgentResult[] = await Promise.all(
          chosen.map((m) =>
            startAgent(market, { ...budget, task, model: m, workspace: new Workspace(roots, level), system, node, reasoningEffort: reasoning_effort, files }).catch(
              (e: Error) => { throw e instanceof WorkspaceError || e instanceof AskError ? e : new Error(`${m}: ${e.message}`); }
            )
          )
        );
        const total = results.reduce((sum, r) => sum + r.costSats, 0);
        const body = results.map(report).join("\n\n");
        return text(results.length > 1 ? `${body}\n\nTotal: ${sats(total)} sats` : body, results.every((r) => r.stopped === "error"));
      } catch (e) {
        return text((e as Error).message, true);
      }
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
        vision: z.boolean().optional().describe("Only models that take images"),
        max_typical_sats: z.number().positive().optional().describe("Only models whose typical call (2k tokens in, 1k out) costs at most this"),
        min_context: z.number().int().positive().optional().describe("Only models with at least this many tokens of context"),
        funded: z.boolean().optional().describe("Only models on a node where the user has sats"),
        limit: z.number().int().positive().max(100).optional().describe("Rows to return (default 20)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, vision, max_typical_sats, min_context, funded: onlyFunded, limit }) => {
      try {
        const { offers, reached, missed } = await market.load();
        const funded = new Set(readWallet().keys.map((k) => k.node));
        // the price ask would pay: the cheapest node with sats on it, else the cheapest node
        const priced = searchModels(offers, query).map((m) => {
          const paid = m.offers.filter((o) => funded.has(o.node)).sort((a, b) => unitCost(a) - unitCost(b))[0];
          return { m, paid, at: paid ?? m.cheapest };
        });
        const rows = priced.filter(
          ({ m, paid, at }) =>
            (vision === undefined || m.offers.some((o) => !!o.vision) === vision) &&
            (max_typical_sats === undefined || unitCost(at) <= max_typical_sats) &&
            (min_context === undefined || (m.context ?? 0) >= min_context) &&
            (onlyFunded === undefined || !!paid === onlyFunded)
        );
        const shown = rows.slice(0, limit ?? 20).map(({ m, paid, at }) => {
          return (
            `${m.id} · ${m.nodes} node${m.nodes > 1 ? "s" : ""} · ${tokens(m.context)} context · ` +
            `${perMillion(at.promptRate)} / ${perMillion(at.completionRate)} · ` +
            `typical ${sats(unitCost(at))} sats${m.offers.some((o) => o.vision) ? " · vision" : ""}${at.extraFees ? " · plus search or reasoning fees" : ""}` +
            `${paid ? ` · funded${at !== m.cheapest && unitCost(m.cheapest) < unitCost(at) ? ` (cheapest elsewhere: typical ${sats(unitCost(m.cheapest))})` : ""}` : ""}`
          );
        });
        const head =
          `${rows.length} model${rows.length === 1 ? "" : "s"}${query ? ` match "${query}"` : ""}${rows.length < priced.length ? " and the filters" : ""} on ${reached.length} node${reached.length === 1 ? "" : "s"}` +
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
  const today = spentToday();
  if (today || config.dailySats) lines.push(`Spent today: ${sats(today)} sats${config.dailySats ? ` of a ${sats(config.dailySats)} sat daily limit` : ""}.`);
  lines.push(FUND_HINT);
  return lines.join("\n");
}

export async function serve(): Promise<void> {
  // stdout carries the MCP messages; anything a library logs there (nostr-tools prints relay notices) could pose as one
  console.log = console.info = console.debug = console.error;
  await createServer().connect(new StdioServerTransport());
  // the shell sandbox keeps the process alive; when the app goes away, so do we
  process.stdin.once("end", () => void closeSandbox().finally(() => process.exit(0)));
}
