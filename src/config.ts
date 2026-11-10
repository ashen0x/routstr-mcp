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
const maxSatsPerTask = number(process.env.ROUTSTR_MAX_SATS_PER_TASK, 2000);

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
  /** Default spend target used to size a call. */
  defaultSatsPerCall: Math.min(number(process.env.ROUTSTR_SATS_PER_CALL, 100), maxSatsPerCall),
  /** Largest spend target the agent may request. */
  maxSatsPerCall,
  /** What one subagent run may cost when the agent does not say. */
  defaultSatsPerTask: Math.min(number(process.env.ROUTSTR_SATS_PER_TASK, 300), maxSatsPerTask),
  /** The most one subagent run may ever cost. */
  maxSatsPerTask,
  /** The most all calls together may cost in one day; unset means no daily limit beyond the prepaid balance. */
  dailySats: number(process.env.ROUTSTR_DAILY_SATS, 0) || undefined,
  /** Folders a subagent and file attachments may read, when the MCP app does not say which folder is open. */
  workspace: list(process.env.ROUTSTR_WORKSPACE),
};
