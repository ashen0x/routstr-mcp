import { z } from "zod";
import type { Offer } from "./market.js";

interface NodeCost {
  charged_msats?: number;
  total_msats?: number;
  computed_msats?: number;
  input_msats?: number;
  output_msats?: number;
  cache_read_input_tokens?: number;
}

export interface ChatResponse {
  model?: string;
  provider?: string;
  choices?: { message?: { content?: unknown }; finish_reason?: string }[];
  metadata?: { routstr?: { cost?: NodeCost } };
  cost?: NodeCost;
  usage?: {
    prompt_tokens?: number;
    input_tokens?: number;
    completion_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    prompt_tokens_details?: { cached_tokens?: number };
    cost?: NodeCost;
  };
}

const optionalNumber = z.number().nonnegative().optional();
export const reasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const receiptSchema = z.object({
  model: z.string(),
  node: z.string(),
  targetSats: z.number(),
  estimatedInputTokens: z.number(),
  maxOutputTokens: z.number(),
  estimatedMaxSats: z.number(),
  requestedReasoningEffort: reasoningEffortSchema.optional(),
  requestId: z.string().optional(),
  reportedModel: z.string().optional(),
  provider: z.string().optional(),
  finishReason: z.string().optional(),
  inputTokens: optionalNumber,
  outputTokens: optionalNumber,
  reasoningTokens: optionalNumber,
  cachedInputTokens: optionalNumber,
  costSource: z.enum(["node_header", "node_body", "estimate", "unavailable"]),
  costSats: optionalNumber,
  computedCostSats: optionalNumber,
  inputCostSats: optionalNumber,
  outputCostSats: optionalNumber,
  overTarget: z.boolean().optional(),
  balanceSats: z.number().optional(),
});

export type CostReceipt = z.infer<typeof receiptSchema>;

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const headerCount = (headers: Headers, name: string): number | undefined => {
  const value = headers.get(name);
  return value !== null && /^\d+$/.test(value) ? count(Number(value)) : undefined;
};

// Metadata can come from upstream. Keep short labels and drop free-form values.
const label = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 200 &&
  !/[^a-zA-Z0-9 _.:/@+-]/.test(value) ? value : undefined;

export function completionCost(body: ChatResponse, headers: Headers, offer: Offer) {
  const usage = body.usage;
  const cost = body.metadata?.routstr?.cost ?? body.cost ?? usage?.cost;
  const inputTokens = count(usage?.prompt_tokens) ?? count(usage?.input_tokens);
  const outputTokens = count(usage?.completion_tokens) ?? count(usage?.output_tokens);
  const fromHeader = headerCount(headers, "x-routstr-cost-msats");
  const fromBody = count(cost?.charged_msats) ?? count(cost?.total_msats);
  const charged = fromHeader ?? fromBody;
  const estimate = inputTokens !== undefined && outputTokens !== undefined
    ? inputTokens * offer.promptRate + outputTokens * offer.completionRate
    : undefined;
  const costSats = charged !== undefined ? charged / 1000
    : estimate !== undefined && Number.isFinite(estimate) ? estimate : undefined;
  const costSource: CostReceipt["costSource"] = fromHeader !== undefined ? "node_header"
    : fromBody !== undefined ? "node_body"
    : costSats !== undefined ? "estimate" : "unavailable";
  const sats = (header: string, field: unknown) => {
    const msats = headerCount(headers, header) ?? count(field);
    return msats === undefined ? undefined : msats / 1000;
  };
  return {
    requestId: label(headers.get("x-routstr-request-id")),
    reportedModel: label(body.model),
    provider: label(body.provider),
    finishReason: label(body.choices?.[0]?.finish_reason),
    inputTokens,
    outputTokens,
    reasoningTokens: count(usage?.completion_tokens_details?.reasoning_tokens) ?? count(usage?.reasoning_tokens),
    cachedInputTokens: count(usage?.prompt_tokens_details?.cached_tokens) ?? count(cost?.cache_read_input_tokens),
    costSource,
    costSats,
    computedCostSats: sats("x-routstr-computed-cost-msats", cost?.computed_msats),
    inputCostSats: sats("x-routstr-input-cost-msats", cost?.input_msats),
    outputCostSats: sats("x-routstr-output-cost-msats", cost?.output_msats),
  };
}
