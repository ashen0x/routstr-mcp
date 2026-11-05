# routstr-mcp

Give your AI agent every model sold on [Routstr](https://routstr.com), paid in sats.

routstr-mcp is an MCP server. Add it to Claude Code, Claude Desktop, Cursor or any other MCP app, and the agent gets four tools:

| Tool | What it does |
| --- | --- |
| `ask` | Ask one model and get its answer, with what it cost |
| `council` | Ask 2 to 5 models the same question at once, to compare answers |
| `find_models` | Search the models on approved Routstr nodes, cheapest first, with prices in sats |
| `balance` | Sats left, per node |

Use it for a second opinion from a different model, to compare several models, or to hand a simple job to a cheap one. There is no account and no card: you prepay a few sats over Lightning, and that prepaid balance is the most the agent can ever spend.

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
- **Each call has its own cap.** The agent can pass `max_sats` (default 100, at most 500). The answer length is set so the call fits under it, and the cost is shown after every answer.
- **The agent never sees a secret.** API keys, invoices and Cashu tokens stay in the wallet file and the terminal. Funding and refunds are terminal commands only, so a prompt injection cannot pull your sats out.
- **The wallet is private.** It lives in `~/.routstr-mcp/wallet.json`, readable only by you. A refund token is also saved in `~/.routstr-mcp/refunds/` before the key is dropped, so a crash cannot lose it.
- **A stopped payment is not lost.** If you pay after closing the `fund` command, the sats are picked up the next time the wallet is used.

## Which nodes it uses

Nodes announce themselves on Nostr. routstr-mcp uses the same rule as the Routstr SDK: a node is used only when the Routstr curator's latest review of it is positive (`trusted`, `verified`, `lgtm`) and no review is negative. Only public HTTPS addresses are used, never a local network, localhost or onion address. If a node is down, `ask` moves to the next node where you have sats.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `ROUTSTR_NODES` | found on Nostr | Comma separated node URLs to use instead of discovery |
| `ROUTSTR_SATS_PER_CALL` | `100` | What one call may cost when the agent does not say |
| `ROUTSTR_MAX_SATS_PER_CALL` | `500` | The most one call may cost, whatever the agent asks |
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
