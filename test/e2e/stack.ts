// A real Routstr stack on this machine: routstr-core from a local checkout (KIT_CORE_DIR, with
// its .venv), a real Cashu mint (nutshell) whose Lightning is faked so invoices pay at once,
// and a fake AI upstream. Only the AI and the Lightning network are fake.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

const UPSTREAM_KEY = "e2e-upstream-key";
const BTC_USD = 100_000; // 1 sat = $0.001

/** USD per token. */
export const MODELS = [
  { id: "e2e-smart", name: "E2E Smart", prompt: 0.00001, completion: 0.00003 },
  { id: "e2e-cheap", name: "E2E Cheap", prompt: 0.000001, completion: 0.000002 },
];

const childEnv = () => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/_proxy$/i.test(name)) delete env[name];
  return env;
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(what: string, ms: number, ready: () => Promise<boolean>, child: ChildProcess) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${what} exited before it was ready`);
    if (await ready().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${what} was not ready after ${ms / 1000} s`);
}

export interface ChatSeen {
  model: string;
  max_tokens?: number;
  prompt: string;
  tools?: string[];
}

type Content = string | null | { type: string; text?: string }[];
const plain = (content: Content) => (Array.isArray(content) ? content.map((p) => p.text ?? `[${p.type}]`).join("\n") : content ?? "");

/** A scripted subagent: reads notes.txt, edits it, then reports what it read; or reports at once when told to stop. */
function agentStep(messages: { role: string; content: Content }[], toolChoice: unknown) {
  const results = messages.filter((m) => m.role === "tool").map((m) => plain(m.content));
  if (toolChoice === "none" || results.length >= 2)
    return { message: { role: "assistant", content: `Report: notes.txt said ${JSON.stringify(results[0]?.split("\n").find((l) => l.includes("hello"))?.replace(/^\d+\t/, "") ?? "nothing")}` }, finish: "stop" };
  const call = results.length === 0
    ? { name: "read", arguments: { path: "notes.txt" } }
    : { name: "edit", arguments: { path: "notes.txt", old_string: "hello world", new_string: "hello from the subagent" } };
  return {
    message: { role: "assistant", content: null, tool_calls: [{ id: `call_${results.length + 1}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] },
    finish: "tool_calls",
  };
}

export interface Upstream {
  url: string;
  seen: ChatSeen[];
  close(): Promise<void>;
}

/** Answers "Echo: <question>", or fails with N when the question holds "[fail=N]"; given tools, it acts as a scripted subagent. */
export async function startUpstream(): Promise<Upstream> {
  const seen: ChatSeen[] = [];
  const json = (res: http.ServerResponse, status: number, body: unknown) =>
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const route = (req.url ?? "/").split("?")[0];
      if (req.method === "POST" && /^(\/v1)?\/chat\/completions$/.test(route!)) {
        if (req.headers.authorization !== `Bearer ${UPSTREAM_KEY}`) return json(res, 401, { error: { message: "bad key" } });
        const body = JSON.parse(raw);
        const prompt = body.messages.map((m: { content: Content }) => plain(m.content)).join("\n");
        seen.push({ model: body.model, max_tokens: body.max_tokens, prompt, tools: body.tools?.map((t: { function: { name: string } }) => t.function.name) });
        const fail = prompt.match(/\[fail=(\d+)\]/);
        if (fail) return json(res, Number(fail[1]), { error: { message: "upstream failed on purpose" } });
        const { message, finish } = body.tools
          ? agentStep(body.messages, body.tool_choice)
          : { message: { role: "assistant", content: `Echo: ${plain(body.messages.at(-1).content)}` }, finish: "stop" };
        const reply = JSON.stringify(message);
        const usage = { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: Math.ceil(reply.length / 4) };
        return json(res, 200, {
          id: `chatcmpl-e2e-${seen.length}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{ index: 0, message, finish_reason: finish }],
          usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
        });
      }
      if (/^(\/v1)?\/models$/.test(route!))
        return json(res, 200, { object: "list", data: MODELS.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: "e2e" })) });
      if (route === "/api/v1/models")
        return json(res, 200, {
          data: MODELS.map((m) => ({
            id: m.id,
            canonical_slug: m.id,
            name: m.name,
            created: 0,
            description: "e2e model",
            context_length: 8192,
            architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"], tokenizer: "Other", instruct_type: null },
            pricing: { prompt: String(m.prompt), completion: String(m.completion), request: "0", image: "0", web_search: "0", internal_reasoning: "0" },
            top_provider: { context_length: 8192, max_completion_tokens: 2048, is_moderated: false },
            per_request_limits: null,
            supported_parameters: ["max_tokens", "temperature", "stream", "tools", "tool_choice"],
          })),
        });
      if (route === "/api/v1/embeddings/models") return json(res, 200, { data: [] });
      if (route === "/0/public/Ticker") return json(res, 200, { error: [], result: { XXBTZUSD: { c: [String(BTC_USD), "1"] } } });
      if (route === "/v2/prices/BTC-USD/spot") return json(res, 200, { data: { amount: String(BTC_USD), base: "BTC", currency: "USD" } });
      if (route === "/api/v3/ticker/price") return json(res, 200, { symbol: "BTCUSDT", price: String(BTC_USD) });
      json(res, 404, { error: { message: `no ${route}` } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}

export interface Service {
  url: string;
  log: string;
  stop(): Promise<void>;
}

function spawnService(cmd: string, args: string[], dir: string, env: NodeJS.ProcessEnv, logName: string) {
  const log = path.join(dir, logName);
  const out = fs.openSync(log, "w");
  const child = spawn(cmd, args, { cwd: dir, env, stdio: ["ignore", out, out], detached: true });
  const stop = async () => {
    if (child.exitCode !== null) return;
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          /* gone */
        }
        resolve();
      }, 3000);
      child.once("exit", () => (clearTimeout(timer), resolve()));
    });
  };
  process.once("exit", () => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      /* gone */
    }
  });
  return { child, log, stop };
}

/** nutshell 0.20 with FakeWallet: every invoice it issues is paid at once. */
export async function startMint(dir: string): Promise<Service> {
  fs.mkdirSync(dir, { recursive: true });
  const port = await freePort();
  const python = process.env.E2E_PYTHON ?? "/usr/bin/python3.12";
  const { child, log, stop } = spawnService(
    "uvx",
    ["--python", python, "--from", "cashu==0.20.0", "--with", "marshmallow<4", "--with", "limits<4", "mint"],
    dir,
    {
      ...childEnv(),
      MINT_BACKEND_BOLT11_SAT: "FakeWallet",
      MINT_LISTEN_HOST: "127.0.0.1",
      MINT_LISTEN_PORT: String(port),
      MINT_PRIVATE_KEY: `e2e-test-only-${port}`,
      MINT_DATABASE: "./data",
      FAKEWALLET_DELAY_INCOMING_PAYMENT: "0",
      FAKEWALLET_DELAY_OUTGOING_PAYMENT: "0",
      FAKEWALLET_PAY_INVOICE_STATE: "SETTLED",
      FAKEWALLET_PAYMENT_STATE: "SETTLED",
    },
    "mint.log"
  );
  const url = `http://127.0.0.1:${port}`;
  await waitFor(`mint (log: ${log})`, 120_000, async () => (await fetch(`${url}/v1/info`)).ok, child);
  return { url, log, stop };
}

/** A pass-through in front of the mint that can hold back news of payments, like a payment still on its way. */
export async function startMintProxy(target: string) {
  let hiding = false;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", async () => {
      const upstream = await fetch(`${target}${req.url}`, {
        method: req.method,
        headers: { "content-type": req.headers["content-type"] ?? "application/json" },
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      let text = await upstream.text();
      if (hiding && req.method === "GET" && req.url?.startsWith("/v1/mint/quote/bolt11/"))
        text = text.replace(/"state":\s*"PAID"/g, '"state":"UNPAID"').replace(/"paid":\s*true/g, '"paid":false');
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(text);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    hidePayments: (on: boolean) => (hiding = on),
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}

const LAUNCHER = new URL("../../../test/e2e/core_launcher.py", import.meta.url).pathname;

/** Real routstr-core, paid through `mintUrl`, answering from the fake upstream. */
export async function startCore(coreDir: string, dir: string, mintUrl: string, upstreamUrl: string): Promise<Service> {
  const python = path.join(coreDir, ".venv", "bin", "python");
  if (!fs.existsSync(python)) throw new Error(`No routstr-core venv at ${python}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["alembic.ini", "migrations"]) fs.symlinkSync(path.join(coreDir, name), path.join(dir, name));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const { child, log, stop } = spawnService(
    python,
    [LAUNCHER],
    dir,
    {
      ...childEnv(),
      PYTHONPATH: coreDir,
      KIT_CORE_PORT: String(port),
      KIT_UPSTREAM_URL: upstreamUrl,
      DATABASE_URL: `sqlite+aiosqlite:///${path.join(dir, "core.db")}`,
      UPSTREAM_BASE_URL: `${upstreamUrl}/v1`,
      UPSTREAM_API_KEY: UPSTREAM_KEY,
      CASHU_MINTS: mintUrl,
      NAME: "E2E Node",
      HTTP_URL: url,
      RELAYS: "",
      ENABLE_ANALYTICS_SHARING: "false",
      LITELLM_LOCAL_MODEL_COST_MAP: "True",
      MIN_PAYOUT_SAT: "100000000",
      LOG_LEVEL: "INFO",
    },
    "core.log"
  );
  await waitFor(
    `routstr-core (log: ${log})`,
    120_000,
    async () => {
      const res = await fetch(`${url}/v1/models`);
      const body = (await res.json()) as { data?: { sats_pricing?: unknown }[] };
      return res.ok && (body.data ?? []).some((m) => m.sats_pricing);
    },
    child
  );
  return { url, log, stop };
}
