import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Raised for anything the model asked for that it may not have; the text goes back to the model. */
export class WorkspaceError extends Error {}

/** Folders that hold credentials or another tool's state: never listed, searched or read. */
const SECRET_DIRS = new Set([".git", ".ssh", ".gnupg", ".aws", ".azure", ".gcloud", ".kube", ".docker", ".routstr-mcp", ".routstrd", ".cocod", ".password-store"]);
const SECRET_FILES = [
  /^\.env(\..+)?$/,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|tfstate|tfvars)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)/,
  /^\.(npmrc|pypirc|netrc|git-credentials|pgpass|htpasswd)$/,
  /^(credentials|secrets?)(\..+)?$/,
  /^service-account.*\.json$/,
  /^wallet\.json$/,
];
const SAFE_EXAMPLES = /^\.env\.(example|sample|template|dist)$/;
/** Big generated folders: skipped when listing and searching, still readable by path. */
const NOISE_DIRS = new Set(["node_modules", "dist", "build", "out", "target", ".venv", "venv", "__pycache__", ".next", ".nuxt", ".cache", "coverage", ".turbo", ".gradle", ".terraform", ".pytest_cache", ".mypy_cache"]);

export function isSecretPath(relative: string): boolean {
  const parts = relative.split(/[\\/]+/).filter(Boolean).map((p) => p.toLowerCase());
  if (parts.some((p) => SECRET_DIRS.has(p))) return true;
  const name = parts.at(-1) ?? "";
  return !SAFE_EXAMPLES.test(name) && SECRET_FILES.some((re) => re.test(name));
}

/**
 * Key-shaped strings are removed before file text goes to a model on a node: a security review still sees
 * that a secret sits on that line, without the node getting it.
 */
const SECRET_TEXT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bcashu[AB][A-Za-z0-9_\-+/=]{40,}/g,
  /\bln(bc|tb|bcrt|tbs)[0-9]*[munp]?1[02-9ac-hj-np-z]{50,}/gi,
  /\bnsec1[02-9ac-hj-np-z]{58}\b/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\b(sk|rk)_live_[A-Za-z0-9]{20,}\b/g,
];

export function scrub(text: string): string {
  return SECRET_TEXT.reduce((out, re) => out.replace(re, "[secret removed]"), text);
}

const MAX_READ_CHARS = 40_000;
const MAX_READ_LINES = 600;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_OUTPUT = 30_000;

const clip = (text: string, limit = MAX_TOOL_OUTPUT) =>
  text.length > limit ? `${text.slice(0, limit)}\n[cut at ${limit} characters]` : text;

function run(cmd: string, args: string[], cwd: string, timeoutMs = 20_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", RIPGREP_CONFIG_PATH: "" },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as NodeJS.ErrnoException).code === "number" ? Number((error as NodeJS.ErrnoException).code) : -1) : 0;
        resolve({ code, out: String(stdout), err: String(stderr) || (error && code === -1 ? error.message : "") });
      }
    );
  });
}

let ripgrep: Promise<boolean> | undefined;
const hasRipgrep = () => (ripgrep ??= run("rg", ["--version"], os.tmpdir(), 5000).then((r) => r.code === 0));

/** A project folder must be a real folder, and not the whole disk or the home folder. */
export function usableRoot(dir: string): string | undefined {
  try {
    const real = fs.realpathSync(dir);
    if (!fs.statSync(real).isDirectory()) return undefined;
    if (real === path.parse(real).root || real === fs.realpathSync(os.homedir())) return undefined;
    return real;
  } catch {
    return undefined;
  }
}

export type Access = "read" | "edit" | "shell";

/**
 * The project folders a model on a node may use. Every path is resolved through symlinks and must stay
 * inside a root; secret files are refused even inside. With read access, edits are kept in memory and
 * handed back as a patch; with edit or shell access they are written, and the patch shows what changed.
 */
export class Workspace {
  /** files the model changed, by absolute path, with what they held before (null: did not exist) */
  private changed = new Map<string, { before: string | null; after: string }>();
  readonly opened = new Set<string>();

  constructor(readonly roots: string[], readonly access: Access = "read") {
    if (!roots.length) throw new WorkspaceError("No project folder is open.");
  }

  get writes() {
    return this.access !== "read";
  }

  /** Absolute path inside a root, or an error the model can act on. */
  resolve(input: string, { mayNotExist = false } = {}): string {
    const raw = (input || ".").trim();
    const base = this.roots[0]!;
    const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base, raw);
    let real: string;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      if (!mayNotExist) throw new WorkspaceError(`${raw} does not exist.`);
      // a new file: the nearest folder that exists decides where it really lands
      let existing = path.dirname(candidate);
      const rest = [path.basename(candidate)];
      while (!fs.existsSync(existing) && existing !== path.dirname(existing)) {
        rest.unshift(path.basename(existing));
        existing = path.dirname(existing);
      }
      real = path.join(fs.realpathSync(existing), ...rest);
    }
    const root = this.roots.find((r) => real === r || real.startsWith(r + path.sep));
    if (!root) throw new WorkspaceError(`${raw} is outside the project folder.`);
    if (isSecretPath(path.relative(root, real))) throw new WorkspaceError(`${raw} may hold secrets, so it is not shared.`);
    return real;
  }

  /** How a path is shown to the model: relative to its root, with the root's name when there are several. */
  show(abs: string): string {
    const root = this.rootOf(abs);
    const rel = path.relative(root, abs).split(path.sep).join("/") || ".";
    return this.roots.length > 1 ? `${path.basename(root)}/${rel}` : rel;
  }

  private rootOf(abs: string) {
    return this.roots.find((r) => abs === r || abs.startsWith(r + path.sep)) ?? this.roots[0]!;
  }

  /** The file as the model last left it. */
  private content(abs: string): string | null {
    const edit = this.changed.get(abs);
    if (edit && !this.writes) return edit.after;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return null;
    }
    if (!stat.isFile()) throw new WorkspaceError(`${this.show(abs)} is not a file.`);
    if (stat.size > MAX_FILE_BYTES) throw new WorkspaceError(`${this.show(abs)} is ${Math.round(stat.size / 1024)} KB, too big to read; search it instead.`);
    const data = fs.readFileSync(abs);
    if (data.subarray(0, 8000).includes(0)) throw new WorkspaceError(`${this.show(abs)} is a binary file.`);
    return data.toString("utf8");
  }

  read(input: string, offset = 1, limit = MAX_READ_LINES): string {
    const abs = this.resolve(input);
    if (fs.statSync(abs).isDirectory()) throw new WorkspaceError(`${input} is a folder; use ls.`);
    const text = this.content(abs);
    if (text === null) throw new WorkspaceError(`${input} does not exist.`);
    this.opened.add(this.show(abs));
    const lines = text.split("\n");
    const from = Math.max(1, Math.floor(offset));
    let to = Math.min(lines.length, from + Math.min(Math.max(1, Math.floor(limit)), MAX_READ_LINES) - 1);
    let out = "";
    for (let n = from; n <= to; n++) {
      const line = `${n}\t${lines[n - 1]}\n`;
      if (out.length + line.length > MAX_READ_CHARS) {
        to = n - 1;
        break;
      }
      out += line;
    }
    const note = this.changed.has(abs) && !this.writes ? " (with your proposed edits)" : "";
    const more = to < lines.length ? `\n[lines ${from}-${to} of ${lines.length}; read on with offset ${to + 1}]` : "";
    return `${this.show(abs)}${note}, lines ${from}-${to} of ${lines.length}:\n${scrub(out)}${more}`;
  }

  /** The whole file for an attachment, refusing what read would refuse. */
  attach(input: string): { name: string; text: string } {
    const abs = this.resolve(input);
    const text = this.content(abs);
    if (text === null) throw new WorkspaceError(`${input} does not exist.`);
    if (text.length > 200_000) throw new WorkspaceError(`${input} is too long to attach (${text.length} characters); attach a smaller file or pass the part that matters in the prompt.`);
    return { name: this.show(abs), text: scrub(text) };
  }

  /** An image for a vision model, as a data URL. */
  image(input: string): string {
    const abs = this.resolve(input);
    const type = IMAGE_TYPES[path.extname(abs).toLowerCase()];
    if (!type) throw new WorkspaceError(`${input} is not a PNG, JPEG, GIF or WebP image.`);
    const size = fs.statSync(abs).size;
    if (size > MAX_IMAGE_BYTES) throw new WorkspaceError(`${input} is ${Math.round(size / 1024)} KB; images up to ${MAX_IMAGE_BYTES >> 10} KB are sent. Make it smaller first.`);
    return `data:${type};base64,${fs.readFileSync(abs).toString("base64")}`;
  }

  ls(input = ".", depth = 2): string {
    const start = this.resolve(input);
    if (!fs.statSync(start).isDirectory()) throw new WorkspaceError(`${input} is a file; use read.`);
    const root = this.rootOf(start);
    const lines: string[] = [];
    const LIMIT = 400;
    const walk = (dir: string, level: number, indent: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (lines.length >= LIMIT) return;
        const abs = path.join(dir, entry.name);
        if (isSecretPath(path.relative(root, abs))) continue;
        if (entry.isDirectory()) {
          if (NOISE_DIRS.has(entry.name)) {
            lines.push(`${indent}${entry.name}/ (skipped)`);
            continue;
          }
          lines.push(`${indent}${entry.name}/`);
          if (level < Math.min(depth, 6)) walk(abs, level + 1, indent + "  ");
        } else if (entry.isFile()) {
          let size = "";
          try {
            size = ` ${Math.max(1, Math.round(fs.statSync(abs).size / 1024))} KB`;
          } catch {
            /* gone */
          }
          lines.push(`${indent}${entry.name}${size}`);
        } else if (entry.isSymbolicLink()) lines.push(`${indent}${entry.name} (link)`);
      }
    };
    walk(start, 1, "");
    if (lines.length >= LIMIT) lines.push(`[stopped at ${LIMIT} entries; list a subfolder]`);
    return `${this.show(start)}/\n${lines.join("\n") || "(empty)"}`;
  }

  /** Files whose path matches a glob such as "src/**\/*.ts", skipping generated folders. */
  async glob(pattern: string, input = "."): Promise<string> {
    if (!pattern) throw new WorkspaceError("Give a glob pattern, such as **/*.ts.");
    const start = this.resolve(input);
    const root = this.rootOf(start);
    const matcher = globRegex(pattern);
    const found: string[] = [];
    const walk = (dir: string) => {
      if (found.length >= 500) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        const rel = path.relative(start, abs).split(path.sep).join("/");
        if (isSecretPath(path.relative(root, abs))) continue;
        if (entry.isDirectory()) {
          if (!NOISE_DIRS.has(entry.name)) walk(abs);
        } else if (entry.isFile() && matcher.test(rel)) found.push(this.show(abs));
        if (found.length >= 500) return;
      }
    };
    walk(start);
    if (!found.length) return `No files match ${pattern} in ${this.show(start)}.`;
    return clip(found.sort().join("\n") + (found.length >= 500 ? "\n[stopped at 500 files; narrow the pattern]" : ""));
  }

  async grep(pattern: string, opts: { path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean } = {}): Promise<string> {
    if (!pattern) throw new WorkspaceError("Give a pattern to search for.");
    const start = this.resolve(opts.path ?? ".");
    const root = this.rootOf(start);
    const cwd = fs.statSync(start).isDirectory() ? start : path.dirname(start);
    const target = path.relative(cwd, start) || ".";
    let raw: string;
    if (await hasRipgrep()) {
      const args = ["--line-number", "--no-heading", "--color", "never", "--hidden", "--max-count", "20", "--max-columns", "300", "--max-columns-preview", "--max-filesize", "1M", "--glob", "!.git/"];
      for (const dir of NOISE_DIRS) args.push("--glob", `!${dir}/`);
      if (opts.glob) args.push("--glob", opts.glob);
      if (opts.ignoreCase) args.push("--ignore-case");
      if (opts.literal) args.push("--fixed-strings");
      args.push("--regexp", pattern, "--", target);
      const r = await run("rg", args, cwd);
      if (r.code > 1 || r.code < 0) throw new WorkspaceError(`grep failed: ${r.err.trim().slice(0, 300)}`);
      raw = r.out;
    } else {
      raw = this.searchPlain(pattern, start, cwd, opts);
    }
    const hits = raw
      .split("\n")
      .filter(Boolean)
      .filter((line) => {
        const file = line.slice(0, line.indexOf(":"));
        return !isSecretPath(path.relative(root, path.resolve(cwd, file)));
      })
      .map((line) => {
        const at = line.indexOf(":");
        return `${this.show(path.resolve(cwd, line.slice(0, at)))}${line.slice(at)}`;
      });
    if (!hits.length) return `No matches for ${JSON.stringify(pattern)} in ${this.show(start)}.`;
    const shown = hits.slice(0, 150);
    return scrub(clip(`${shown.join("\n")}${hits.length > shown.length ? `\n[${hits.length - shown.length} more matches; narrow the search]` : ""}`));
  }

  /** Without ripgrep: a plain-text search, since a model's regular expression could hang this process. */
  private searchPlain(pattern: string, start: string, cwd: string, opts: { glob?: string; ignoreCase?: boolean }): string {
    const needle = opts.ignoreCase ? pattern.toLowerCase() : pattern;
    const matcher = opts.glob ? globRegex(opts.glob.includes("/") ? opts.glob : `**/${opts.glob}`) : undefined;
    const out: string[] = [];
    let files = 0;
    const visit = (abs: string) => {
      if (out.length >= 300 || files > 20_000) return;
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(abs);
      } catch {
        return;
      }
      const name = path.basename(abs);
      if (stat.isDirectory()) {
        if (abs !== start && (NOISE_DIRS.has(name) || name === ".git")) return;
        for (const child of fs.readdirSync(abs)) visit(path.join(abs, child));
        return;
      }
      const rel = path.relative(cwd, abs).split(path.sep).join("/");
      if (!stat.isFile() || stat.size > 1024 * 1024 || (matcher && !matcher.test(rel))) return;
      files++;
      const data = fs.readFileSync(abs);
      if (data.subarray(0, 8000).includes(0)) return;
      let hits = 0;
      data.toString("utf8").split("\n").forEach((line, i) => {
        if (hits < 20 && (opts.ignoreCase ? line.toLowerCase() : line).includes(needle)) {
          hits++;
          out.push(`${rel}:${i + 1}:${line.slice(0, 300)}`);
        }
      });
    };
    visit(start);
    return out.join("\n") + (out.length ? "\n(plain-text search: install ripgrep for patterns)" : "");
  }

  private async runGit(args: string[]): Promise<string> {
    const root = this.roots[0]!;
    const r = await run("git", ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.quotepath=off", "-c", "color.ui=never", ...args], root);
    if (r.code !== 0) throw new WorkspaceError(`git failed: ${r.err.trim().slice(0, 300) || `exit ${r.code}`}`);
    return r.out;
  }

  /** Drops the parts of a patch that touch secret files. */
  private filterPatch(patch: string): string {
    return patch
      .split(/(?=^diff --git )/m)
      .filter((part) => {
        const m = part.match(/^diff --git a\/(.+?) b\/(.+)$/m);
        return !m || (!isSecretPath(m[1]!) && !isSecretPath(m[2]!));
      })
      .join("");
  }

  /** Read-only git: status, diff, log and show, with secret files left out. */
  async git(command: string, opts: { ref?: string; path?: string; staged?: boolean; limit?: number } = {}): Promise<string> {
    const file = opts.path ? this.gitPath(opts.path) : undefined;
    let out: string;
    switch (command) {
      case "status":
        out = (await this.runGit(["status", "--short", "--branch", "--", ...(file ? [file] : [])]))
          .split("\n")
          .filter((line) => !isSecretPath(line.slice(3).replace(/^.* -> /, "")))
          .join("\n");
        break;
      case "diff":
        out = this.filterPatch(await this.runGit(["diff", "--no-ext-diff", "--no-textconv", "--stat", "--patch", ...(opts.staged ? ["--staged"] : []), ...(opts.ref ? [checkRef(opts.ref)] : []), "--", ...(file ? [file] : [])])) || "No changes.";
        break;
      case "log":
        out = await this.runGit(["log", `--max-count=${Math.min(Math.max(1, opts.limit ?? 20), 100)}`, "--date=short", "--format=%h %ad %an: %s", ...(opts.ref ? [checkRef(opts.ref)] : []), "--", ...(file ? [file] : [])]) || "No commits.";
        break;
      case "show":
        if (!opts.ref) throw new WorkspaceError("show needs a ref, such as HEAD or a commit hash.");
        out = file
          ? await this.runGit(["show", `${checkRef(opts.ref)}:${file === "." ? "" : file}`])
          : this.filterPatch(await this.runGit(["show", "--no-ext-diff", "--no-textconv", "--stat", "--patch", checkRef(opts.ref)]));
        break;
      default:
        throw new WorkspaceError(`git ${command} is not available; use status, diff, log or show.`);
    }
    return scrub(clip(out));
  }

  /** A path for git, relative to the first root; history of secret files is refused like the files. */
  private gitPath(input: string): string {
    const root = this.roots[0]!;
    const abs = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
    const rel = path.relative(root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new WorkspaceError(`${input} is outside the project folder.`);
    if (isSecretPath(rel)) throw new WorkspaceError(`${input} may hold secrets, so it is not shared.`);
    return rel.split(path.sep).join("/") || ".";
  }

  private save(abs: string, before: string | null, after: string): string {
    if (after.length > 1_000_000) throw new WorkspaceError("That makes the file too big.");
    const first = this.changed.get(abs)?.before;
    this.changed.set(abs, { before: this.changed.has(abs) ? first ?? null : before, after });
    if (this.writes) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, after);
      return `Wrote ${this.show(abs)}.`;
    }
    return `Proposed for ${this.show(abs)} (not written: read-only run). ${this.changed.size} file${this.changed.size === 1 ? "" : "s"} changed so far.`;
  }

  /** Replaces old_string, which must match once unless replaceAll. */
  edit(input: string, oldString: string, newString: string, replaceAll = false): string {
    if (!oldString) throw new WorkspaceError("old_string is empty; use write to create a file.");
    if (oldString === newString) throw new WorkspaceError("old_string and new_string are the same.");
    const abs = this.resolve(input);
    const current = this.content(abs);
    if (current === null) throw new WorkspaceError(`${input} does not exist; use write to create it.`);
    const count = current.split(oldString).length - 1;
    if (count === 0) throw new WorkspaceError(`old_string was not found in ${input}; read the file again and copy the exact text.`);
    if (count > 1 && !replaceAll) throw new WorkspaceError(`old_string matches ${count} places in ${input}; add more lines so it matches once, or set replace_all.`);
    const after = replaceAll ? current.split(oldString).join(newString) : current.replace(oldString, () => newString);
    return this.save(abs, current, after);
  }

  /** Creates a file or replaces all of it. */
  write(input: string, content: string): string {
    const abs = this.resolve(input, { mayNotExist: true });
    let current: string | null;
    try {
      current = this.content(abs);
    } catch (e) {
      // a binary file may be replaced whole, but its old bytes cannot go in a text patch
      if (!(e instanceof WorkspaceError) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) throw e;
      current = "";
    }
    return this.save(abs, current, content);
  }

  /** What the run changed, file by file. */
  changes(): { file: string; added: number; removed: number; created: boolean }[] {
    return [...this.changed]
      .filter(([, e]) => e.before !== e.after)
      .map(([abs, e]) => {
        const ops = lineOps(splitLines(e.before ?? ""), splitLines(e.after));
        return { file: this.show(abs), added: ops.filter((o) => o[0] === "+").length, removed: ops.filter((o) => o[0] === "-").length, created: e.before === null };
      });
  }

  /** All changes as one unified diff, ready for `git apply`. */
  patch(): string {
    return [...this.changed]
      .filter(([, e]) => e.before !== e.after)
      .map(([abs, e]) => unifiedDiff(this.show(abs), e.before, e.after))
      .join("");
  }
}

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const MAX_IMAGE_BYTES = 1024 * 1024;

/** A glob as a regular expression over a relative path: ** spans folders, * and ? stay inside one, {a,b} picks. */
export function globRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close < 0) re += "\\{";
      else {
        re += `(?:${glob.slice(i + 1, close).split(",").map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`;
        i = close;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  // a pattern without a folder matches the name anywhere, as in .gitignore
  return new RegExp(`^${glob.includes("/") ? "" : "(?:.*/)?"}${re}$`);
}

const REF = /^(?!-)[\w./~^@{}-]{1,200}$/;

function checkRef(ref: string): string {
  if (!REF.test(ref) || ref.includes("..") && !/^[\w./~^@{}-]+\.\.\.?[\w./~^@{}-]+$/.test(ref))
    throw new WorkspaceError(`${ref} is not a git ref (a branch, tag, commit or A..B range).`);
  return ref;
}

/** Lines with their line endings, so a missing final newline shows as a change. */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

type Op = [" " | "-" | "+", string];

function lineOps(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--;
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops: Op[] = a.slice(0, start).map((l) => [" ", l]);
  if (midA.length * midB.length > 4_000_000) {
    ops.push(...midA.map((l): Op => ["-", l]), ...midB.map((l): Op => ["+", l]));
  } else {
    // longest common subsequence, filled from the end so the walk below goes forward
    const width = midB.length + 1;
    const table = new Uint32Array((midA.length + 1) * width);
    for (let i = midA.length - 1; i >= 0; i--)
      for (let j = midB.length - 1; j >= 0; j--)
        table[i * width + j] = midA[i] === midB[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    let i = 0;
    let j = 0;
    while (i < midA.length || j < midB.length) {
      if (i < midA.length && j < midB.length && midA[i] === midB[j]) ops.push([" ", midA[i++]!]), j++;
      // removals before additions, as diff prints them
      else if (i < midA.length && (j === midB.length || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) ops.push(["-", midA[i++]!]);
      else ops.push(["+", midB[j++]!]);
    }
  }
  ops.push(...a.slice(endA).map((l): Op => [" ", l]));
  return ops;
}

export function unifiedDiff(name: string, before: string | null, after: string): string {
  const ops = lineOps(splitLines(before ?? ""), splitLines(after));
  const CONTEXT = 3;
  const changed = ops.map((op, i) => (op[0] === " " ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return "";
  const head = before === null
    ? `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n`
    : `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n`;
  // group changes whose context overlaps into one hunk
  const groups: [number, number][] = [];
  for (const i of changed) {
    const last = groups.at(-1);
    if (last && i - last[1] <= CONTEXT * 2) last[1] = i;
    else groups.push([i, i]);
  }
  // line numbers before each op
  const lineA: number[] = [];
  const lineB: number[] = [];
  let na = 0;
  let nb = 0;
  for (const op of ops) {
    lineA.push(na);
    lineB.push(nb);
    if (op[0] !== "+") na++;
    if (op[0] !== "-") nb++;
  }
  let out = head;
  for (const [first, last] of groups) {
    const from = Math.max(0, first - CONTEXT);
    const to = Math.min(ops.length - 1, last + CONTEXT);
    const slice = ops.slice(from, to + 1);
    const countA = slice.filter((op) => op[0] !== "+").length;
    const countB = slice.filter((op) => op[0] !== "-").length;
    const startA = countA ? lineA[from]! + 1 : lineA[from]!;
    const startB = countB ? lineB[from]! + 1 : lineB[from]!;
    out += `@@ -${startA},${countA} +${startB},${countB} @@\n`;
    for (const [sign, line] of slice) out += line.endsWith("\n") ? `${sign}${line}` : `${sign}${line}\n\\ No newline at end of file\n`;
  }
  return out;
}
