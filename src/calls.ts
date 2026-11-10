import { host, sats } from "./format.js";
import { NodeError, request } from "./http.js";
import { normalizeNode, offersFor, unitCost, type Market, type Offer } from "./market.js";
import { completionCost, type ChatResponse, type CostReceipt, type ReasoningEffort } from "./receipt.js";
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

/**
 * The longest answer estimated to fit in `maxSats` at the advertised rates.
 * The serving route and final settlement can differ from the estimate.
 */
export function outputBudget(offer: Offer, promptTokens: number, maxSats: number): number {
  const left = maxSats - promptTokens * offer.promptRate;
  const tokens = Math.floor(left / offer.completionRate);
  return Math.min(tokens, offer.maxOutput ?? OUTPUT_CEILING, OUTPUT_CEILING);
}

export interface Answer {
  text: string;
  receipt: CostReceipt;
}

export interface AskInput {
  model: string;
  prompt: string;
  system?: string;
  maxSats: number;
  node?: string;
  reasoningEffort?: ReasoningEffort;
}

const estimateCost = (offer: Offer, promptTokens: number, outputTokens: number) =>
  promptTokens * offer.promptRate + outputTokens * offer.completionRate;

function answerText(response: ChatResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) => (typeof part === "string" ? part : (part as { text?: string })?.text ?? ""))
      .join("");
  return "";
}

/** Thrown when no node can answer; the message says what the user can do. */
export class AskError extends Error {}

async function callOffers(market: Market, input: AskInput) {
  const node = input.node === undefined ? undefined : normalizeNode(input.node.trim());
  const { offers, missed } = await market.load();
  const all = offersFor(offers, input.model)
    .filter((offer) => node === undefined || offer.node === node)
    .sort((a, b) => unitCost(a) - unitCost(b));
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

/** Quote the initial request against the catalog without settling invoices or sending the prompt. */
export async function quote(market: Market, input: AskInput) {
  const { all, keys, payable } = await callOffers(market, input);
  const candidates = payable.length ? payable : all;
  const promptTokens = estimateTokens((input.system ?? "") + input.prompt);
  const offer = candidates.find((candidate) => outputBudget(candidate, promptTokens, input.maxSats) >= MIN_OUTPUT)
    ?? candidates[0];
  if (!offer) throw noOffer(input.model, input.node);
  const maxOutputTokens = Math.max(0, outputBudget(offer, promptTokens, input.maxSats));
  const fitsTarget = maxOutputTokens >= MIN_OUTPUT;
  const minimumSats = estimateCost(offer, promptTokens, MIN_OUTPUT);
  if (!Number.isFinite(minimumSats)) throw new AskError("The catalog price is too large to quote.");
  return {
    model: offer.id,
    node: offer.node,
    targetSats: input.maxSats,
    estimatedInputTokens: promptTokens,
    maxOutputTokens,
    estimatedMaxSats: fitsTarget ? estimateCost(offer, promptTokens, maxOutputTokens) : undefined,
    requestedReasoningEffort: input.reasoningEffort,
    minimumSats,
    inputSatsPerToken: offer.promptRate,
    outputSatsPerToken: offer.completionRate,
    hasWalletKey: keys.has(offer.node),
    fitsTarget,
  };
}

export async function ask(market: Market, input: AskInput): Promise<Answer> {
  await settleAll();
  const { all, keys, payable, missed } = await callOffers(market, input);
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

  const messages = [
    ...(input.system ? [{ role: "system", content: input.system }] : []),
    { role: "user", content: input.prompt },
  ];
  const promptTokens = estimateTokens((input.system ?? "") + input.prompt);
  const problems: string[] = [];

  for (const offer of payable) {
    const key = keys.get(offer.node)!;
    let budget = input.maxSats;
    for (let attempt = 0; attempt < 2; attempt++) {
      const maxTokens = outputBudget(offer, promptTokens, budget);
      if (maxTokens < MIN_OUTPUT) {
        const needed = Math.ceil(estimateCost(offer, promptTokens, MIN_OUTPUT));
        const short = budget < input.maxSats ? `only ${sats(budget)} sats are left there` : `${sats(budget)} sats is too little for this prompt on this model`;
        problems.push(`${host(offer.node)}: ${short} (needs at least ${needed})`);
        break;
      }
      try {
        return await complete(offer, key, messages, maxTokens, promptTokens, input);
      } catch (e) {
        if (!(e instanceof NodeError)) throw e;
        if (e.status === 402 && attempt === 0) {
          // the key holds less than this call may cost: fit the answer to what is left, with room for the node's own estimate
          const { sats: owned = 0, reservedSats = 0 } = await balanceOf(key);
          const spendable = (owned - reservedSats) * 0.9;
          if (spendable < budget) {
            budget = spendable;
            continue;
          }
        }
        // try the next node only when this one never got the request, or refused it without charging
        if (e.code === "unreachable" || [401, 402, 404, 429].includes(e.status) || e.status >= 500) {
          problems.push(e.status === 0 ? e.message : `${host(offer.node)}: ${e.status === 402 ? "not enough sats left on this node" : e.message}`);
          break;
        }
        // trying another node now could pay twice
        if (e.status === 0) throw new AskError(`${e.message} while answering; it may still charge for this call.`);
        throw new AskError(`${host(offer.node)} refused the request: ${e.message}`);
      }
    }
  }
  throw new AskError(`No node could answer. ${problems.join("; ")}.`);
}

async function complete(
  offer: Offer, key: Key, messages: object[], maxTokens: number, promptTokens: number, input: AskInput,
): Promise<Answer> {
  const { body, headers } = await request<ChatResponse | null>(offer.node, "/v1/chat/completions", {
    method: "POST",
    key: key.key,
    // long enough for a slow reasoning model to write the whole budget (10 tokens a second), since a cut-off call is still billed
    timeoutMs: 60_000 + maxTokens * 100,
    body: JSON.stringify({
      model: offer.id, messages, max_tokens: maxTokens, reasoning_effort: input.reasoningEffort, stream: false,
    }),
  });
  const response = body ?? {};
  const cost = completionCost(response, headers, offer);
  const settled = cost.costSource === "node_header" || cost.costSource === "node_body";
  const left = await balanceOf(key);
  return {
    text: answerText(response),
    receipt: {
      ...cost,
      model: offer.id,
      node: offer.node,
      targetSats: input.maxSats,
      estimatedInputTokens: promptTokens,
      maxOutputTokens: maxTokens,
      estimatedMaxSats: estimateCost(offer, promptTokens, maxTokens),
      requestedReasoningEffort: input.reasoningEffort,
      overTarget: settled && cost.costSats !== undefined ? cost.costSats > input.maxSats : undefined,
      balanceSats: Number.isFinite(left.sats) ? left.sats : undefined,
    },
  };
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
        return { model, answer: await ask(market, { ...input, model }) };
      } catch (e) {
        return { model, error: (e as Error).message };
      }
    })
  );
}

