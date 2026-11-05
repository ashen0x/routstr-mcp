import os from "node:os";
import path from "node:path";

const list = (value: string | undefined): string[] | undefined => {
  const items = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items?.length ? items : undefined;
};

const number = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const maxSatsPerCall = number(process.env.ROUTSTR_MAX_SATS_PER_CALL, 500);

export const config = {
  home: process.env.ROUTSTR_MCP_HOME ?? path.join(os.homedir(), ".routstr-mcp"),
  /** Skip Nostr discovery and use these node URLs only. */
  nodes: list(process.env.ROUTSTR_NODES),
  relays: list(process.env.ROUTSTR_RELAYS) ?? [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.routstr.com",
  ],
  /** The pubkey whose kind 38425 reviews approve nodes, the same one the Routstr SDK trusts. */
  curator:
    process.env.ROUTSTR_CURATOR ??
    "4ad6fa2d16e2a9b576c863b4cf7404a70d4dc320c0c447d10ad6ff58993eacc8",
  /** What one call may cost when the agent does not say. */
  defaultSatsPerCall: Math.min(number(process.env.ROUTSTR_SATS_PER_CALL, 100), maxSatsPerCall),
  /** The most one call may ever cost, whatever the agent asks for. */
  maxSatsPerCall,
};
