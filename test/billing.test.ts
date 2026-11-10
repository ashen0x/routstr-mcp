import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { completionCost } from "../src/receipt.js";

test("quotes and receipts agree on the request and expose a node-reported overrun", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "routstr-mcp-billing-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const key = "sk-test-credential-123456789";
  const requests: { method: string | undefined; url: string | undefined }[] = [];
  const submitted: { max_tokens: number; reasoning_effort?: string; authorization?: string }[] = [];
  const mock = createHttpServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/v1/models")) {
      const rate = req.url.startsWith("/alt/") ? 0.001 : 0.01;
      res.end(JSON.stringify({ data: [{ id: "test-model", sats_pricing: { prompt: rate, completion: rate } }] }));
    } else if (req.url === "/v1/balance/info") {
      res.end(JSON.stringify({ balance: 1234, reserved: 0 }));
    } else if (req.url === "/v1/chat/completions") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const { max_tokens, reasoning_effort } = JSON.parse(raw);
      submitted.push({ max_tokens, reasoning_effort, authorization: req.headers.authorization });
      res.setHeader("x-routstr-cost-msats", "3200");
      res.setHeader("x-routstr-input-cost-msats", "200");
      res.setHeader("x-routstr-request-id", "request-test-1");
      res.end(JSON.stringify({
        model: "test-revision",
        provider: `router:${key}`,
        choices: [{ message: { content: `answer ${key}` }, finish_reason: "length" }],
        usage: { prompt_tokens: 16, completion_tokens: 24, completion_tokens_details: { reasoning_tokens: 20 } },
        cost: { total_msats: 3100, output_msats: 2900, computed_msats: 3500 },
      }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  }).listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve) => mock.close(() => resolve())));
  await once(mock, "listening");
  const node = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  process.env.ROUTSTR_MCP_HOME = home;
  process.env.ROUTSTR_NODES = `${node},${node}/alt`;
  writeFileSync(join(home, "wallet.json"), JSON.stringify({
    version: 1, keys: [{ node, key, addedAt: 0 }], pending: [],
  }), { mode: 0o600 });

  const { createServer } = await import("../src/server.js");
  const client = new Client({ name: "billing-test", version: "0" });
  const server = createServer();
  t.after(async () => { await client.close(); await server.close(); });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const tool = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

  const args = { model: "test-model", prompt: "wallet code", system: "review", max_sats: 2, reasoning_effort: "low" };
  const quoted = await tool("quote", args);
  const quote = (quoted.structuredContent as { quote: Record<string, unknown> }).quote;
  assert.equal(quote.node, node, "quote prefers the same node with a wallet key as ask");
  assert.equal(quote.hasWalletKey, true);
  assert.equal(quote.fitsTarget, true);
  assert.equal(quote.requestedReasoningEffort, "low");
  assert.deepEqual(requests.map((request) => request.method), ["GET", "GET"], "quote only fetches the catalog");
  const unfunded = await tool("quote", { ...args, node: `${node}/alt` });
  assert.equal((unfunded.structuredContent as { quote: { hasWalletKey: boolean } }).quote.hasWalletKey, false);
  const low = await tool("quote", { ...args, max_sats: 0.01 });
  assert.equal((low.structuredContent as { quote: { fitsTarget: boolean } }).quote.fitsTarget, false);
  const rejected = await tool("ask", { ...args, node: `${node}/alt` });
  assert.equal(rejected.isError, true);
  assert.equal(submitted.length, 0, "a pin never falls back to the other node");

  const asked = await tool("ask", { ...args, node: quote.node, model: quote.model });
  assert.equal(asked.isError, false);
  assert.deepEqual(submitted, [{ max_tokens: quote.maxOutputTokens, reasoning_effort: "low", authorization: `Bearer ${key}` }]);
  assert.doesNotMatch(JSON.stringify(asked), new RegExp(key));
  assert.match(JSON.stringify(asked.content), /charged more than the 2 sat target/);
  const receipt = (asked.structuredContent as { receipt: Record<string, unknown> }).receipt;
  assert.deepEqual(receipt, {
    model: "test-model", node, targetSats: 2, estimatedInputTokens: quote.estimatedInputTokens,
    maxOutputTokens: quote.maxOutputTokens, estimatedMaxSats: quote.estimatedMaxSats,
    requestedReasoningEffort: "low",
    requestId: "request-test-1", reportedModel: "test-revision", provider: "router:[secret removed]",
    finishReason: "length", inputTokens: 16, outputTokens: 24, reasoningTokens: 20,
    costSource: "node_header", costSats: 3.2, inputCostSats: 0.2, outputCostSats: 2.9,
    computedCostSats: 3.5, overTarget: true, balanceSats: 1.234,
  });

  const council = await tool("council", { ...args, models: ["test-model", "missing"], max_sats_each: 2, node });
  const report = council.structuredContent as { allChargesReported: boolean; totalCostSats: number; seats: object[] };
  assert.equal(report.allChargesReported, false);
  assert.equal(report.totalCostSats, 3.2);
  assert.deepEqual(report.seats.map((seat) => "receipt" in seat), [true, false]);
});

test("reported zero stays a settled charge and estimates use reported token counts", () => {
  const offer = { node: "https://example.com", id: "test", name: "test", aliases: [], promptRate: 0.01, completionRate: 0.02 };
  const response = { usage: { input_tokens: 4, output_tokens: 3, cost: { charged_msats: 1200 } } };
  const headers = new Headers({ "x-routstr-cost-msats": "0" });
  const zero = completionCost(response, headers, offer);
  assert.equal(zero.costSource, "node_header");
  assert.equal(zero.costSats, 0);
  headers.set("x-routstr-cost-msats", "");
  const fallback = completionCost(response, headers, offer);
  assert.equal(fallback.costSource, "node_body");
  assert.equal(fallback.costSats, 1.2);
  const estimate = completionCost({ usage: { prompt_tokens: 4, completion_tokens: 3 } }, headers, offer);
  assert.equal(estimate.costSource, "estimate");
  assert.equal(estimate.costSats, 0.1);
  assert.equal(completionCost({ usage: { prompt_tokens: 4 } }, headers, offer).costSource, "unavailable");
});
