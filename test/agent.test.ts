import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { globRegex, isSecretPath, scrub, unifiedDiff, Workspace, WorkspaceError } from "../src/workspace.js";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "routstr-agent-")));
const project = path.join(tmp, "project");
const home = path.join(tmp, "home");
const KEY = "sk-agent-test-credential-0123456789";

function makeProject() {
  fs.rmSync(project, { recursive: true, force: true });
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "app.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
  fs.writeFileSync(path.join(project, "src", "util.ts"), "export function add(x: number, y: number) {\n  return x + y;\n}\n");
  fs.writeFileSync(path.join(project, ".env"), "API_TOKEN=do-not-send\n");
  fs.writeFileSync(path.join(project, ".env.example"), "API_TOKEN=\n");
  fs.writeFileSync(path.join(project, "notes.md"), `token in docs: ${"sk-" + "a".repeat(30)}\n`);
  fs.writeFileSync(path.join(tmp, "outside.txt"), "outside\n");
  fs.symlinkSync(path.join(tmp, "outside.txt"), path.join(project, "link.txt"));
  execFileSync("git", ["init", "-q"], { cwd: project });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: project });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "start"], { cwd: project });
}

test("the workspace stays inside the project and keeps secrets out", () => {
  makeProject();
  const ws = new Workspace([project]);
  for (const bad of ["../outside.txt", path.join(tmp, "outside.txt"), "link.txt", "/etc/passwd"])
    assert.throws(() => ws.read(bad), /outside the project/, bad);
  for (const secret of [".env", ".git/config", "keys/id_ed25519", "deploy.pem"]) assert.ok(isSecretPath(secret), secret);
  assert.throws(() => ws.read(".env"), /secrets/);
  assert.match(ws.read(".env.example"), /API_TOKEN=/);
  assert.doesNotMatch(ws.ls(".", 3), /\.env\n|\.git\//);
  assert.match(ws.read("notes.md"), /\[secret removed\]/);
  assert.equal(scrub(`key ${KEY} end`), "key [secret removed] end");
  assert.match(ws.read("src/app.ts", 2, 1), /^src\/app.ts, lines 2-2 of 4:\n2\texport const b = 2;\n/);
});

test("edits with read access are only proposed, and the patch applies cleanly", () => {
  makeProject();
  const ws = new Workspace([project], "read");
  assert.throws(() => ws.edit("src/app.ts", "export const", "x"), /matches 3 places/);
  assert.throws(() => ws.edit("src/app.ts", "nope", "x"), /not found/);
  ws.edit("src/app.ts", "export const b = 2;", "export const b = 20;");
  ws.edit("src/app.ts", "export const", "export let", true);
  ws.write("src/new/deep.ts", "export {};\n");
  assert.throws(() => ws.write(".env", "x"), /secrets/);
  assert.throws(() => ws.write("../escape.ts", "x"), /outside/);
  assert.equal(fs.readFileSync(path.join(project, "src", "app.ts"), "utf8").includes("20"), false, "nothing written");
  assert.match(ws.read("src/app.ts"), /proposed edits[\s\S]*export let b = 20;/);
  const patch = ws.patch();
  fs.writeFileSync(path.join(tmp, "p.diff"), patch);
  execFileSync("git", ["apply", "--check", path.join(tmp, "p.diff")], { cwd: project });
  assert.deepEqual(ws.changes().map((c) => [c.file, c.added, c.removed, c.created]), [
    ["src/app.ts", 3, 3, false],
    ["src/new/deep.ts", 1, 0, true],
  ]);
});

test("edits with edit access are written", () => {
  makeProject();
  const ws = new Workspace([project], "edit");
  ws.edit("src/util.ts", "x + y", "x + y + 0");
  assert.match(fs.readFileSync(path.join(project, "src", "util.ts"), "utf8"), /x \+ y \+ 0/);
  assert.match(ws.patch(), /-  return x \+ y;\n\+  return x \+ y \+ 0;/);
});

test("glob, grep and git", async () => {
  makeProject();
  const ws = new Workspace([project]);
  assert.equal(await ws.glob("**/*.ts"), "src/app.ts\nsrc/util.ts");
  assert.equal(await ws.glob("*.md"), "notes.md");
  assert.ok(globRegex("src/**/*.{ts,js}").test("src/a/b.js"));
  assert.ok(!globRegex("src/*.ts").test("src/a/b.ts"));
  assert.match(await ws.grep("return x"), /^src\/util.ts:2:  return x \+ y;/);
  assert.doesNotMatch(await ws.grep("API_TOKEN"), /\.env:/, "secret files are not searched");
  fs.appendFileSync(path.join(project, ".env"), "MORE=1\n");
  fs.appendFileSync(path.join(project, "src", "app.ts"), "export const d = 4;\n");
  const diff = await ws.git("diff");
  assert.match(diff, /\+export const d = 4;/);
  assert.doesNotMatch(diff, /MORE=1/);
  // a user's git config must not change the patch shape the secret filter reads
  const hostile = { diff_mnemonicPrefix: "true", diff_noprefix: "true", color_diff: "always", color_ui: "always" };
  Object.assign(process.env, { GIT_CONFIG_COUNT: "4" }, ...Object.entries(hostile).map(([k, v], i) => ({ [`GIT_CONFIG_KEY_${i}`]: k.replace("_", "."), [`GIT_CONFIG_VALUE_${i}`]: v })));
  try {
    const shaped = await ws.git("diff");
    assert.match(shaped, /\+export const d = 4;/);
    assert.doesNotMatch(shaped, /MORE=1/);
  } finally {
    for (const k of Object.keys(process.env)) if (k.startsWith("GIT_CONFIG_")) delete process.env[k];
  }
  assert.match(await ws.git("log"), /start/);
  await assert.rejects(ws.git("show", { ref: "--output=/tmp/x" }), WorkspaceError);
  await assert.rejects(ws.git("push"), /not available/);
});

test("unifiedDiff marks a missing final newline", () => {
  assert.equal(unifiedDiff("f", "a\nb", "a\nc"), "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n");
});

// ---- the delegate tool against a scripted node ----

type Script = (body: { messages: { role: string; content: unknown; tool_calls?: unknown[]; reasoning_content?: string }[]; tools?: unknown[]; tool_choice?: string; max_tokens: number }) => { status?: number; message?: Record<string, unknown>; costMsats?: number; delayMs?: number; usage?: { prompt_tokens: number; completion_tokens: number } };

let script: Script = () => ({ message: { content: "done" } });
const seen: Parameters<Script>[0][] = [];
let client: Client;
let mock: ReturnType<typeof createHttpServer>;

const toolCall = (id: string, name: string, args: object) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

before(async () => {
  fs.mkdirSync(home, { recursive: true });
  mock = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") {
      res.end(JSON.stringify({ data: [{ id: "worker", sats_pricing: { prompt: 0.0001, completion: 0.0002 } }] }));
    } else if (req.url === "/v1/balance/info") {
      res.end(JSON.stringify({ balance: 900_000, reserved: 0 }));
    } else if (req.url === "/v1/chat/completions") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      seen.push(body);
      const reply = script(body);
      if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      if (reply.status) {
        res.statusCode = reply.status;
        return res.end(JSON.stringify({ detail: "tools are not supported by this model" }));
      }
      res.setHeader("x-routstr-cost-msats", String(reply.costMsats ?? 2000));
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", ...reply.message }, finish_reason: "stop" }], usage: reply.usage ?? { prompt_tokens: 10, completion_tokens: 5 } }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  }).listen(0, "127.0.0.1");
  await once(mock, "listening");
  const node = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  process.env.ROUTSTR_MCP_HOME = home;
  process.env.ROUTSTR_NODES = node;
  process.env.ROUTSTR_WORKSPACE = project;
  fs.writeFileSync(path.join(home, "wallet.json"), JSON.stringify({ version: 1, keys: [{ node, key: KEY, addedAt: 0 }], pending: [] }), { mode: 0o600 });
  const { createServer } = await import("../src/server.js");
  client = new Client({ name: "agent-test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([createServer().connect(serverSide), client.connect(clientSide)]);
});

after(async () => {
  await (await import("../src/sandbox.js")).closeSandbox();
  await client?.close();
  mock?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function delegate(args: Record<string, unknown>, options: { signal?: AbortSignal; onprogress?: (p: { message?: string }) => void } = {}) {
  const result = (await client.callTool({ name: "delegate", arguments: args }, undefined, { ...options, timeout: 30_000 })) as { content: { text: string }[]; isError?: boolean };
  const text = result.content.map((c) => c.text).join("\n");
  assert.doesNotMatch(text, new RegExp(KEY), "the wallet key never reaches the agent");
  return { text, isError: !!result.isError };
}

test("a hostile node cannot read outside the project, and the run reports back", async () => {
  makeProject();
  seen.length = 0;
  script = (body) => {
    const step = body.messages.filter((m) => m.role === "assistant").length;
    if (step === 0)
      return { message: { content: null, reasoning_content: "let me look", tool_calls: [toolCall("1", "read", { path: path.join(os.homedir(), ".ssh", "id_rsa") }), toolCall("2", "read", { path: "../outside.txt" }), toolCall("3", "read", { path: ".env" })] } };
    if (step === 1) return { message: { content: "", tool_calls: [toolCall("4", "grep", { pattern: "return" }), toolCall("5", "edit", { path: "src/util.ts", old_string: "x + y", new_string: "y + x" })] } };
    return { message: { content: "Found add() in src/util.ts:2. Proposed swapping the operands." } };
  };
  const notes: string[] = [];
  const { text, isError } = await delegate({ task: "Look around", model: "worker" }, { onprogress: (p) => p.message && notes.push(p.message) });
  assert.equal(isError, false, text);
  const toolResults = seen.flatMap((b) => b.messages).filter((m) => m.role === "tool").map((m) => String(m.content));
  assert.ok(toolResults.some((r) => /outside the project/.test(r)));
  assert.ok(toolResults.some((r) => /secrets/.test(r)));
  assert.ok(!toolResults.some((r) => /do-not-send|outside\n/.test(r)), "no secret or outside file reached the node");
  assert.equal(seen[1]!.messages.find((m) => m.role === "assistant")?.reasoning_content, "let me look", "reasoning goes back with its tool calls");
  assert.match(text, /^## worker · done\nFound add\(\)/);
  assert.match(text, /Proposed changes \(not written/);
  assert.match(text, /-  return x \+ y;\n\+  return y \+ x;/);
  assert.equal(fs.readFileSync(path.join(project, "src", "util.ts"), "utf8").includes("y + x"), false);
  assert.match(text, /3 steps · 6 of 300 sats/);
  assert.ok(notes.some((n) => /step 1 · read .*failed/.test(n)) && notes.some((n) => /grep return/.test(n)), notes.join("\n"));

  // a follow-up continues the same conversation
  const session = text.match(/session ([0-9a-f]+)/)![1];
  script = (body) => ({ message: { content: `You said: ${String(body.messages.at(-1)!.content)}` } });
  const followUp = await delegate({ task: "and the tests?", session });
  assert.match(followUp.text, /You said: and the tests\?/);
  assert.ok(seen.at(-1)!.messages.length > 6, "the history was sent again");
});

test("the run stops at its budget and its step limit, and asks for a report first", async () => {
  makeProject();
  seen.length = 0;
  script = (body) => (body.tool_choice === "none" ? { message: { content: "Report: ran out." }, costMsats: 1000 } : { message: { content: null, tool_calls: [toolCall(`c${seen.length}`, "ls", {})] }, costMsats: 30_000 });
  const budget = await delegate({ task: "loop", model: "worker", max_sats: 100 });
  assert.match(budget.text, /## worker · stopped: budget used\nReport: ran out\./);
  assert.ok(seen.length <= 5, `${seen.length} calls`);
  assert.equal(seen.at(-1)!.tool_choice, "none");
  assert.match(String(seen.at(-1)!.messages.at(-1)!.content), /out of budget/);

  seen.length = 0;
  script = (body) => (body.tool_choice === "none" ? { message: { content: "Report after 2 steps." } } : { message: { content: null, tool_calls: [toolCall(`s${seen.length}`, "ls", {})] } });
  const steps = await delegate({ task: "loop", model: "worker", max_steps: 2 });
  assert.match(steps.text, /stopped: step limit\nReport after 2 steps\./);
  assert.equal(seen.length, 3);
});

test("a node that bills more than its listed price cannot push the run past its budget", async () => {
  makeProject();
  fs.writeFileSync(path.join(project, "big.txt"), `${"x".repeat(60)}\n`.repeat(600));
  seen.length = 0;
  // input billed at 8 times the listed 0.0001 sats a token, as a GLM-5.3 route did on 11-10
  script = (body) => {
    const usage = { prompt_tokens: Math.ceil(JSON.stringify(body).length / 3), completion_tokens: 50 };
    const costMsats = Math.round(1000 * (usage.prompt_tokens * 0.0008 + usage.completion_tokens * 0.0002));
    return body.tool_choice === "none"
      ? { message: { content: "Report: read big.txt." }, costMsats, usage }
      : { message: { content: null, tool_calls: [toolCall(`b${seen.length}`, "read", { path: "big.txt" })] }, costMsats, usage };
  };
  const { text } = await delegate({ task: "read big.txt again and again", model: "worker", max_sats: 100 });
  assert.ok(Number(text.match(/· ([\d.]+) of 100 sats/)![1]) <= 100, text);
  assert.match(text, /stopped: budget used\nReport: read big\.txt\./);
  assert.match(text, /billed about (7\.9|8\.0) times its listed price/);
});

test("several models at once only read, and edit access writes", async () => {
  makeProject();
  const parallel = await delegate({ task: "x", models: ["worker", "worker"], access: "edit" });
  assert.equal(parallel.isError, true);
  assert.match(parallel.text, /only work with read access/);
  script = (body) =>
    body.messages.some((m) => m.role === "tool")
      ? { message: { content: "Changed it." } }
      : { message: { content: null, tool_calls: [toolCall("w", "write", { path: "src/new.ts", content: "export const n = 1;\n" })] } };
  const edited = await delegate({ task: "add a file", model: "worker", access: "edit" });
  assert.match(edited.text, /Changed files \(written to disk\):\n- src\/new.ts \(new, \+1 -0\)/);
  assert.equal(fs.readFileSync(path.join(project, "src", "new.ts"), "utf8"), "export const n = 1;\n");
});

test("a model that refuses tools says so, and cancel stops the run", async () => {
  makeProject();
  script = () => ({ status: 400 });
  const refused = await delegate({ task: "x", model: "worker" });
  assert.match(refused.text, /may not support tool calling/);

  script = () => ({ message: { content: null, tool_calls: [toolCall(`k${seen.length}`, "ls", {})] }, delayMs: 300 });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 500);
  await assert.rejects(delegate({ task: "x", model: "worker" }, { signal: controller.signal }), /abort|cancel/i);
  const calls = seen.length;
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(seen.length <= calls + 1, "no new steps after cancel");
});

test("shell access runs commands in the sandbox only", async (t) => {
  const { sandboxProblem } = await import("../src/sandbox.js");
  const problem = await sandboxProblem();
  if (problem) return t.skip(problem);
  makeProject();
  script = (body) =>
    body.messages.some((m) => m.role === "tool")
      ? { message: { content: "Ran them." } }
      : {
          message: {
            content: null,
            tool_calls: [
              toolCall("b1", "bash", { command: "echo made > made.txt && cat made.txt" }),
              toolCall("b2", "bash", { command: "cat .env; cat ../outside.txt; echo x >> .git/config; curl -sS -m 3 https://example.com" }),
              toolCall("b3", "bash", { command: "env" }),
            ],
          },
        };
  process.env.ROUTSTR_TEST_SECRET = "leaky-env-value";
  const { text } = await delegate({ task: "run", model: "worker", access: "shell" });
  const results = seen.at(-1)!.messages.filter((m) => m.role === "tool").map((m) => String(m.content));
  assert.match(results[0]!, /^exit 0\nmade/);
  assert.doesNotMatch(results[1]!, /do-not-send|^outside/m);
  assert.doesNotMatch(results[2]!, /leaky-env-value|sk-agent/);
  assert.equal(fs.readFileSync(path.join(project, "made.txt"), "utf8"), "made\n");
  assert.doesNotMatch(fs.readFileSync(path.join(project, ".git", "config"), "utf8"), /^x$/m);
  assert.match(text, /Commands run:\n- `echo made > made.txt && cat made.txt` → exit 0/);
});
