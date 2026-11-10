# routstr-mcp

Give your AI agent every model sold on [Routstr](https://routstr.com), paid in sats.

routstr-mcp is an MCP server. Add it to Claude Code, Claude Desktop, Cursor or any other MCP app, and the agent gets these tools:

| Tool | What it does |
| --- | --- |
| `quote` | Estimate the cost and output limit for an exact prompt without calling a model |
| `ask` | Ask one model and get its answer and a structured cost receipt |
| `council` | Ask 2 to 5 models the same question and get a cost receipt for each answer |
| `find_models` | Search the models on approved Routstr nodes, cheapest first, with prices in sats |
| `balance` | Sats left, per node |

Use it for a second opinion from a different model, to compare several models, or to hand a simple job to a cheap one. There is no account and no card: you prepay a few sats over Lightning, and that prepaid balance is the most the agent can ever spend.

Call `quote` with the same `model`, `prompt`, optional `system`, and `max_sats` you plan to pass to `ask`. It returns the selected model and node, advertised rates, and the estimated cost of the initial request. Pass the returned `model` and `node` to `ask` to keep the request on that node. A quote can also help pick a node before funding. The quote uses catalog prices, and the node can select its own upstream route and settle a different amount.

`ask` returns its receipt in `structuredContent.receipt`. It includes the estimate, output limit, and node charge when available. The receipt also records the request ID, upstream provider, token counts (including reasoning and cache counts), and finish reason when reported. `costSource` distinguishes node-reported charges, estimates based on token usage, and unavailable costs. `overTarget` flags a reported charge above the requested target.

For reasoning models, pass `reasoning_effort` (for example `"low"`) to request less thinking. The serving route determines which efforts it supports. The quote and receipt record the requested effort.

## Set up

1. Add it to your MCP app. For Claude Code:

   ```sh
   claude mcp add routstr -- npx -y routstr-mcp
   ```

   For other apps, add this to their MCP config:

   ```json
   { "mcpServers": { "routstr": { "command": "npx", "args": ["-y", "routstr-mcp"] } } }
   ```

2. Add sats. In a terminal:

   ```sh
   npx routstr-mcp fund 2000
   ```

   It shows a Lightning invoice as a QR code. Pay it from any Lightning wallet and you are done. To fund the node that sells a model cheapest, add `--model <id>`.

3. Ask your agent something like "ask gpt-5 for a second opinion on this function" or "run a council of three models on this question".

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
routstr-mcp nodes                   approved nodes and how many models each sells
routstr-mcp import --node <url>     add a Routstr key you already have (read from stdin)
```

## How your sats stay safe

- **The prepaid balance is a hard cap.** Your sats sit on the node as the balance of a Routstr API key. Nothing can spend more than you paid in.
- **Each call has a spend target.** The agent can pass `max_sats` (default 100, at most 500). This sizes the output token limit using the catalog estimate. The node settles the charge, which can exceed the target.
- **The agent never sees a secret.** API keys, invoices and Cashu tokens stay in the wallet file and the terminal, and are removed from anything a node sends back. There is no tool that funds or refunds, so the MCP tools alone cannot move your sats. An agent that also has a shell (Claude Code, Cursor) could still run the CLI or read the wallet file, so keep your app asking before it runs commands.
- **The wallet is private.** It lives in `~/.routstr-mcp/wallet.json`, readable only by you. A refund token is also saved in `~/.routstr-mcp/refunds/` before the key is dropped, so a crash cannot lose it.
- **A stopped payment is not lost.** If you pay after closing the `fund` command, the sats are picked up the next time the wallet is used.

## Which nodes it uses

Nodes announce themselves on Nostr. routstr-mcp uses the same rule as the Routstr SDK: a node is used only when the Routstr curator's latest review of it is positive (`trusted`, `verified`, `lgtm`) and no review is negative. Only public HTTPS addresses are used, never a local network, localhost or onion address. If a node is down, `ask` moves to the next node where you have sats.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `ROUTSTR_NODES` | found on Nostr | Comma separated node URLs to use instead of discovery |
| `ROUTSTR_SATS_PER_CALL` | `100` | Default spend target in sats |
| `ROUTSTR_MAX_SATS_PER_CALL` | `500` | Maximum spend target the agent can request |
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
