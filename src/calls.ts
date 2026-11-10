import { config } from "./config.js";
import { host, sats } from "./format.js";
import { NodeError, request } from "./http.js";
import { normalizeNode, offersFor, unitCost, type Market, type Offer } from "./market.js";
import { completionCost, type ChatResponse, type CostReceipt, type ReasoningEffort } from "./receipt.js";
import { allowance, hold, logSpend } from "./spend.js";
import { balanceOf, readWallet, settleAll, type Key } from "./wallet.js";

/**
 * A token count that errs high for budgeting: 2 characters a token for ASCII (code runs
 * near 2.4, prose near 4), and one token per UTF-8 byte for the rest (Chinese, Russian, emoji), since a
 * byte-level tokenizer never needs more.
 */
export function estimateTokens(text: string): number {
  const ascii = text.replace(/[^\x00-\x7f]/g, "");
  return Math.ceil(ascii.length / 2) + (Buffer.byteLength(text, "utf8") - ascii.length) + 8;
}

const OUTPUT_CEILING = 8192;
const MIN_OUTPUT = 32;
/** What one image costs in prompt tokens at most providers' high detail. */
export const IMAGE_TOKENS = 1600;

const estimateCost = (offer: Offer, promptTokens: number, outputTokens: number, images = 0) =>
  (offer.requestRate ?? 0) + (promptTokens + images * IMAGE_TOKENS) * offer.promptRate + images * (offer.imageRate ?? 0) + outputTokens * offer.completionRate;

/**
 * The longest answer estimated to fit in `maxSats` at the advertised rates.
 * The serving route and final settlement can differ from the estimate.
 */
export function outputBudget(offer: Offer, promptTokens: number, maxSats: number, images = 0): number {
  const left = maxSats - estimateCost(offer, promptTokens, 0, images);
  const tokens = Math.floor(left / offer.completionRate);
  return Math.min(tokens, offer.maxOutput ?? OUTPUT_CEILING, OUTPUT_CEILING);
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  [extra: string]: unknown;
}

/** The prompt as text for counting: every string the node forwards, except image data, which is counted per image. */
export function promptSize(messages: Message[], tools?: ToolSpec[]): { tokens: number; images: number } {
  let images = 0;
  const parts: string[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") parts.push(m.content);
    else if (Array.isArray(m.content)) for (const p of m.content) p.type === "text" ? parts.push(p.text) : images++;
    for (const call of m.tool_calls ?? []) parts.push(call.function.name, call.function.arguments);
    for (const key of ["reasoning_content", "reasoning"]) if (typeof m[key] === "string") parts.push(m[key] as string);
  }
  if (tools?.length) parts.push(JSON.stringify(tools));
  return { tokens: estimateTokens(parts.join("")), images };
}

export interface Answer {
  text: string;
  receipt: CostReceipt;
}

export interface Reply extends Answer {
  /** the assistant message as the node sent it, to send back on the next turn */
  message: Message;
}

export interface AskInput {
  model: string;
  prompt: string;
  system?: string;
  /** file contents and images, already read and checked */
  attachments?: ContentPart[];
  maxSats: number;
  node?: string;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
}

export interface ChatInput {
  model: string;
  messages: Message[];
  tools?: ToolSpec[];
  /** "none" keeps the tools defined (some providers need that once tool calls are in the history) but asks for an answer */
  toolChoice?: "auto" | "none";
  maxSats: number;
  /** only this node: a pinned call never falls back */
  node?: string;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
  /** shown in the spend log */
  purpose: string;
}

function answerText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) => (typeof part === "string" ? part : (part as { text?: string })?.text ?? ""))
      .join("");
  return "";
}

/** The fields a node sent that it expects back on the next turn: reasoning models need their reasoning with their tool calls. */
function replyMessage(raw: Record<string, unknown> | undefined): Message {
  const content = raw?.content;
  const message: Message = { role: "assistant", content: typeof content === "string" || content === null ? (content as string | null) : answerText(content) };
  const calls = Array.isArray(raw?.tool_calls) ? (raw.tool_calls as ToolCall[]) : [];
  const valid = calls.filter((c) => c && typeof c.id === "string" && c.id && typeof c.function?.name === "string");
  if (valid.length)
    message.tool_calls = valid.map((c) => ({
      id: c.id,
      type: "function",
      function: {
        name: c.function.name,
        arguments: typeof c.function.arguments === "string" ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}),
      },
    }));
  for (const key of ["reasoning_content", "reasoning", "reasoning_details"]) if (raw?.[key] !== undefined && raw[key] !== null) message[key] = raw[key];
  if (message.content === null && !message.tool_calls) message.content = "";
  return message;
}

/** Thrown when no node can answer; the message says what the user can do. */
export class AskError extends Error {}

async function callOffers(market: Market, model: string, pin?: string, needsVision = false) {
  const node = pin === undefined ? undefined : normalizeNode(pin.trim());
  const { offers, missed } = await market.load();
  let all = offersFor(offers, model)
    .filter((offer) => node === undefined || offer.node === node)
    .sort((a, b) => unitCost(a) - unitCost(b));
  if (needsVision && all.length) {
    all = all.filter((o) => o.vision);
    if (!all.length) throw new AskError(`"${model}" does not take images. find_models with vision: true lists the models that do.`);
  }
  const keys = new Map<string, Key>();
  for (const k of readWallet().keys) if (!keys.has(k.node)) keys.set(k.node, k);
  const payable = all.filter((o) => keys.has(o.node));
  return { all, keys, payable, missed: missed.filter((url) => node === undefined || url === node) };
}

function noOffer(model: string, node?: string): AskError {
  return new AskError(node === undefined
    ? `No approved Routstr node sells "${model}". Use find_models to see the exact model ids.`
    : `No offer for "${model}" on the selected node. Check the model ID and node URL.`);
}

export function askMessages(input: Pick<AskInput, "prompt" | "system" | "attachments">): Message[] {
  const user: Message = input.attachments?.length
    ? { role: "user", content: [{ type: "text", text: input.prompt }, ...input.attachments] }
    : { role: "user", content: input.prompt };
  return [...(input.system ? [{ role: "system" as const, content: input.system }] : []), user];
}

/** Quote the initial request against the catalog without settling invoices or sending the prompt. */
export async function quote(market: Market, input: AskInput) {
  const { tokens: promptTokens, images } = promptSize(askMessages(input));
  const { all, keys, payable } = await callOffers(market, input.model, input.node, images > 0);
  const candidates = payable.length ? payable : all;
  const offer = candidates.find((candidate) => outputBudget(candidate, promptTokens, input.maxSats, images) >= MIN_OUTPUT)
    ?? candidates[0];
  if (!offer) throw noOffer(input.model, input.node);
  const maxOutputTokens = Math.max(0, outputBudget(offer, promptTokens, input.maxSats, images));
  const fitsTarget = maxOutputTokens >= MIN_OUTPUT;
  const minimumSats = estimateCost(offer, promptTokens, MIN_OUTPUT, images);
  if (!Number.isFinite(minimumSats)) throw new AskError("The catalog price is too large to quote.");
  return {
    model: offer.id,
    node: offer.node,
    targetSats: input.maxSats,
    estimatedInputTokens: promptTokens,
    maxOutputTokens,
    estimatedMaxSats: fitsTarget ? estimateCost(offer, promptTokens, maxOutputTokens, images) : undefined,
    requestedReasoningEffort: input.reasoningEffort,
    minimumSats,
    inputSatsPerToken: offer.promptRate,
    outputSatsPerToken: offer.completionRate,
    hasWalletKey: keys.has(offer.node),
    fitsTarget,
  };
}

/** One paid chat call on the cheapest funded node that takes it, never paying two nodes for it. */
export async function chat(market: Market, input: ChatInput): Promise<Reply> {
  await settleAll();
  const { tokens: promptTokens, images } = promptSize(input.messages, input.tools);
  const { all, keys, payable, missed } = await callOffers(market, input.model, input.node, images > 0);
  if (!payable.length) {
    const silent = missed.filter((node) => keys.has(node));
    if (silent.length)
      throw new AskError(`Your sats are on ${silent.map(host).join(", ")}, which did not answer just now. Try again in a minute.`);
    const cheapest = all[0];
    if (!cheapest) throw noOffer(input.model, input.node);
    throw new AskError(
      keys.size
        ? `"${cheapest.id}" is sold on ${host(cheapest.node)}, where you have no sats yet. ` +
            `Ask the user to run \`npx routstr-mcp fund 1000 --model ${cheapest.id}\` in a terminal.`
        : `There are no sats in the Routstr wallet yet. Ask the user to run \`npx routstr-mcp fund 1000\` in a terminal.`
    );
  }

  const today = allowance();
  if (today < 1)
    throw new AskError(`Today's limit of ${sats(config.dailySats!)} sats (ROUTSTR_DAILY_SATS) is used up. It starts again at midnight, or the user can raise it.`);
  const cap = Math.min(input.maxSats, today);
  const problems: string[] = [];

  for (const offer of payable) {
    const key = keys.get(offer.node)!;
    let budget = cap;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (input.signal?.aborted) throw new AskError("Cancelled before anything was sent.");
      const maxTokens = outputBudget(offer, promptTokens, budget, images);
      if (maxTokens < MIN_OUTPUT) {
        const needed = Math.ceil(estimateCost(offer, promptTokens, MIN_OUTPUT, images));
        const short =
          budget < cap ? `only ${sats(budget)} sats are left there`
          : cap < input.maxSats ? `only ${sats(cap)} sats are left of today's limit`
          : `${sats(budget)} sats is too little for this prompt on this model`;
        problems.push(`${host(offer.node)}: ${short} (needs at least ${needed})`);
        break;
      }
      const release = hold(budget);
      try {
        const reply = await complete(offer, key, input, maxTokens, promptTokens, images);
        logSpend({ model: offer.id, node: offer.node, sats: reply.receipt.costSats ?? estimateCost(offer, promptTokens, maxTokens, images), purpose: input.purpose, unsure: reply.receipt.costSats === undefined || undefined });
        return reply;
      } catch (e) {
        if (!(e instanceof NodeError)) throw e;
        // the node got the request and may bill it: count it against today's limit at its most
        const mayCharge = e.code === "lost" || (e.code === "cancelled" && e.message !== "Cancelled") || (e.status >= 500 && e.status !== 0);
        if (mayCharge) logSpend({ model: offer.id, node: offer.node, sats: budget, purpose: input.purpose, unsure: true });
        if (e.code === "cancelled") throw new AskError(e.message === "Cancelled" ? "Cancelled before the node got the request." : `${e.message}.`);
        if (e.status === 402 && attempt === 0) {
          // the key holds less than this call may cost: fit the answer to what is left, with room for the node's own estimate
          const { sats: owned = 0, reservedSats = 0 } = await balanceOf(key);
          const spendable = (owned - reservedSats) * 0.9;
          if (spendable < budget) {
            budget = spendable;
            continue;
          }
        }
        // try the next node only when this one never got the request, or refused it without charging (424: its upstream failed and it gave the hold back)
        if (e.code === "unreachable" || [401, 402, 404, 424, 429].includes(e.status)) {
          problems.push(
            e.status === 0 ? e.message
            : `${host(offer.node)}: ${e.status === 402 ? `not enough sats left on this node${images ? " (a node holds sats for the whole image data while the call runs, so images need a bigger balance)" : ""}` : e.message}`
          );
          break;
        }
        // trying another node now could pay twice
        if (e.status === 0) throw new AskError(`${e.message} while answering; it may still charge for this call.`);
        if (e.status >= 500) throw new AskError(`${host(offer.node)} failed while answering (${e.message}); it may still charge for this call.`);
        throw new AskError(`${host(offer.node)} refused the request: ${e.message}`);
      } finally {
        release();
      }
    }
  }
  throw new AskError(`No node could answer. ${problems.join("; ")}.`);
}

async function complete(offer: Offer, key: Key, input: ChatInput, maxTokens: number, promptTokens: number, images: number): Promise<Reply> {
  const payload: Record<string, unknown> = {
    model: offer.id, messages: input.messages, max_tokens: maxTokens, reasoning_effort: input.reasoningEffort, stream: false,
  };
  if (input.tools?.length) {
    payload.tools = input.tools;
    payload.tool_choice = input.toolChoice ?? "auto";
  }
  const { body, headers } = await request<ChatResponse | null>(offer.node, "/v1/chat/completions", {
    method: "POST",
    key: key.key,
    // long enough for a slow reasoning model to write the whole budget (10 tokens a second), since a cut-off call is still billed
    timeoutMs: 60_000 + maxTokens * 100,
    body: JSON.stringify(payload),
    signal: input.signal,
  });
  const response = body ?? {};
  const cost = completionCost(response, headers, offer);
  const settled = cost.costSource === "node_header" || cost.costSource === "node_body";
  const left = await balanceOf(key);
  const message = replyMessage(response.choices?.[0]?.message as Record<string, unknown> | undefined);
  return {
    message,
    text: answerText(message.content),
    receipt: {
      ...cost,
      model: offer.id,
      node: offer.node,
      targetSats: input.maxSats,
      estimatedInputTokens: promptTokens,
      maxOutputTokens: maxTokens,
      estimatedMaxSats: estimateCost(offer, promptTokens, maxTokens, images),
      requestedReasoningEffort: input.reasoningEffort,
      overTarget: settled && cost.costSats !== undefined ? cost.costSats > input.maxSats : undefined,
      balanceSats: Number.isFinite(left.sats) ? left.sats : undefined,
      ...(offer.extraFees ? { extraFees: true } : {}),
    },
  };
}

export async function ask(market: Market, input: AskInput, purpose = "ask"): Promise<Answer> {
  const { text, receipt } = await chat(market, {
    model: input.model,
    messages: askMessages(input),
    maxSats: input.maxSats,
    node: input.node,
    reasoningEffort: input.reasoningEffort,
    signal: input.signal,
    purpose,
  });
  return { text, receipt };
}

export type CouncilSeat = { model: string } & ({ answer: Answer } | { error: string });

/** The same question to several models at once; the calling agent compares the answers. */
export async function council(
  market: Market,
  models: string[],
  input: Omit<AskInput, "model">
): Promise<CouncilSeat[]> {
  return Promise.all(
    models.map(async (model) => {
      try {
        return { model, answer: await ask(market, { ...input, model }, "council") };
      } catch (e) {
        return { model, error: (e as Error).message };
      }
    })
  );
}
