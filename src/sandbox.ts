import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";

type Manager = typeof import("@anthropic-ai/sandbox-runtime").SandboxManager;

/** Folders under home that toolchains run from; readable so `npm test` or `cargo test` work, never written. */
const TOOLCHAINS = [".nvm", ".volta", ".fnm", ".bun", ".deno", ".cargo", ".rustup", ".pyenv", ".rbenv", ".local/bin", ".local/share/mise", ".local/share/pnpm", ".asdf", ".sdkman", "go", ".npm", ".cache/pip", ".cache/uv", ".gradle", ".m2"];
/** Secret files that may sit inside a project; the read tool refuses them, and the shell may not read them either. */
const PROJECT_SECRETS = ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/id_rsa*", "**/id_ed25519*", "**/.npmrc", "**/.netrc", "**/.git-credentials", "**/*.tfstate", "**/credentials", "**/credentials.*", "**/secrets.*"];
/** Environment the command gets: nothing from the user's shell that could hold a token. */
const PASSED_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "NVM_DIR", "NVM_BIN", "VOLTA_HOME", "PNPM_HOME", "CARGO_HOME", "RUSTUP_HOME", "GOPATH", "GOROOT", "PYENV_ROOT", "JAVA_HOME"];

const MAX_OUTPUT = 30_000;

let manager: Promise<Manager | string> | undefined;
let initializedFor = "";
let scratchRoot: string | undefined;

/** The sandbox library, or why there is none here. */
async function loadManager(): Promise<Manager | string> {
  let SandboxManager: Manager;
  try {
    ({ SandboxManager } = await import("@anthropic-ai/sandbox-runtime"));
  } catch {
    return "the sandbox library (@anthropic-ai/sandbox-runtime) is not installed";
  }
  if (!SandboxManager.isSupportedPlatform()) return `there is no sandbox for ${process.platform}`;
  const deps = await SandboxManager.checkDependenciesAsync();
  if (deps.errors.length) return `the sandbox cannot start: ${deps.errors.join("; ")}`;
  return SandboxManager;
}

export interface ShellResult {
  code: number;
  output: string;
  timedOut: boolean;
}

let setupQueue: Promise<unknown> = Promise.resolve();

/** Sets the sandbox up for these folders and wraps the command; returns the command line and its temp folder. */
async function prepare(loaded: Manager, command: string, roots: string[], cwd: string, signal?: AbortSignal) {
  const home = os.homedir();
  // one project folder is writable per command: the one it runs in
  const writeRoot = roots.find((r) => cwd === r || cwd.startsWith(r + path.sep)) ?? roots[0]!;
  const wanted = JSON.stringify({ roots, writeRoot });
  if (initializedFor !== wanted) {
    if (initializedFor) await loaded.reset();
    scratchRoot ??= fs.mkdtempSync(path.join(os.tmpdir(), "routstr-shell-"));
    const gitDir = path.join(writeRoot, ".git");
    await loaded.initialize({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: {
        // home and temp hold other programs' secrets; the project, toolchains and our own scratch are let back in
        denyRead: [home, os.tmpdir(), config.home, ...roots.flatMap((root) => PROJECT_SECRETS.map((p) => path.join(root, p)))],
        allowRead: [...roots, scratchRoot, ...TOOLCHAINS.map((dir) => path.join(home, dir)).filter((dir) => fs.existsSync(dir))],
        allowWrite: [writeRoot, scratchRoot],
        // git history, the index and stashes stay as the user left them
        denyWrite: [config.home, ...(fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory() ? [gitDir] : [])],
      },
    });
    initializedFor = wanted;
  }
  const scratch = fs.mkdtempSync(path.join(scratchRoot!, "run-"));
  // the library hands the command this temp folder (else a shared /tmp/claude)
  // and protects shell and git settings (rc files, hooks, .vscode and the like) below the folder this process is in
  const before = process.env.CLAUDE_CODE_TMPDIR;
  const startedIn = process.cwd();
  process.env.CLAUDE_CODE_TMPDIR = scratch;
  try {
    process.chdir(writeRoot);
    return { wrapped: await loaded.wrapWithSandbox(command, "/bin/bash", undefined, signal), scratch };
  } catch (e) {
    fs.rmSync(scratch, { recursive: true, force: true });
    throw e;
  } finally {
    process.chdir(startedIn);
    if (before === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
    else process.env.CLAUDE_CODE_TMPDIR = before;
  }
}

/**
 * Runs a command with no network, reads limited to the project, system folders and toolchains,
 * and writes limited to the project and a private temp folder. Git hooks and config, shell rc files and
 * similar stay unwritable (the library protects them), so a command cannot plant code that runs later
 * outside the sandbox.
 */
export async function runInSandbox(command: string, roots: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ShellResult> {
  const loaded = await (manager ??= loadManager());
  if (typeof loaded === "string") throw new SandboxUnavailable(loaded);
  // setting up changes this process's folder and environment for a moment, so two runs never set up at once
  const turn = setupQueue.then(() => prepare(loaded, command, roots, cwd, signal));
  setupQueue = turn.catch(() => undefined);
  const { wrapped, scratch } = await turn;
  try {
    const env: NodeJS.ProcessEnv = { CI: "1", NO_COLOR: "1" };
    for (const name of PASSED_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];
    return await new Promise<ShellResult>((resolve, reject) => {
      const child = spawn("/bin/bash", ["-c", wrapped], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      let output = "";
      let timedOut = false;
      const add = (chunk: Buffer) => {
        if (output.length < MAX_OUTPUT * 2) output += chunk.toString("utf8");
      };
      child.stdout.on("data", add);
      child.stderr.on("data", add);
      const kill = () => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          /* gone */
        }
      };
      const timer = setTimeout(() => ((timedOut = true), kill()), timeoutMs);
      signal?.addEventListener("abort", kill, { once: true });
      child.once("error", (e) => (clearTimeout(timer), reject(e)));
      child.once("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", kill);
        const annotated = loaded.annotateStderrWithSandboxFailures(command, output);
        resolve({ code: code ?? -1, output: annotated, timedOut });
      });
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
    try {
      loaded.cleanupAfterCommand();
    } catch {
      /* best effort */
    }
  }
}

export class SandboxUnavailable extends Error {}

/** Stops the sandbox's proxies, so a process that is done can exit. */
export async function closeSandbox(): Promise<void> {
  const loaded = manager && (await manager);
  if (loaded && typeof loaded !== "string" && initializedFor) await loaded.reset();
  initializedFor = "";
}

/** Whether shell access can work here, without starting anything. */
export async function sandboxProblem(): Promise<string | undefined> {
  const loaded = await (manager ??= loadManager());
  return typeof loaded === "string" ? loaded : undefined;
}

export const clipOutput = (text: string) =>
  text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT / 2)}\n[… ${text.length - MAX_OUTPUT} characters cut …]\n${text.slice(-MAX_OUTPUT / 2)}` : text;
