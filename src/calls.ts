import { host, sats } from "./format.js";
import { NodeError, request } from "./http.js";
import { offersFor, unitCost, type Market, type Offer } from "./market.js";
import { balanceOf, readWallet, settleAll, type Key } from "./wallet.js";

/** A rough token count that errs high, so the per-call cap holds. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3) + 8;

const OUTPUT_CEILING = 8192;
const MIN_OUTPUT = 32;

/**
 * The longest answer that fits in `maxSats`. The node reserves prompt + max_tokens at its
 * own rates before calling upstream, so this is what keeps one call under the cap.
 */
export function outputBudget(offer: Offer, promptTokens: number, maxSats: number): number {
  const left = maxSats - promptTokens * offer.promptRate;
  const tokens = Math.floor(left / offer.completionRate);
  return Math.min(tokens, offer.maxOutput ?? OUTPUT_CEILING, OUTPUT_CEILING);
}

export interface Answer {
  model: string;
  node: string;
  text: string;
  costSats: number;
  leftSats?: number;
  cut: boolean;
}

export interface AskInput {
  model: string;
  prompt: string;
  system?: string;
  maxSats: number;
}

interface ChatResponse {
  choices?: { message?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

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

export async function ask(market: Market, input: AskInput): Promise<Answer> {
  await settleAll();
  const { offers } = await market.load();
  const all = offersFor(offers, input.model);
  if (!all.length)
    throw new AskError(`No approved Routstr node sells "${input.model}". Use find_models to see the exact model ids.`);

  const keys = new Map(readWallet().keys.map((k) => [k.node, k] as const));
  const payable = all.filter((o) => keys.has(o.node)).sort((a, b) => unitCost(a) - unitCost(b));
  if (!payable.length) {
    const cheapest = [...all].sort((a, b) => unitCost(a) - unitCost(b))[0]!;
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
        const needed = Math.ceil(promptTokens * offer.promptRate + MIN_OUTPUT * offer.completionRate);
        const short = budget < input.maxSats ? `only ${sats(budget)} sats are left there` : `${sats(budget)} sats is too little for this prompt on this model`;
        problems.push(`${host(offer.node)}: ${short} (needs at least ${needed})`);
        break;
      }
      try {
        return await complete(offer, key, messages, maxTokens, promptTokens);
      } catch (e) {
        if (!(e instanceof NodeError)) throw e;
        if (e.status === 402 && attempt === 0) {
          // the key holds less than this call may cost: fit the answer to what is left, with room for the node's own estimate
          const { sats: held = 0, reservedSats = 0 } = await balanceOf(key);
          const spendable = (held - reservedSats) * 0.9;
          if (spendable < budget) {
            budget = spendable;
            continue;
          }
        }
        // try the next node only when this one never got the request, or refused it without charging
        if (e.code === "unreachable" || e.status === 402 || e.status >= 500) {
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

async function complete(offer: Offer, key: Key, messages: object[], maxTokens: number, promptTokens: number): Promise<Answer> {
  const { body, headers } = await request<ChatResponse>(offer.node, "/v1/chat/completions", {
    method: "POST",
    key: key.key,
    timeoutMs: 180_000,
    body: JSON.stringify({ model: offer.id, messages, max_tokens: maxTokens, stream: false }),
  });
  const charged = headers.get("x-routstr-cost-msats");
  const usage = body.usage;
  const costSats =
    charged !== null && Number(charged) >= 0
      ? Number(charged) / 1000
      : (usage?.prompt_tokens ?? promptTokens) * offer.promptRate + (usage?.completion_tokens ?? 0) * offer.completionRate;
  const left = await balanceOf(key);
  return {
    model: offer.id,
    node: offer.node,
    text: answerText(body),
    costSats,
    leftSats: left.sats,
    cut: body.choices?.[0]?.finish_reason === "length",
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

