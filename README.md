# routstr-mcp

Give your AI agent every model sold on [Routstr](https://routstr.com), paid in sats.

routstr-mcp is an MCP server. Add it to Claude Code, Codex, Cursor, Claude Desktop or any other MCP app, and the agent gets these tools:

| Tool | What it does |
| --- | --- |
| `ask` | Ask one model and get its answer and a structured cost receipt |
| `council` | Ask 2 to 5 models the same question and get a cost receipt for each answer |
| `delegate` | Hand a whole task to another model, which works in your project on its own with file tools |
| `quote` | Estimate the cost and output limit for an exact prompt without calling a model |
| `find_models` | Search the models on approved Routstr nodes, cheapest first, with prices in sats |
| `balance` | Sats left, per node, and what was spent today |

Use it to put the right model on each job: a second opinion from a different model, several models compared side by side, or a review or a self-contained change handed to a cheaper one such as Kimi, GLM, DeepSeek or Qwen. There is no account and no card: you prepay a few sats over Lightning, and that prepaid balance is the most the agent can ever spend.

### ask, council and quote

Pass `files` (project paths) to send files along with the prompt, and `images` (project paths or https URLs) for a model that takes images. `find_models` with `vision: true` lists those. Secret files such as `.env` and keys are refused, and key-shaped strings in a file are removed before it leaves your machine.

Call `quote` with the same `model`, `prompt`, optional `system`, and `max_sats` you plan to pass to `ask`. It returns the selected model and node, advertised rates, and the estimated cost of the initial request. Pass the returned `model` and `node` to `ask` to keep the request on that node. The quote uses catalog prices, and the node can select its own upstream route and settle a different amount.

`ask` returns its receipt in `structuredContent.receipt`. It includes the estimate, output limit, and node charge when available. The receipt also records the request ID, upstream provider, token counts (including reasoning and cache counts), and finish reason when reported. `costSource` distinguishes node-reported charges, estimates based on token usage, and unavailable costs. `overTarget` flags a reported charge above the requested target, and `extraFees` flags a model whose node also bills web search or reasoning.

For reasoning models, pass `reasoning_effort` (for example `"low"`) to request less thinking. The serving route determines which efforts it supports.

### delegate

`delegate` runs a subagent: the model you name gets the task and tools to list, read, glob and grep files and to look at git (status, diff, log, show), and works through it step by step until it reports back. You get its report, the files it changed as a diff, the commands it ran and the cost.

- **`access: "read"`** (the default) only looks. When the model edits a file, the change is kept as a proposal and comes back as a patch you can apply with `git apply`. Up to 3 `models` can do the same task at once, to compare their work.
- **`access: "edit"`** also writes files in the project.
- **`access: "shell"`** also runs commands, such as tests, in a sandbox with no network. Reads stay inside the project, system folders and your toolchains; writes stay inside the project, and `.git`, git hooks and shell settings stay read-only, so a command cannot plant code that runs later. It uses [sandbox-runtime](https://github.com/anthropics/sandbox-runtime): macOS needs nothing extra, Linux needs `bubblewrap`, `socat` and `ripgrep`.

Use edit or shell on a clean git tree, so you can see and undo every change. The subagent works in the folders your MCP app has open, else `ROUTSTR_WORKSPACE`, else the folder the app started the server in; `cwd` narrows it to a subfolder. It never reads secret files or folders (`.env`, keys, `.git` internals, `~/.ssh`, wallets).

`max_sats` is the budget for the whole run (default 300, at most 2000) and `max_steps` the most model calls (default 30). Each step is paid as it goes, and the model is told to wrap up when the budget runs low. The report ends with a session id: pass it as `session` with a follow-up `task` within 30 minutes to continue the same run. Long runs send progress notes, and cancelling the tool call stops the run.

## Set up

1. Add it to your MCP app. For Claude Code:

   ```sh
   claude mcp add routstr -- npx -y routstr-mcp
   ```

   For Codex, in `~/.codex/config.toml` (a longer tool timeout lets `delegate` finish):

   ```toml
   [mcp_servers.routstr]
   command = "npx"
   args = ["-y", "routstr-mcp"]
   tool_timeout_sec = 900
   ```

   For Cursor (`.cursor/mcp.json`), Claude Desktop and other apps:

   ```json
   { "mcpServers": { "routstr": { "command": "npx", "args": ["-y", "routstr-mcp"] } } }
   ```

   In Claude Code, `MCP_TOOL_TIMEOUT=900000` gives long `delegate` runs room too.

2. Add sats. In a terminal:

   ```sh
   npx routstr-mcp fund 2000
   ```

   It shows a Lightning invoice as a QR code. Pay it from any Lightning wallet and you are done. To fund the node that sells a model cheapest, add `--model <id>`.

3. Ask your agent something like "ask gpt-5 for a second opinion on this function", "run a council of three models on this question" or "delegate a security review of src/ to kimi".

## Commands

```
routstr-mcp                         start the MCP server (what your MCP app runs)
routstr-mcp fund <sats>             pay a Lightning invoice to add sats
    --model <id>                    on the cheapest node that sells this model
    --node <url>                    on this node
routstr-mcp balance                 sats left, per node
routstr-mcp refund                  take all unspent sats back as a Cashu token
    --to <lightning address>        or send them to a Lightning address
    --node <url>                    only from this node
routstr-mcp spend                   what calls cost: today, per day and per model
    --days <n>                      look back this many days (default 7)
routstr-mcp nodes                   approved nodes and how many models each sells
routstr-mcp import --node <url>     add a Routstr key you already have (read from stdin)
```

## How your sats stay safe

- **The prepaid balance is a hard cap.** Your sats sit on the node as the balance of a Routstr API key. Nothing can spend more than you paid in.
- **Each call has a spend target.** The agent can pass `max_sats` (default 100, at most 500). This sizes the output token limit using the catalog estimate. The node settles the charge, which can exceed the target. A `delegate` run has a budget for all its steps.
- **You can set a daily limit.** With `ROUTSTR_DAILY_SATS`, calls stop for the day once that much is spent. Every paid call is logged to `~/.routstr-mcp/spend.jsonl`; `routstr-mcp spend` sums it up.
- **The agent never sees a secret.** API keys, invoices and Cashu tokens stay in the wallet file and the terminal, and are removed from anything a node sends back. There is no tool that funds or refunds, so the MCP tools alone cannot move your sats. An agent that also has a shell (Claude Code, Cursor) could still run the CLI or read the wallet file, so keep your app asking before it runs commands. A `delegate` subagent cannot reach the wallet: it is outside the project, and the shell sandbox blocks the home folder.
- **The wallet is private.** It lives in `~/.routstr-mcp/wallet.json`, readable only by you. A refund token is also saved in `~/.routstr-mcp/refunds/` before the key is dropped, so a crash cannot lose it.
- **A stopped payment is not lost.** If you pay after closing the `fund` command, the sats are picked up the next time the wallet is used.

## Which nodes it uses

Nodes announce themselves on Nostr. routstr-mcp uses the same rule as the Routstr SDK: a node is used only when the Routstr curator's latest review of it is positive (`trusted`, `verified`, `lgtm`) and no review is negative. Only public HTTPS addresses are used, never a local network, localhost or onion address. If a node is down, out of sats for you or cannot serve the model right now, a call moves to the next node where you have sats. It never moves on once a node may have charged for the call.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `ROUTSTR_NODES` | found on Nostr | Comma separated node URLs to use instead of discovery |
| `ROUTSTR_SATS_PER_CALL` | `100` | Default spend target in sats |
| `ROUTSTR_MAX_SATS_PER_CALL` | `500` | Maximum spend target the agent can request |
| `ROUTSTR_SATS_PER_TASK` | `300` | Default budget for one `delegate` run |
| `ROUTSTR_MAX_SATS_PER_TASK` | `2000` | Maximum budget the agent can give one `delegate` run |
| `ROUTSTR_DAILY_SATS` | none | Most that all calls together may spend in a day |
| `ROUTSTR_WORKSPACE` | the open folder | Comma separated project folders for `files` and `delegate`, when the app does not say which folder is open |
| `ROUTSTR_RELAYS` | damus, nos.lol, relay.routstr.com | Nostr relays for discovery |
| `ROUTSTR_CURATOR` | the Routstr curator | Pubkey whose reviews approve nodes |
| `ROUTSTR_MCP_HOME` | `~/.routstr-mcp` | Where the wallet lives |

## Development

Node 22 or newer.

```sh
npm install
npm test          # logic tests
```

The end to end tests run a real stack on your machine: two routstr-core nodes, a real Cashu mint (nutshell, with fake Lightning so invoices pay at once) and a fake AI. They need [uv](https://docs.astral.sh/uv/), Python 3.12 and a routstr-core checkout with its venv:

```sh
git clone https://github.com/Routstr/routstr-core && (cd routstr-core && uv sync --frozen --no-dev --python 3.12)
KIT_CORE_DIR=$PWD/routstr-core npm run test:e2e
```

Set `E2E_PYTHON` if your Python 3.12 is not at `/usr/bin/python3.12`.

## License

MIT
