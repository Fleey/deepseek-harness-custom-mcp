// src/index.ts
import Schema2 from "@deepseek-ai/schemastery";
import * as mcpClient from "@deepseek-ai/dsh-mcp-client";

// src/servers.ts
import Schema from "@deepseek-ai/schemastery";
var SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
var ServerEntry = Schema.object({
  name: Schema.string().pattern(SERVER_NAME).required().description("\u5DE5\u5177\u547D\u540D\u7A7A\u95F4\uFF0C1\u201332 \u4F4D\u5B57\u6BCD\u3001\u6570\u5B57\u3001_ \u6216 -"),
  enabled: Schema.boolean().default(true),
  description: Schema.string().default(""),
  transport: Schema.union(["stdio", "streamable-http"]).default("stdio"),
  command: Schema.string().default(""),
  args: Schema.array(Schema.string()).default([]),
  env: Schema.dict(Schema.string()).default({}),
  cwd: Schema.string().default(""),
  url: Schema.string().default(""),
  headers: Schema.dict(Schema.string()).default({}),
  toolCallTimeoutMs: Schema.natural().min(1e3).default(6e4)
});
function normalizeEntry(raw) {
  const strings = (value) => Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  const dict = (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "string"));
  };
  return {
    name: String(raw.name),
    enabled: raw.enabled !== false,
    description: typeof raw.description === "string" ? raw.description : "",
    transport: raw.transport === "streamable-http" ? "streamable-http" : "stdio",
    command: typeof raw.command === "string" ? raw.command.trim() : "",
    args: strings(raw.args),
    env: dict(raw.env),
    cwd: typeof raw.cwd === "string" ? raw.cwd.trim() : "",
    url: typeof raw.url === "string" ? raw.url.trim() : "",
    headers: dict(raw.headers),
    toolCallTimeoutMs: typeof raw.toolCallTimeoutMs === "number" && raw.toolCallTimeoutMs >= 1e3 ? raw.toolCallTimeoutMs : 6e4
  };
}
function problemOf(entry) {
  if (!SERVER_NAME.test(entry.name)) return `\u540D\u79F0 "${entry.name}" \u65E0\u6548\uFF1A\u53EA\u80FD\u7528 1\u201332 \u4F4D\u5B57\u6BCD\u3001\u6570\u5B57\u3001_ \u6216 -`;
  if (entry.transport === "stdio") {
    if (entry.command === "") return "\u672A\u586B\u5199\u542F\u52A8\u547D\u4EE4";
    return void 0;
  }
  if (entry.url === "") return "\u672A\u586B\u5199 URL";
  try {
    const url = new URL(entry.url.replace(/\$\{[^}]*\}/g, "x"));
    if (url.protocol !== "http:" && url.protocol !== "https:") return `URL \u5FC5\u987B\u662F http(s)\uFF1A${entry.url}`;
  } catch {
    return `URL \u65E0\u6548\uFF1A${entry.url}`;
  }
  return void 0;
}
function connectionKey(entry) {
  const { enabled: _enabled, description: _description, ...rest } = entry;
  const sorted = (record) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({ ...rest, env: sorted(rest.env), headers: sorted(rest.headers) });
}
function toClientConfig(entry) {
  if (entry.transport === "stdio") {
    return {
      transport: "stdio",
      serverName: entry.name,
      command: entry.command,
      args: entry.args,
      env: entry.env,
      cwd: entry.cwd,
      toolCallTimeoutMs: entry.toolCallTimeoutMs,
      failOnStartupError: false
    };
  }
  return {
    transport: "streamable-http",
    serverName: entry.name,
    url: entry.url,
    headers: entry.headers,
    toolCallTimeoutMs: entry.toolCallTimeoutMs,
    failOnStartupError: false
  };
}

// src/resolve.ts
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
var PLACEHOLDER = /\$\{(secret|env):([A-Za-z_][A-Za-z0-9_]*)\}/g;
function referencesOf(entry) {
  const secrets = /* @__PURE__ */ new Set();
  const env = /* @__PURE__ */ new Set();
  const values = [entry.command, entry.cwd, entry.url, ...entry.args, ...Object.values(entry.env), ...Object.values(entry.headers)];
  for (const value of values) {
    for (const match of value.matchAll(PLACEHOLDER)) (match[1] === "secret" ? secrets : env).add(match[2]);
  }
  return { secrets: [...secrets], env: [...env] };
}
async function substitute(entry, readSecret, readEnv) {
  const { secrets } = referencesOf(entry);
  const secretValues = /* @__PURE__ */ new Map();
  await Promise.all(secrets.map(async (ref) => {
    let value;
    try {
      value = await readSecret(ref);
    } catch {
      value = void 0;
    }
    secretValues.set(ref, value);
  }));
  const missing = /* @__PURE__ */ new Set();
  const fill = (text) => text.replace(PLACEHOLDER, (_match, kind, name2) => {
    const value = kind === "secret" ? secretValues.get(name2) : readEnv(name2);
    if (value === void 0 || value === "") {
      missing.add(kind === "secret" ? `\u51ED\u636E ${name2}` : `\u73AF\u5883\u53D8\u91CF ${name2}`);
      return "";
    }
    return value;
  });
  const mapValues = (record) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fill(value)]));
  return {
    entry: {
      ...entry,
      command: fill(entry.command),
      cwd: fill(entry.cwd),
      url: fill(entry.url),
      args: entry.args.map(fill),
      env: mapValues(entry.env),
      headers: mapValues(entry.headers)
    },
    missing: [...missing],
    secretValues: [...secretValues.values()].filter((value) => typeof value === "string" && value !== "")
  };
}
function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
var MARK = "__DSH_CUSTOM_MCP_PATH__";
function readLoginShellPath(timeoutMs) {
  if (process.platform === "win32") return Promise.resolve(void 0);
  const shell = process.env.SHELL || "/bin/zsh";
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-ilc", `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`],
      { timeout: timeoutMs, encoding: "utf8", env: { ...process.env, DISABLE_AUTO_UPDATE: "true" } },
      (_error, stdout) => {
        const start = stdout?.indexOf(MARK) ?? -1;
        const end = start < 0 ? -1 : stdout.indexOf(MARK, start + MARK.length);
        resolve(start >= 0 && end > start ? stdout.slice(start + MARK.length, end) || void 0 : void 0);
      }
    );
  });
}
function mergePath(...lists) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const list of lists) {
    for (const dir of (list ?? "").split(delimiter)) {
      if (dir === "" || seen.has(dir)) continue;
      seen.add(dir);
      out.push(dir);
    }
  }
  return out.join(delimiter);
}
function isExecutable(file) {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function resolveCommand(command, path) {
  const expanded = expandHome(command);
  if (expanded.includes("/") || process.platform === "win32" && expanded.includes("\\")) {
    return isAbsolute(expanded) && !isExecutable(expanded) ? void 0 : expanded;
  }
  const extensions = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")] : [""];
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    for (const ext of extensions) {
      const candidate = join(dir, expanded + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return void 0;
}

// src/status.ts
function interpret(level, text) {
  let match;
  if (match = text.match(/^connection attempt failed: ([\s\S]*)$/)) return { error: match[1] };
  if (match = text.match(/^connection failed; retrying in (\d+)ms \(attempt (\d+)\/(\d+)\)/)) {
    return { phase: "retrying", detail: `\u7B2C ${match[2]}/${match[3]} \u6B21\u91CD\u8BD5\uFF0C${match[1]}ms \u540E` };
  }
  if (match = text.match(/^connection lost; reconnecting in (\d+)ms \(attempt (\d+)\/(\d+)\)/)) {
    return { phase: "reconnecting", detail: `\u8FDE\u63A5\u65AD\u5F00\uFF0C\u7B2C ${match[2]}/${match[3]} \u6B21\u91CD\u8FDE\uFF0C${match[1]}ms \u540E` };
  }
  if (/^reconnected and re-synced tools/.test(text)) return { phase: "connected", detail: "", clearError: true };
  if (/^giving up after/.test(text)) return { phase: "failed", detail: "\u91CD\u8FDE\u6B21\u6570\u7528\u5C3D\uFF0C\u5DE5\u5177\u5DF2\u79FB\u9664\u3002\u70B9\u300C\u91CD\u8FDE\u300D\u91CD\u8BD5", error: text };
  if (/reconnect is disabled/.test(text)) return { phase: "failed", detail: "", error: text };
  if (/could not confirm transport closure/.test(text)) return { phase: "failed", detail: "", error: text };
  if (level === "error") return { error: text };
  return {};
}
var LABEL = /^mcp-client\(([A-Za-z0-9_-]{1,32})\): ([\s\S]*)$/;
function parseLabel(line) {
  const match = line.match(LABEL);
  return match ? { name: match[1], text: match[2] } : void 0;
}
var StatusBoard = class {
  constructor(maxLogLines) {
    this.maxLogLines = maxLogLines;
  }
  servers = /* @__PURE__ */ new Map();
  secrets = /* @__PURE__ */ new Map();
  /** Values that must never appear in what the page receives. */
  setSecrets(name2, values) {
    const kept = values.filter((value) => value.length >= 4);
    if (kept.length) this.secrets.set(name2, kept);
    else this.secrets.delete(name2);
  }
  redact(name2, text) {
    let out = text;
    for (const secret of this.secrets.get(name2) ?? []) out = out.split(secret).join("***");
    return out;
  }
  ensure(name2) {
    let status = this.servers.get(name2);
    if (!status) {
      status = { name: name2, phase: "disabled", since: Date.now(), tools: [], logs: [] };
      this.servers.set(name2, status);
    }
    return status;
  }
  /** Enter a phase; the error and detail reset unless given. */
  enter(name2, phase, extra = {}) {
    const status = this.ensure(name2);
    if (status.phase !== phase) status.since = Date.now();
    status.phase = phase;
    status.detail = extra.detail;
    status.lastError = extra.lastError === void 0 ? void 0 : this.redact(name2, extra.lastError);
    if ("command" in extra) status.command = extra.command;
  }
  phaseOf(name2) {
    return this.servers.get(name2)?.phase;
  }
  log(name2, level, text) {
    const status = this.ensure(name2);
    status.logs.push({ ts: Date.now(), level, text: this.redact(name2, text) });
    if (status.logs.length > this.maxLogLines) status.logs.splice(0, status.logs.length - this.maxLogLines);
  }
  /** Fold one mcp-client line into the server's status. */
  apply(name2, level, text) {
    this.log(name2, level, text);
    const status = this.ensure(name2);
    if (status.phase === "disabled" || status.phase === "invalid") return;
    const seen = interpret(level, text);
    if (seen.phase !== void 0 && seen.phase !== status.phase) {
      status.phase = seen.phase;
      status.since = Date.now();
    }
    if (seen.detail !== void 0) status.detail = seen.detail || void 0;
    if (seen.clearError) status.lastError = void 0;
    if (seen.error !== void 0) status.lastError = this.redact(name2, seen.error);
  }
  /** Forget servers no longer in the configuration. */
  retain(names) {
    const keep = new Set(names);
    for (const name2 of [...this.servers.keys()]) {
      if (!keep.has(name2)) {
        this.servers.delete(name2);
        this.secrets.delete(name2);
      }
    }
  }
  snapshot(toolsOf) {
    return [...this.servers.values()].map((status) => ({
      ...status,
      tools: status.phase === "disabled" || status.phase === "invalid" ? [] : toolsOf(status.name),
      logs: status.logs.slice()
    }));
  }
};

// src/index.ts
var name = "dsh-custom-mcp";
var inject = ["tools"];
var ROUTE_PREFIX = "/dsh-custom-mcp";
var Config = Schema2.object({
  servers: Schema2.array(ServerEntry).default([]).volatile().description("MCP \u670D\u52A1\u5668\u5217\u8868\uFF0C\u7531\u300C\u8BBE\u7F6E \u2192 MCP \u670D\u52A1\u5668\u300D\u9875\u9762\u7F16\u8F91"),
  loginShellPath: Schema2.boolean().default(true).description("\u4E3A stdio \u670D\u52A1\u5668\u8865\u4E0A\u767B\u5F55 shell \u7684 PATH\uFF08\u684C\u9762\u7248\u4ECE Dock \u542F\u52A8\u65F6 PATH \u53EA\u6709\u7CFB\u7EDF\u76EE\u5F55\uFF09"),
  loginShellTimeoutMs: Schema2.natural().default(8e3).description("\u8BFB\u53D6\u767B\u5F55 shell PATH \u7684\u8D85\u65F6"),
  logLines: Schema2.natural().min(1).default(40).description("\u6BCF\u4E2A\u670D\u52A1\u5668\u4FDD\u7559\u7684\u6700\u8FD1\u65E5\u5FD7\u884C\u6570")
});
function apply(ctx, config) {
  const host = ctx;
  const board = new StatusBoard(config.logLines);
  const running = /* @__PURE__ */ new Map();
  const forced = /* @__PURE__ */ new Set();
  const blocked = /* @__PURE__ */ new Map();
  const loginPath = config.loginShellPath ? readLoginShellPath(config.loginShellTimeoutMs) : Promise.resolve(void 0);
  let disposed = false;
  try {
    host.inject(["settings"], (child) => {
      child.effect(() => child.settings.configure({ auto: false }, host.fiber));
    });
  } catch (error) {
    ctx.logger.warn("settings integration unavailable: %s", error);
  }
  const readSecret = async (ref) => {
    const credentials = host.get("credentials");
    const hit = await credentials?.resolve(ref);
    return hit?.value || process.env[ref] || void 0;
  };
  const toolsOf = (server) => {
    try {
      const prefix = `mcp__${server}__`;
      const visible = host.tools.view?.()?.visible;
      if (!visible) return [];
      return [...visible.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)).sort();
    } catch {
      return [];
    }
  };
  ctx.logger.exporter({
    // WARN carries the retry/reconnect lines; the default threshold is INFO.
    levels: { default: 2 },
    export(message) {
      try {
        const level = message.type;
        if (level === "debug") return;
        const first = message.args[0];
        if (typeof first === "string") {
          const parsed = parseLabel(first);
          if (parsed && running.has(parsed.name)) board.apply(parsed.name, level, parsed.text);
          return;
        }
        const fiber = message.fiber?.deref();
        if (fiber === void 0) return;
        for (const [server, run] of running) {
          if (fiber.ctx === run.fiber.ctx) board.apply(server, "error", first instanceof Error ? first.message : String(first));
        }
      } catch {
      }
    }
  });
  async function start(entry) {
    const server = entry.name;
    const refs = referencesOf(entry);
    board.enter(server, "starting");
    const { entry: resolved, missing, secretValues } = await substitute(entry, readSecret, (key) => process.env[key]);
    board.setSecrets(server, secretValues);
    if (missing.length > 0) {
      blocked.set(server, refs.secrets);
      board.enter(server, "invalid", { lastError: `\u7F3A\u5C11 ${missing.join("\u3001")}` });
      return;
    }
    blocked.delete(server);
    let launch = resolved;
    let command;
    if (resolved.transport === "stdio") {
      const path = mergePath(resolved.env.PATH, await loginPath, process.env.PATH);
      command = resolveCommand(resolved.command, path);
      if (command === void 0) {
        board.enter(server, "invalid", {
          lastError: `\u627E\u4E0D\u5230\u547D\u4EE4 "${resolved.command}"\u3002\u8BF7\u586B\u5199\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u6216\u786E\u8BA4\u5B83\u5728\u767B\u5F55 shell \u7684 PATH \u4E2D`
        });
        return;
      }
      launch = { ...resolved, command, cwd: resolved.cwd ? expandHome(resolved.cwd) : "", env: { ...resolved.env, PATH: path } };
    }
    if (disposed) return;
    let fiber;
    try {
      fiber = host.plugin(mcpClient, toClientConfig(launch));
    } catch (error) {
      board.enter(server, "failed", { lastError: error instanceof Error ? error.message : String(error), command });
      return;
    }
    const run = { key: connectionKey(entry), fiber, secretRefs: refs.secrets };
    running.set(server, run);
    board.enter(server, "starting", { command });
    fiber.await().then(
      () => {
        if (running.get(server) === run && board.phaseOf(server) === "starting") board.enter(server, "connected", { command });
      },
      (error) => {
        if (running.get(server) !== run) return;
        board.enter(server, "failed", { lastError: error instanceof Error ? error.message : String(error), command });
      }
    );
  }
  async function reconcile() {
    if (disposed) return;
    const seen = /* @__PURE__ */ new Set();
    const entries = [];
    for (const raw of config.servers.get() ?? []) {
      const entry = normalizeEntry(raw);
      if (seen.has(entry.name)) {
        ctx.logger.warn('duplicate MCP server name "%s" ignored', entry.name);
        continue;
      }
      seen.add(entry.name);
      entries.push(entry);
    }
    const wanted = new Map(entries.filter((entry) => entry.enabled && !problemOf(entry)).map((entry) => [entry.name, entry]));
    for (const [server, run] of [...running]) {
      const next = wanted.get(server);
      if (next && connectionKey(next) === run.key && !forced.has(server)) continue;
      running.delete(server);
      try {
        await run.fiber.dispose();
      } catch (error) {
        ctx.logger.warn('stopping MCP server "%s" failed: %s', server, error);
      }
    }
    board.retain(seen);
    for (const server of blocked.keys()) if (!seen.has(server)) blocked.delete(server);
    for (const entry of entries) {
      if (disposed) return;
      if (!entry.enabled) {
        board.enter(entry.name, "disabled");
        continue;
      }
      const problem = problemOf(entry);
      if (problem) {
        board.enter(entry.name, "invalid", { lastError: problem });
        continue;
      }
      if (running.has(entry.name)) continue;
      await start(entry);
    }
    forced.clear();
  }
  let chain = Promise.resolve();
  let queued = false;
  const schedule = () => {
    if (disposed) return chain;
    if (queued) return chain;
    queued = true;
    chain = chain.then(() => {
      queued = false;
      return reconcile();
    }).catch((error) => {
      ctx.logger.warn("MCP reconcile failed: %s", error);
    });
    return chain;
  };
  host.on("loader/volatile-update", () => {
    void schedule();
  });
  host.on("credentials/reference-updated", (ref) => {
    let hit = false;
    for (const [server, run] of running) {
      if (run.secretRefs.includes(ref)) {
        forced.add(server);
        hit = true;
      }
    }
    for (const refs of blocked.values()) if (refs.includes(ref)) hit = true;
    if (hit) void schedule();
  });
  host.effect(() => () => {
    disposed = true;
    const stopping = [...running.values()].map((run) => run.fiber.dispose().catch(() => {
    }));
    running.clear();
    return Promise.all(stopping);
  }, "dsh-custom-mcp: servers");
  void schedule();
  const refuse = (request, response) => {
    const connection = host.get("connection");
    let status;
    try {
      status = connection?.requestRejection?.call(connection, request);
    } catch {
      status = 403;
    }
    if (status === void 0) return false;
    sendJson(response, status, { error: status === 401 ? "login required" : "forbidden" });
    return true;
  };
  host.inject(["webServer"], (child) => {
    const webServer = child.webServer;
    child.effect(() => webServer.register({
      kind: "exact",
      path: `${ROUTE_PREFIX}/status`,
      handler: (request, response) => {
        if (refuse(request, response)) return;
        if (request.method !== "GET") return sendJson(response, 405, { error: "method not allowed" });
        sendJson(response, 200, { version: 1, servers: board.snapshot(toolsOf) });
      }
    }), "dsh-custom-mcp: status route");
    child.effect(() => webServer.register({
      kind: "exact",
      path: `${ROUTE_PREFIX}/restart`,
      handler: async (request, response) => {
        if (refuse(request, response)) return;
        if (request.method !== "POST") return sendJson(response, 405, { error: "method not allowed" });
        if (!sameOrigin(request) || !String(request.headers["content-type"] ?? "").startsWith("application/json")) {
          return sendJson(response, 403, { error: "forbidden" });
        }
        let body;
        try {
          body = JSON.parse(await readBody(request, 4096));
        } catch {
          return sendJson(response, 400, { error: "invalid body" });
        }
        const server = body?.name;
        if (typeof server !== "string") return sendJson(response, 400, { error: "name required" });
        forced.add(server);
        await schedule();
        sendJson(response, 200, { ok: true, servers: board.snapshot(toolsOf) });
      }
    }), "dsh-custom-mcp: restart route");
  });
}
function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text)
  });
  response.end(text);
}
async function readBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function sameOrigin(request) {
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin === void 0) return true;
  if (origin === "null") return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return true;
    return url.host === request.headers.host;
  } catch {
    return false;
  }
}
export {
  Config,
  ROUTE_PREFIX,
  apply,
  inject,
  name
};
