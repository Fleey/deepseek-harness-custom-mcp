/**
 * dsh-custom-mcp — browser half.
 *
 * Adds an "MCP 服务器" page to the Settings dialog (slot `settings.section`)
 * while the Host serves the plugin's settings namespace. The page:
 *
 *   - lists the configured servers with a live status (polled from the host
 *     half at /dsh-custom-mcp/status) and an on/off switch per server;
 *   - switches single tools on and off by clicking them, and shows a tool's
 *     description and parameters on hover;
 *   - adds and edits servers (stdio command or Streamable HTTP URL, args,
 *     env, headers, timeout); env/header values marked secret go to the dsh
 *     credential store and the config keeps only a `${secret:REF}` reference;
 *   - imports `mcpServers` JSON as written for Claude Desktop, Cursor, VS Code.
 *
 * Every edit is one atomic write of the `servers` field through the settings
 * service (`ctx.configForms`), which validates it against the host plugin's
 * schema and persists it into the profile's cordis.patch.yml. The host half
 * picks the change up live; nothing restarts.
 */
window.__ModuleLoader__.load({
  id: 'dsh-custom-mcp',
  factory: (require) => {
    const React = require('react')
    const P = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef } = React

    /** Settings namespace = the row id the bundle patch inserts. */
    const ENTRY = 'custom-mcp'
    /** Package name, the key of the plugin page's bundle-config slot. */
    const PACKAGE = 'dsh-custom-mcp'
    /** Locale namespace owned by this plugin. */
    const NS = 'dshCustomMcp'
    /** Route prefix served by the host half (lib/index.js ROUTE_PREFIX). */
    const ROUTE = 'dsh-custom-mcp'
    const POLL_MS = 2000
    const NAME = /^[A-Za-z0-9_-]{1,32}$/
    const SECRET_KEY = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|COOKIE|CREDENTIAL|BEARER)/i
    const SECRET_REF = /^\$\{secret:([A-Za-z_][A-Za-z0-9_]*)\}$/
    const ANY_SECRET_REF = /\$\{secret:([A-Za-z_][A-Za-z0-9_]*)\}/g
    /** Credential references this page creates; only these are ever cleaned up. */
    const OWN_REF = /^MCP_[A-Z0-9_]+$/
    const DEFAULT_TIMEOUT_MS = 60000

    const zh = {
      nav: 'MCP 服务器',
      title: 'MCP 服务器',
      description: '连接外部 MCP 服务器，它们的工具以 mcp__<名称>__<工具> 的形式提供给模型。增删、开关、修改都会立即生效，无需重启。',
      add: '添加服务器',
      import: '导入 JSON',
      emptyTitle: '还没有 MCP 服务器',
      emptyHint: '添加一个本地命令（stdio）或远程地址（HTTP），也可以粘贴 Claude Desktop / Cursor 的 mcpServers 配置。',
      unavailable: '插件尚未加载，或当前页面不能写入设置（仅本机地址可写）。',
      readOnly: '当前部署的设置是只读的。',
      loading: '正在读取配置…',
      stdio: '本地命令',
      http: '远程 HTTP',
      phase_disabled: '已关闭',
      phase_invalid: '配置有误',
      phase_starting: '连接中…',
      phase_connected: '已连接 · {n} 个工具',
      phase_connected_partial: '已连接 · 已启用 {n}/{total} 个工具',
      phase_retrying: '连接失败，正在重试',
      phase_reconnecting: '连接断开，正在重连',
      phase_failed: '连接失败',
      phase_unknown: '等待状态…',
      toggle: '启用 {name}',
      edit: '编辑',
      restart: '重连',
      remove: '删除',
      confirmRemove: '确认删除',
      cancel: '取消',
      save: '保存',
      saving: '保存中…',
      back: '返回列表',
      tools: '工具',
      noTools: '没有发现工具',
      toolsHint: '点击工具可启用或禁用，悬停查看说明和参数。禁用的工具不会提供给模型，切换无需重连。',
      toolOn: '已启用',
      toolOff: '已禁用',
      toolClickOff: '点击可禁用这个工具',
      toolClickOn: '点击可启用这个工具',
      toolNoDescription: '服务器没有提供说明。',
      toolParams: '参数',
      toolNoParams: '无参数',
      toolRequired: '必填',
      toolValues: '可选值：{v}',
      toolDefault: '默认值：{v}',
      lastError: '最近错误',
      logs: '最近日志',
      showLogs: '显示日志',
      hideLogs: '隐藏日志',
      command: '命令',
      newTitle: '添加 MCP 服务器',
      editTitle: '编辑 {name}',
      fName: '名称',
      fNameHint: '工具命名空间：1–32 位字母、数字、_ 或 -。模型看到的工具名是 mcp__名称__工具。',
      fDescription: '备注',
      fDescriptionHint: '可选，只显示在这里。',
      fTransport: '连接方式',
      fCommand: '命令',
      fCommandHint: '例如 npx、uvx、docker 或可执行文件的绝对路径。整行粘贴「npx -y 包名」也可以，保存时会自动拆分参数。桌面版会自动使用登录 shell 的 PATH。',
      fArgs: '参数',
      fArgsHint: '每行一个参数。',
      fCwd: '工作目录',
      fCwdHint: '可选，支持 ~ 。留空则使用 DSH 的工作目录。',
      fEnv: '环境变量',
      fEnvHint: '勾选「密文」的值保存在 DSH 凭据库，配置文件里只写 ${secret:名称}。也可以写 ${env:变量} 引用 DSH 进程的环境变量。',
      fUrl: 'URL',
      fUrlHint: 'Streamable HTTP 端点，例如 https://example.com/mcp',
      fHeaders: '请求头',
      fHeadersHint: '例如 Authorization: Bearer xxx（建议勾选密文）。',
      fTimeout: '工具调用超时（秒）',
      fTimeoutHint: '单次工具调用的最长等待时间。',
      key: '名称',
      value: '值',
      secret: '密文',
      secretStored: '已保存在凭据库，留空保持不变',
      addRow: '添加一项',
      removeRow: '删除这一项',
      eNameRequired: '请填写名称',
      eNamePattern: '只能使用 1–32 位字母、数字、_ 或 -',
      eNameTaken: '已有同名服务器',
      eCommand: '请填写命令',
      eUrl: '请填写有效的 http(s) URL',
      eKey: '名称无效或重复',
      eSecretValue: '请填写密文的值',
      eTimeout: '请填写大于 0 的数字',
      eSave: '保存失败：{msg}',
      eWrite: '设置没有被接受，请检查后重试。',
      eCredential: '写入凭据库失败：{msg}',
      eRestart: '重连失败：{msg}',
      importTitle: '导入 MCP 配置',
      importHint: '粘贴 JSON：支持 {"mcpServers": {...}}（Claude Desktop、Cursor、Claude Code）、{"servers": {...}}（VS Code）或直接的 { 名称: {...} }。名称或键里带 KEY / TOKEN / SECRET 等字样的值会自动存入凭据库。',
      importPreview: '将导入 {n} 个服务器：{names}',
      importNothing: '没有可导入的服务器。',
      importSecrets: '其中 {n} 个密钥会存入凭据库。',
      importDo: '导入',
      eJson: 'JSON 解析失败：{msg}',
      eShape: '没有找到 mcpServers 对象。',
      noteSkipExisting: '{name}：已存在同名服务器，已跳过',
      noteRenamed: '{from} → {to}：名称只能用字母、数字、_、-',
      noteSse: '{name}：SSE 传输不受支持，已按 Streamable HTTP 导入',
      noteBad: '{name}：既没有 command 也没有 url，已跳过',
      pluginSummary: '在设置里管理 MCP 服务器',
      pluginPage: '打开「设置 → MCP 服务器」添加、开关和编辑服务器。当前共 {n} 个，已启用 {m} 个。',
    }
    const en = {
      nav: 'MCP servers',
      title: 'MCP servers',
      description: 'Connect external MCP servers; their tools reach the model as mcp__<name>__<tool>. Adding, switching and editing take effect at once, no restart.',
      add: 'Add server',
      import: 'Import JSON',
      emptyTitle: 'No MCP servers yet',
      emptyHint: 'Add a local command (stdio) or a remote URL (HTTP), or paste an mcpServers block from Claude Desktop / Cursor.',
      unavailable: 'The plugin is not loaded, or this page cannot write settings (loopback only).',
      readOnly: 'Settings are read-only in this deployment.',
      loading: 'Reading configuration…',
      stdio: 'Local command',
      http: 'Remote HTTP',
      phase_disabled: 'Off',
      phase_invalid: 'Needs attention',
      phase_starting: 'Connecting…',
      phase_connected: 'Connected · {n} tools',
      phase_connected_partial: 'Connected · {n}/{total} tools enabled',
      phase_retrying: 'Connection failed, retrying',
      phase_reconnecting: 'Connection lost, reconnecting',
      phase_failed: 'Connection failed',
      phase_unknown: 'Waiting for status…',
      toggle: 'Enable {name}',
      edit: 'Edit',
      restart: 'Reconnect',
      remove: 'Delete',
      confirmRemove: 'Confirm delete',
      cancel: 'Cancel',
      save: 'Save',
      saving: 'Saving…',
      back: 'Back to list',
      tools: 'Tools',
      noTools: 'No tools discovered',
      toolsHint: 'Click a tool to switch it on or off; hover for its description and parameters. Switched-off tools are not offered to the model; no reconnect needed.',
      toolOn: 'Enabled',
      toolOff: 'Disabled',
      toolClickOff: 'Click to disable this tool',
      toolClickOn: 'Click to enable this tool',
      toolNoDescription: 'The server gives no description.',
      toolParams: 'Parameters',
      toolNoParams: 'No parameters',
      toolRequired: 'required',
      toolValues: 'One of: {v}',
      toolDefault: 'Default: {v}',
      lastError: 'Last error',
      logs: 'Recent log',
      showLogs: 'Show log',
      hideLogs: 'Hide log',
      command: 'Command',
      newTitle: 'Add MCP server',
      editTitle: 'Edit {name}',
      fName: 'Name',
      fNameHint: 'Tool namespace: 1–32 letters, digits, _ or -. The model sees mcp__name__tool.',
      fDescription: 'Note',
      fDescriptionHint: 'Optional, shown only here.',
      fTransport: 'Transport',
      fCommand: 'Command',
      fCommandHint: 'e.g. npx, uvx, docker, or an absolute path. Pasting a whole line like "npx -y package" works; it is split on save. Desktop uses your login-shell PATH.',
      fArgs: 'Arguments',
      fArgsHint: 'One argument per line.',
      fCwd: 'Working directory',
      fCwdHint: 'Optional, ~ allowed. Empty uses the DSH working directory.',
      fEnv: 'Environment',
      fEnvHint: 'Values marked secret live in the DSH credential store; the config keeps only ${secret:NAME}. ${env:VAR} reads the DSH process environment.',
      fUrl: 'URL',
      fUrlHint: 'Streamable HTTP endpoint, e.g. https://example.com/mcp',
      fHeaders: 'Headers',
      fHeadersHint: 'e.g. Authorization: Bearer xxx (mark it secret).',
      fTimeout: 'Tool call timeout (s)',
      fTimeoutHint: 'Longest wait for one tool call.',
      key: 'Name',
      value: 'Value',
      secret: 'Secret',
      secretStored: 'Stored in the credential store; leave blank to keep',
      addRow: 'Add',
      removeRow: 'Remove this row',
      eNameRequired: 'Enter a name',
      eNamePattern: 'Use 1–32 letters, digits, _ or -',
      eNameTaken: 'A server with this name exists',
      eCommand: 'Enter a command',
      eUrl: 'Enter a valid http(s) URL',
      eKey: 'Invalid or duplicate name',
      eSecretValue: 'Enter the secret value',
      eTimeout: 'Enter a number above 0',
      eSave: 'Save failed: {msg}',
      eWrite: 'The settings were not accepted; check and retry.',
      eCredential: 'Writing the credential store failed: {msg}',
      eRestart: 'Reconnect failed: {msg}',
      importTitle: 'Import MCP configuration',
      importHint: 'Paste JSON: {"mcpServers": {...}} (Claude Desktop, Cursor, Claude Code), {"servers": {...}} (VS Code), or a bare { name: {...} }. Values whose key mentions KEY / TOKEN / SECRET… are moved to the credential store.',
      importPreview: '{n} servers will be imported: {names}',
      importNothing: 'Nothing to import.',
      importSecrets: '{n} secrets go to the credential store.',
      importDo: 'Import',
      eJson: 'Invalid JSON: {msg}',
      eShape: 'No mcpServers object found.',
      noteSkipExisting: '{name}: a server with this name exists, skipped',
      noteRenamed: '{from} → {to}: names allow letters, digits, _ and -',
      noteSse: '{name}: SSE is not supported; imported as Streamable HTTP',
      noteBad: '{name}: neither command nor url, skipped',
      pluginSummary: 'Manage MCP servers from Settings',
      pluginPage: 'Open Settings → MCP servers to add, switch and edit servers. {n} configured, {m} enabled.',
    }

    const CSS = `
.dcm-root{display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.dcm-head{display:flex;align-items:flex-start;gap:12px;padding:4px 0 16px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dcm-head-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.dcm-title{font-size:16px;font-weight:500;line-height:24px}
.dcm-desc,.dcm-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dcm-actions,.dcm-btns{display:flex;gap:8px;flex:none;flex-wrap:wrap;align-items:center}
.dcm-row{border-bottom:.5px solid var(--dsw-alias-border-l2);padding:14px 0;display:flex;flex-direction:column;gap:12px}
.dcm-row-main{display:flex;align-items:center;gap:12px}
.dcm-row-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;cursor:pointer;background:none;border:none;padding:0;text-align:left;font:inherit;color:inherit}
.dcm-name{display:flex;align-items:center;gap:8px;min-width:0}
.dcm-name-text{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dcm-chev{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .15s}
.dcm-chev[data-open=true]{transform:rotate(90deg)}
.dcm-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;display:flex;align-items:center;gap:6px;min-width:0}
.dcm-ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dcm-state{display:inline-flex;align-items:center;gap:6px;flex:none}
.dcm-state[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.dcm-state[data-tone=done]{color:var(--dsw-alias-state-success-primary)}
.dcm-detail{display:flex;flex-direction:column;gap:12px;padding-left:22px}
.dcm-block{display:flex;flex-direction:column;gap:6px}
.dcm-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dcm-chips{display:flex;flex-wrap:wrap;gap:6px}
.dcm-chip{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:20px;padding:0 8px;border-radius:var(--dsw-radius-xs,4px);background:var(--dsw-alias-fill-tsp-secondary);color:var(--dsw-alias-label-secondary)}
.dcm-tool{border:none;margin:0;cursor:pointer;transition:background .15s,color .15s}
.dcm-tool:hover:not([aria-disabled=true]){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dcm-tool:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dcm-tool[aria-pressed=false]{background:none;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);text-decoration:line-through}
.dcm-tool[aria-disabled=true]{cursor:default}
/* HoverCard portals its card to <body> at z-index 100, under the Settings Modal (1000); lift ours to the 1100 that portaled tooltips and menus use. */
body>:has(>.dcm-tip){z-index:1100}
.dcm-tip{display:flex;flex-direction:column;gap:8px;min-height:0;overflow:auto;padding:12px 16px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dcm-tip-head{display:flex;align-items:center;gap:8px;min-width:0}
.dcm-tip-name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary);word-break:break-all}
.dcm-tip-public,.dcm-param-name,.dcm-param-type{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dcm-tip-public,.dcm-param-type,.dcm-tip-foot{color:var(--dsw-alias-label-tertiary)}
.dcm-tip-public{word-break:break-all}
.dcm-tip-desc,.dcm-param-desc{white-space:pre-wrap;word-break:break-word}
.dcm-tip-section{padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}
.dcm-params{display:flex;flex-direction:column;gap:6px}
.dcm-param-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px}
.dcm-param-name{color:var(--dsw-alias-label-primary)}
.dcm-param-req{font-size:11px;color:var(--dsw-alias-state-error-primary)}
.dcm-pre{margin:0;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;padding:8px 10px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-module-platform);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dcm-pre[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.dcm-empty{padding:48px 16px;text-align:center;display:flex;flex-direction:column;gap:8px;align-items:center}
.dcm-empty-title{font-size:14px;font-weight:500}
.dcm-banner{margin-top:12px;padding:8px 12px;border-radius:var(--dsw-radius-md,8px);font-size:12px;line-height:18px;background:var(--dsw-alias-fill-tsp-secondary);color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.dcm-banner[data-tone=error]{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.dcm-back{display:flex;align-items:center;gap:8px;padding:4px 0 12px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dcm-back .dcm-title{flex:1;min-width:0}
.dcm-field{display:flex;flex-direction:column;gap:6px;padding:12px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dcm-field:last-of-type{border-bottom:none}
.dcm-field-label{font-size:14px;line-height:22px}
.dcm-field-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.dcm-input,.dcm-textarea{box-sizing:border-box;width:100%;min-width:0;border:none;outline:none;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;padding:7px 12px}
.dcm-textarea{min-height:96px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:20px}
.dcm-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.dcm-input:focus,.dcm-textarea:focus{box-shadow:0 0 0 1px var(--dsw-alias-border-l4,var(--dsw-alias-border-l2))}
.dcm-input[aria-invalid=true],.dcm-textarea[aria-invalid=true]{box-shadow:0 0 0 1px var(--dsw-alias-state-error-primary)}
.dcm-input::placeholder,.dcm-textarea::placeholder{color:var(--dsw-alias-label-tertiary)}
.dcm-kv{display:flex;flex-direction:column;gap:6px}
.dcm-kv-row{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,3fr) auto auto;gap:6px;align-items:center}
.dcm-check{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;cursor:pointer;user-select:none}
.dcm-icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm,6px);background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}
.dcm-icon:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dcm-icon:disabled{opacity:.4;cursor:default}
.dcm-footer{display:flex;justify-content:flex-end;gap:8px;padding:16px 0 4px}
.dcm-danger{color:var(--dsw-alias-state-error-primary)}
`

    // ---- small helpers ------------------------------------------------------

    const fmt = (text, vars) => String(text).replace(/\{(\w+)\}/g, (match, key) => (vars && key in vars ? String(vars[key]) : match))
    let uidCounter = 0
    const uid = () => `r${++uidCounter}`
    const errorText = (error) => (error instanceof Error ? error.message : String(error))

    /** Absolute path of a host route, relative to the page base (works under Desktop's app scheme too). */
    function api(path) {
      return new URL(`${ROUTE}/${path}`, document.baseURI).pathname
    }

    function createStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set: (next) => {
          snapshot = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /** Remote calls answer `{ ok, value | error }`; turn a refusal into a throw. */
    function unwrap(response) {
      if (response && typeof response === 'object' && 'ok' in response && response.ok === false) {
        const error = response.error
        throw new Error(error && error.message ? error.message : String(error))
      }
      return response && typeof response === 'object' && 'value' in response ? response.value : response
    }

    /** Split a pasted command line: whitespace separates, quotes group, backslash escapes. */
    function splitCommandLine(line) {
      const out = []
      let current = ''
      let quote = null
      let started = false
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (quote) {
          if (ch === quote) quote = null
          else if (ch === '\\' && quote === '"' && i + 1 < line.length) current += line[++i]
          else current += ch
        } else if (ch === '"' || ch === "'") {
          quote = ch
          started = true
        } else if (ch === '\\' && i + 1 < line.length) {
          current += line[++i]
          started = true
        } else if (/\s/.test(ch)) {
          if (started) out.push(current)
          current = ''
          started = false
        } else {
          current += ch
          started = true
        }
      }
      if (started) out.push(current)
      return out
    }

    const sanitizeRefPart = (text) => String(text).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'X'
    const makeRef = (server, kind, key) => `MCP_${sanitizeRefPart(server)}_${kind}_${sanitizeRefPart(key)}`

    function sanitizeName(raw) {
      const name = String(raw).trim().replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
      return name || 'server'
    }

    /** Secret references an entry's values mention. */
    function secretRefsOf(entry) {
      const refs = new Set()
      const values = [entry.command, entry.cwd, entry.url, ...(entry.args || []), ...Object.values(entry.env || {}), ...Object.values(entry.headers || {})]
      for (const value of values) {
        if (typeof value !== 'string') continue
        for (const match of value.matchAll(ANY_SECRET_REF)) refs.add(match[1])
      }
      return refs
    }

    /** Distinct strings of a list, anything else dropped. */
    const stringList = (value) => (Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string'))] : [])

    /** Fill defaults so the page can rely on every field. */
    function normalize(raw) {
      const entry = raw && typeof raw === 'object' ? raw : {}
      return {
        name: String(entry.name ?? ''),
        enabled: entry.enabled !== false,
        description: typeof entry.description === 'string' ? entry.description : '',
        transport: entry.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
        command: typeof entry.command === 'string' ? entry.command : '',
        args: Array.isArray(entry.args) ? entry.args.map(String) : [],
        env: entry.env && typeof entry.env === 'object' ? { ...entry.env } : {},
        cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
        url: typeof entry.url === 'string' ? entry.url : '',
        headers: entry.headers && typeof entry.headers === 'object' ? { ...entry.headers } : {},
        toolCallTimeoutMs: typeof entry.toolCallTimeoutMs === 'number' ? entry.toolCallTimeoutMs : DEFAULT_TIMEOUT_MS,
        disabledTools: stringList(entry.disabledTools),
      }
    }

    /** What gets written: defaults left out so cordis.patch.yml stays readable. */
    function compact(entry) {
      const out = { name: entry.name, enabled: entry.enabled !== false }
      if (entry.description) out.description = entry.description
      if (entry.transport === 'streamable-http') {
        out.transport = 'streamable-http'
        out.url = entry.url
        if (Object.keys(entry.headers || {}).length) out.headers = { ...entry.headers }
      } else {
        out.transport = 'stdio'
        out.command = entry.command
        if ((entry.args || []).length) out.args = [...entry.args]
        if (Object.keys(entry.env || {}).length) out.env = { ...entry.env }
        if (entry.cwd) out.cwd = entry.cwd
      }
      if (entry.toolCallTimeoutMs && entry.toolCallTimeoutMs !== DEFAULT_TIMEOUT_MS) out.toolCallTimeoutMs = entry.toolCallTimeoutMs
      if ((entry.disabledTools || []).length) out.disabledTools = [...entry.disabledTools]
      return out
    }

    function validUrl(text) {
      try {
        const url = new URL(String(text).replace(/\$\{[^}]*\}/g, 'x'))
        return url.protocol === 'http:' || url.protocol === 'https:'
      } catch {
        return false
      }
    }

    // ---- editor draft <-> entry -----------------------------------------------

    function rowsOf(record) {
      return Object.entries(record || {}).map(([key, value]) => {
        const match = typeof value === 'string' ? value.match(SECRET_REF) : null
        return match
          ? { id: uid(), key, value: '', secret: true, ref: match[1], stored: true, touched: true }
          : { id: uid(), key, value: String(value), secret: false, ref: '', stored: false, touched: true }
      })
    }

    function toDraft(entry) {
      const e = normalize(entry || { transport: 'stdio' })
      return {
        name: e.name,
        enabled: entry ? e.enabled : true,
        description: e.description,
        transport: e.transport,
        command: e.command,
        argsText: e.args.join('\n'),
        cwd: e.cwd,
        url: e.url,
        timeoutSec: String(Math.round(e.toolCallTimeoutMs / 1000)),
        env: rowsOf(e.env),
        headers: rowsOf(e.headers),
        // Not edited here (tools are switched from the list); saving keeps it.
        disabledTools: e.disabledTools,
      }
    }

    /**
     * Validate a draft and build the entry plus the secrets to store first.
     * @returns {{ entry?: object, secrets: Array<{ref: string, value: string}>, errors: Record<string, string> }}
     */
    function fromDraft(draft, takenNames, t) {
      const errors = {}
      const secrets = []
      const name = draft.name.trim()
      if (!name) errors.name = t('eNameRequired')
      else if (!NAME.test(name)) errors.name = t('eNamePattern')
      else if (takenNames.has(name)) errors.name = t('eNameTaken')

      let command = draft.command.trim()
      let args = draft.argsText.split('\n').map(line => line.trim()).filter(Boolean)
      if (draft.transport === 'stdio') {
        if (!command) errors.command = t('eCommand')
        else if (/\s/.test(command) && args.length === 0 && !/^["']/.test(command)) {
          const parts = splitCommandLine(command)
          command = parts[0] || ''
          args = parts.slice(1)
        }
      } else if (!validUrl(draft.url.trim())) {
        errors.url = t('eUrl')
      }

      const collect = (rows, kind, field) => {
        const record = {}
        const seen = new Set()
        for (const row of rows) {
          const key = row.key.trim()
          if (!key && !row.value && !row.stored) continue
          if (!key || seen.has(key) || (kind === 'ENV' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) {
            errors[`${field}.${row.id}`] = t('eKey')
            continue
          }
          seen.add(key)
          if (!row.secret) {
            record[key] = row.value
            continue
          }
          if (row.value) {
            const ref = row.ref || makeRef(name || 'server', kind, key)
            secrets.push({ ref, value: row.value })
            record[key] = `\${secret:${ref}}`
          } else if (row.stored && row.ref) {
            record[key] = `\${secret:${row.ref}}`
          } else {
            errors[`${field}.${row.id}`] = t('eSecretValue')
          }
        }
        return record
      }
      const env = draft.transport === 'stdio' ? collect(draft.env, 'ENV', 'env') : {}
      const headers = draft.transport === 'streamable-http' ? collect(draft.headers, 'HDR', 'headers') : {}

      const seconds = Number(draft.timeoutSec)
      if (!Number.isFinite(seconds) || seconds <= 0) errors.timeout = t('eTimeout')

      if (Object.keys(errors).length) return { errors, secrets: [] }
      return {
        errors,
        secrets,
        entry: normalize({
          name,
          enabled: draft.enabled,
          description: draft.description.trim(),
          transport: draft.transport,
          command,
          args,
          env,
          cwd: draft.cwd.trim(),
          url: draft.url.trim(),
          headers,
          toolCallTimeoutMs: Math.max(1000, Math.round(seconds * 1000)),
          disabledTools: draft.disabledTools,
        }),
      }
    }

    // ---- JSON import ------------------------------------------------------------

    /** `${VAR}` (Claude Code / Cursor interpolation) → `${env:VAR}`; prefixed forms are kept. */
    const envInterpolation = (value) => String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '${env:$1}')

    function parseImport(text, existingNames, t) {
      let data
      try {
        data = JSON.parse(text)
      } catch (error) {
        return { error: fmt(t('eJson'), { msg: errorText(error) }) }
      }
      let map = data && typeof data === 'object' && !Array.isArray(data)
        ? (data.mcpServers ?? data.servers ?? data['mcp-servers'] ?? data.mcp?.servers ?? data)
        : undefined
      if (!map || typeof map !== 'object' || Array.isArray(map)) return { error: t('eShape') }
      const taken = new Set(existingNames)
      const entries = []
      const secrets = []
      const notes = []
      for (const [rawName, spec] of Object.entries(map)) {
        if (!spec || typeof spec !== 'object' || Array.isArray(spec)) continue
        const name = sanitizeName(rawName)
        if (name !== rawName) notes.push(fmt(t('noteRenamed'), { from: rawName, to: name }))
        if (taken.has(name)) {
          notes.push(fmt(t('noteSkipExisting'), { name }))
          continue
        }
        const type = String(spec.type ?? spec.transport ?? '').toLowerCase()
        const isHttp = typeof spec.url === 'string' || ['http', 'streamable-http', 'streamablehttp', 'sse'].includes(type)
        if (!isHttp && typeof spec.command !== 'string') {
          notes.push(fmt(t('noteBad'), { name }))
          continue
        }
        if (type === 'sse') notes.push(fmt(t('noteSse'), { name }))
        const move = (record, kind) => {
          const out = {}
          for (const [key, raw] of Object.entries(record && typeof record === 'object' ? record : {})) {
            const value = envInterpolation(raw)
            if (SECRET_KEY.test(key) && value && !value.includes('${')) {
              const ref = makeRef(name, kind, key)
              secrets.push({ ref, value })
              out[key] = `\${secret:${ref}}`
            } else {
              out[key] = value
            }
          }
          return out
        }
        let command = typeof spec.command === 'string' ? spec.command.trim() : ''
        let args = Array.isArray(spec.args) ? spec.args.map(arg => envInterpolation(arg)) : []
        if (!isHttp && /\s/.test(command) && args.length === 0) {
          const parts = splitCommandLine(command)
          command = parts[0] || ''
          args = parts.slice(1)
        }
        entries.push(normalize({
          name,
          enabled: spec.disabled !== true && spec.enabled !== false,
          description: typeof spec.description === 'string' ? spec.description : '',
          transport: isHttp ? 'streamable-http' : 'stdio',
          command,
          args,
          env: isHttp ? {} : move(spec.env, 'ENV'),
          cwd: typeof spec.cwd === 'string' ? spec.cwd : '',
          url: isHttp ? envInterpolation(spec.url ?? '') : '',
          headers: isHttp ? move(spec.headers, 'HDR') : {},
          toolCallTimeoutMs: typeof spec.timeout === 'number' && spec.timeout >= 1000 ? spec.timeout : DEFAULT_TIMEOUT_MS,
          // Roo Code, Windsurf and others keep switched-off tools here.
          disabledTools: spec.disabledTools,
        }))
        taken.add(name)
      }
      return { entries, secrets, notes }
    }

    // ---- tool details -------------------------------------------------------------

    const literal = (value) => (typeof value === 'string' ? value : JSON.stringify(value))

    /** Short type of a JSON Schema node: `string`, `number | null`, `string[]`… */
    function typeLabel(schema) {
      if (!schema || typeof schema !== 'object') return ''
      const variants = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined
      let label = ''
      if (Array.isArray(schema.type)) label = schema.type.join(' | ')
      else if (typeof schema.type === 'string') label = schema.type
      else if (variants) label = [...new Set(variants.map(typeLabel).filter(Boolean))].join(' | ')
      else if (schema.const !== undefined) label = literal(schema.const)
      if (label === 'array' && schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
        const inner = typeLabel(schema.items)
        if (inner) label = inner.includes(' ') ? `(${inner})[]` : `${inner}[]`
      }
      return label
    }

    /**
     * Top-level arguments of a tool's input schema, in the server's order.
     * @returns {Array<{ name: string, type: string, required: boolean, description: string, values?: string, default?: string }>}
     */
    function describeParameters(schema) {
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return []
      const props = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties) ? schema.properties : {}
      const required = new Set(Array.isArray(schema.required) ? schema.required : [])
      return Object.entries(props).map(([name, raw]) => {
        const prop = raw && typeof raw === 'object' ? raw : {}
        const out = {
          name,
          type: typeLabel(prop),
          required: required.has(name),
          description: typeof prop.description === 'string' ? prop.description : typeof prop.title === 'string' ? prop.title : '',
        }
        const values = Array.isArray(prop.enum) ? prop.enum : Array.isArray(prop.items?.enum) ? prop.items.enum : undefined
        if (values) out.values = values.map(literal).join(', ')
        if (prop.default !== undefined) out.default = literal(prop.default)
        return out
      })
    }

    /** Tools a status lists, with details when the host sends them. */
    function catalogOf(status) {
      if (!status) return []
      if (Array.isArray(status.catalog)) return status.catalog
      return (status.tools || []).map(name => ({ name, description: '', enabled: true }))
    }

    // ---- controller: form, status polling, writes -------------------------------

    class McpController {
      constructor(ctx) {
        this.ctx = ctx
        this.form = ctx.configForms.get(ENTRY)
        this.status = createStore({ reachable: undefined, servers: {} })
        this.polls = 0
        this.timer = undefined
        this.generation = 0
        this.face = {
          hooks: { mcpForm: this.form, mcpStatus: this.status },
          controller: this,
        }
      }

      servers() {
        const value = this.form.getSnapshot().value
        return Array.isArray(value?.servers) ? value.servers.map(normalize) : []
      }

      async refresh() {
        const generation = ++this.generation
        let next
        try {
          const response = await fetch(api('status'), { cache: 'no-store', credentials: 'same-origin' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const body = await response.json()
          next = { reachable: true, servers: Object.fromEntries((body.servers || []).map(s => [s.name, s])) }
        } catch {
          next = { reachable: false, servers: this.status.getSnapshot().servers }
        }
        if (generation === this.generation) this.status.set(next)
      }

      startPolling() {
        if (++this.polls === 1) {
          void this.refresh()
          this.timer = setInterval(() => { void this.refresh() }, POLL_MS)
        }
        return () => {
          if (--this.polls === 0) {
            clearInterval(this.timer)
            this.timer = undefined
          }
        }
      }

      /** Write the whole list; refresh status a moment later so the switch shows the host's verdict. */
      async write(list) {
        const ok = await this.form.set('servers', list.map(compact))
        setTimeout(() => { void this.refresh() }, 300)
        return ok
      }

      async storeSecrets(secrets) {
        for (const { ref, value } of secrets) unwrap(await this.ctx.remote.credentials.set(ref, value))
      }

      /** Remove credentials this page created that no remaining server mentions. */
      async dropUnusedSecrets(before, after) {
        const still = new Set()
        for (const entry of after) for (const ref of secretRefsOf(entry)) still.add(ref)
        for (const entry of before) {
          for (const ref of secretRefsOf(entry)) {
            if (still.has(ref) || !OWN_REF.test(ref)) continue
            try { unwrap(await this.ctx.remote.credentials.unset(ref)) } catch { /* best effort */ }
          }
        }
      }

      async restart(name) {
        const response = await fetch(api('restart'), {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        await this.refresh()
      }

      dispose() {
        clearInterval(this.timer)
        this.timer = undefined
      }
    }

    // ---- components ------------------------------------------------------------

    const icon = (Component, size = 16) => (Component ? h(Component, { size }) : null)

    function phaseView(t, status, entry) {
      if (!entry.enabled) return { state: 'idle', text: t('phase_disabled'), tone: 'idle' }
      if (!status) return { state: 'ongoing', text: t('phase_unknown'), tone: 'idle' }
      switch (status.phase) {
        case 'connected': {
          const catalog = catalogOf(status)
          const off = new Set(entry.disabledTools)
          const on = catalog.filter(tool => !off.has(tool.name)).length
          const text = on === catalog.length
            ? fmt(t('phase_connected'), { n: on })
            : fmt(t('phase_connected_partial'), { n: on, total: catalog.length })
          return { state: 'done', text, tone: 'done' }
        }
        case 'starting': return { state: 'ongoing', text: t('phase_starting'), tone: 'idle' }
        case 'retrying': return { state: 'warning', text: t('phase_retrying'), tone: 'warning' }
        case 'reconnecting': return { state: 'warning', text: t('phase_reconnecting'), tone: 'warning' }
        case 'failed': return { state: 'error', text: t('phase_failed'), tone: 'error' }
        case 'invalid': return { state: 'error', text: t('phase_invalid'), tone: 'error' }
        case 'disabled': return { state: 'ongoing', text: t('phase_starting'), tone: 'idle' }
        default: return { state: 'idle', text: status.phase, tone: 'idle' }
      }
    }

    function timeOf(ts) {
      const d = new Date(ts)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }

    /** Plain-text details, for runtimes without HoverCard. */
    function toolSummary(t, server, tool, enabled) {
      const lines = [`mcp__${server}__${tool.name} · ${enabled ? t('toolOn') : t('toolOff')}`]
      if (tool.description) lines.push(tool.description)
      const params = describeParameters(tool.parameters)
      if (params.length) lines.push(`${t('toolParams')}: ${params.map(p => (p.required ? `${p.name}*` : p.name)).join(', ')}`)
      return lines.join('\n')
    }

    function ToolDetail(props) {
      const { t, server, tool, enabled, locked } = props
      const params = describeParameters(tool.parameters)
      return h('div', { className: 'dcm-tip' },
        h('div', { className: 'dcm-tip-head' },
          h('span', { className: 'dcm-tip-name' }, tool.name),
          h(P.Tag, { tone: enabled ? 'success' : 'neutral' }, enabled ? t('toolOn') : t('toolOff')),
        ),
        h('div', { className: 'dcm-tip-public' }, `mcp__${server}__${tool.name}`),
        h('div', { className: 'dcm-tip-desc' }, tool.description || t('toolNoDescription')),
        h('div', { className: 'dcm-tip-section' }, t('toolParams')),
        params.length
          ? h('div', { className: 'dcm-params' }, params.map(param => h('div', { key: param.name },
            h('div', { className: 'dcm-param-head' },
              h('span', { className: 'dcm-param-name' }, param.name),
              param.type ? h('span', { className: 'dcm-param-type' }, param.type) : null,
              param.required ? h('span', { className: 'dcm-param-req' }, t('toolRequired')) : null,
            ),
            param.description ? h('div', { className: 'dcm-param-desc' }, param.description) : null,
            param.values ? h('div', { className: 'dcm-param-desc' }, fmt(t('toolValues'), { v: param.values })) : null,
            param.default !== undefined ? h('div', { className: 'dcm-param-desc' }, fmt(t('toolDefault'), { v: param.default })) : null,
          )))
          : h('div', null, t('toolNoParams')),
        locked ? null : h('div', { className: 'dcm-tip-foot' }, enabled ? t('toolClickOff') : t('toolClickOn')),
      )
    }

    /** One tool: click switches it, hover shows its details. */
    function ToolChip(props) {
      const { t, server, tool, enabled, locked, onToggle, widthRef } = props
      const chip = h('button', {
        type: 'button',
        className: 'dcm-chip dcm-tool',
        'aria-pressed': enabled,
        // Not `disabled`: a disabled button swallows the hover that opens the details.
        'aria-disabled': locked || undefined,
        title: P.HoverCard ? undefined : toolSummary(t, server, tool, enabled),
        onClick: () => { if (!locked) onToggle(!enabled) },
      }, tool.name)
      if (!P.HoverCard) return chip
      return h(P.HoverCard, {
        anchor: chip,
        content: h(ToolDetail, { t, server, tool, enabled, locked }),
        openDelayMs: 350,
        variant: 'preview',
        widthAnchorRef: widthRef,
      })
    }

    function ServerRow(props) {
      const { t, entry, status, busy, writable, onToggle, onToggleTool, onEdit, onRemove, onRestart } = props
      const [open, setOpen] = useState(false)
      const chipsRef = useRef(null)
      const [logs, setLogs] = useState(false)
      const [confirm, setConfirm] = useState(false)
      useEffect(() => {
        if (!confirm) return undefined
        const timer = setTimeout(() => setConfirm(false), 4000)
        return () => clearTimeout(timer)
      }, [confirm])
      const view = phaseView(t, status, entry)
      const target = entry.transport === 'stdio'
        ? [entry.command, ...entry.args].join(' ')
        : entry.url
      const problem = status && status.lastError && entry.enabled ? status.lastError : ''
      return h('div', { className: 'dcm-row' },
        h('div', { className: 'dcm-row-main' },
          h('button', { type: 'button', className: 'dcm-row-text', 'aria-expanded': open, onClick: () => setOpen(!open) },
            h('div', { className: 'dcm-name' },
              h('span', { className: 'dcm-chev', 'data-open': open }, icon(P.IconChevronRightOutlineRegular, 14)),
              h('span', { className: 'dcm-name-text' }, entry.name),
              h(P.Tag, { tone: 'quiet' }, entry.transport === 'stdio' ? 'stdio' : 'HTTP'),
            ),
            h('div', { className: 'dcm-sub', style: { paddingLeft: 22 } },
              h('span', { className: 'dcm-state', 'data-tone': view.tone },
                h(P.StateDot, { state: view.state, size: view.state === 'ongoing' ? 12 : 8 }),
                view.text,
              ),
              h('span', null, '·'),
              h('span', { className: 'dcm-ellipsis', title: entry.description || target }, entry.description || target),
            ),
          ),
          h(P.Switch, {
            checked: entry.enabled,
            disabled: busy || !writable,
            label: fmt(t('toggle'), { name: entry.name }),
            onChange: (next) => onToggle(next),
          }),
        ),
        open
          ? h('div', { className: 'dcm-detail' },
            entry.transport === 'stdio'
              ? h('div', { className: 'dcm-block' },
                h('div', { className: 'dcm-label' }, t('command')),
                h('pre', { className: 'dcm-pre' }, status && status.command ? [status.command, ...entry.args].join(' ') : target),
              )
              : null,
            problem
              ? h('div', { className: 'dcm-block' },
                h('div', { className: 'dcm-label' }, t('lastError')),
                h('pre', { className: 'dcm-pre', 'data-tone': 'error' }, (status.detail ? `${status.detail}\n` : '') + problem),
              )
              : null,
            entry.enabled && status && status.phase === 'connected'
              ? h('div', { className: 'dcm-block' },
                h('div', { className: 'dcm-label' }, t('tools')),
                catalogOf(status).length
                  ? [
                    h('div', { key: 'chips', className: 'dcm-chips', ref: chipsRef }, catalogOf(status).map(tool => h(ToolChip, {
                      key: tool.name,
                      t,
                      server: entry.name,
                      tool,
                      enabled: !entry.disabledTools.includes(tool.name),
                      locked: busy || !writable,
                      widthRef: chipsRef,
                      onToggle: (enabled) => onToggleTool(tool.name, enabled),
                    }))),
                    h('div', { key: 'hint', className: 'dcm-hint' }, t('toolsHint')),
                  ]
                  : h('div', { className: 'dcm-hint' }, t('noTools')),
              )
              : null,
            logs && status && status.logs.length
              ? h('div', { className: 'dcm-block' },
                h('div', { className: 'dcm-label' }, t('logs')),
                h('pre', { className: 'dcm-pre' }, status.logs.map(line => `${timeOf(line.ts)} ${line.level.padEnd(5)} ${line.text}`).join('\n')),
              )
              : null,
            h('div', { className: 'dcm-btns' },
              h(P.Button, { size: 'sm', variant: 'outline', disabled: !writable, icon: icon(P.IconEditOutlineRegular), onClick: onEdit }, t('edit')),
              entry.enabled
                ? h(P.Button, { size: 'sm', variant: 'outline', disabled: busy, icon: icon(P.IconRefreshOutlineRegular), onClick: onRestart }, t('restart'))
                : null,
              status && status.logs.length
                ? h(P.Button, { size: 'sm', variant: 'ghost', onClick: () => setLogs(!logs) }, logs ? t('hideLogs') : t('showLogs'))
                : null,
              h('span', { style: { flex: 1 } }),
              h(P.Button, {
                size: 'sm',
                variant: confirm ? 'outline' : 'ghost',
                className: 'dcm-danger',
                disabled: busy || !writable,
                icon: icon(P.IconTrashOutlineRegular),
                onClick: () => { if (confirm) onRemove(); else setConfirm(true) },
              }, confirm ? t('confirmRemove') : t('remove')),
            ),
          )
          : null,
      )
    }

    function Field(props) {
      return h('div', { className: 'dcm-field' },
        h('label', { className: 'dcm-field-label', htmlFor: props.htmlFor }, props.label),
        props.children,
        props.error ? h('div', { className: 'dcm-field-error' }, props.error) : null,
        props.hint ? h('div', { className: 'dcm-hint' }, props.hint) : null,
      )
    }

    function KeyValueEditor(props) {
      const { t, rows, onChange, errors, field, keyPlaceholder, valuePlaceholder, disabled } = props
      const update = (id, patch) => onChange(rows.map(row => (row.id === id ? { ...row, ...patch } : row)))
      return h('div', { className: 'dcm-kv' },
        rows.map(row => h('div', { key: row.id },
          h('div', { className: 'dcm-kv-row' },
            h('input', {
              className: 'dcm-input dcm-mono',
              value: row.key,
              placeholder: keyPlaceholder || t('key'),
              disabled,
              'aria-invalid': Boolean(errors[`${field}.${row.id}`]),
              spellCheck: false,
              onChange: (event) => {
                const key = event.target.value
                // Suggest secrecy from the key until the user decides themselves.
                update(row.id, row.touched ? { key } : { key, secret: SECRET_KEY.test(key) })
              },
            }),
            h('input', {
              className: 'dcm-input dcm-mono',
              type: row.secret ? 'password' : 'text',
              autoComplete: 'off',
              value: row.value,
              disabled,
              spellCheck: false,
              placeholder: row.secret && row.stored ? t('secretStored') : (valuePlaceholder || t('value')),
              onChange: (event) => update(row.id, { value: event.target.value }),
            }),
            h('label', { className: 'dcm-check' },
              h('input', {
                type: 'checkbox',
                checked: row.secret,
                disabled,
                onChange: (event) => update(row.id, { secret: event.target.checked, touched: true }),
              }),
              t('secret'),
            ),
            h('button', {
              type: 'button',
              className: 'dcm-icon',
              title: t('removeRow'),
              'aria-label': t('removeRow'),
              disabled,
              onClick: () => onChange(rows.filter(r => r.id !== row.id)),
            }, icon(P.IconCloseOutlineRegular, 14)),
          ),
          errors[`${field}.${row.id}`] ? h('div', { className: 'dcm-field-error' }, errors[`${field}.${row.id}`]) : null,
        )),
        h('div', null,
          h(P.Button, {
            size: 'sm',
            variant: 'ghost',
            disabled,
            icon: icon(P.IconPlusOutlineRegular),
            onClick: () => onChange([...rows, { id: uid(), key: '', value: '', secret: false, ref: '', stored: false, touched: false }]),
          }, t('addRow')),
        ),
      )
    }

    function ServerEditor(props) {
      const { t, original, takenNames, onCancel, onSave, writable } = props
      const [draft, setDraft] = useState(() => toDraft(original))
      const [errors, setErrors] = useState({})
      const [saving, setSaving] = useState(false)
      const [failure, setFailure] = useState('')
      const set = (patch) => setDraft(current => ({ ...current, ...patch }))
      const disabled = saving || !writable

      const submit = async () => {
        const result = fromDraft(draft, takenNames, t)
        setErrors(result.errors)
        if (!result.entry) return
        setSaving(true)
        setFailure('')
        try {
          await onSave(result.entry, result.secrets)
        } catch (error) {
          setFailure(errorText(error))
          setSaving(false)
        }
      }

      const transportOptions = [
        { value: 'stdio', label: t('stdio') },
        { value: 'streamable-http', label: t('http') },
      ]

      return h('div', { className: 'dcm-root' },
        h('div', { className: 'dcm-back' },
          h('button', { type: 'button', className: 'dcm-icon', title: t('back'), 'aria-label': t('back'), onClick: onCancel }, icon(P.IconChevronLeftOutlineRegular)),
          h('div', { className: 'dcm-title' }, original ? fmt(t('editTitle'), { name: original.name }) : t('newTitle')),
        ),
        failure ? h('div', { className: 'dcm-banner', 'data-tone': 'error' }, failure) : null,
        h(Field, { label: t('fName'), hint: t('fNameHint'), error: errors.name, htmlFor: 'dcm-name' },
          h('input', {
            id: 'dcm-name',
            className: 'dcm-input dcm-mono',
            value: draft.name,
            disabled,
            autoFocus: !original,
            spellCheck: false,
            placeholder: 'github',
            'aria-invalid': Boolean(errors.name),
            onChange: (event) => set({ name: event.target.value }),
          }),
        ),
        h(Field, { label: t('fDescription'), hint: t('fDescriptionHint'), htmlFor: 'dcm-desc' },
          h('input', {
            id: 'dcm-desc',
            className: 'dcm-input',
            value: draft.description,
            disabled,
            onChange: (event) => set({ description: event.target.value }),
          }),
        ),
        h(Field, { label: t('fTransport') },
          h(P.SegmentedControl, {
            id: 'dcm-transport',
            label: t('fTransport'),
            value: draft.transport,
            options: transportOptions,
            disabled,
            onChange: (value) => set({ transport: value }),
          }),
        ),
        draft.transport === 'stdio'
          ? [
            h(Field, { key: 'command', label: t('fCommand'), hint: t('fCommandHint'), error: errors.command, htmlFor: 'dcm-command' },
              h('input', {
                id: 'dcm-command',
                className: 'dcm-input dcm-mono',
                value: draft.command,
                disabled,
                spellCheck: false,
                placeholder: 'npx',
                'aria-invalid': Boolean(errors.command),
                onChange: (event) => set({ command: event.target.value }),
              }),
            ),
            h(Field, { key: 'args', label: t('fArgs'), hint: t('fArgsHint'), htmlFor: 'dcm-args' },
              h('textarea', {
                id: 'dcm-args',
                className: 'dcm-textarea',
                value: draft.argsText,
                disabled,
                spellCheck: false,
                placeholder: '-y\n@modelcontextprotocol/server-filesystem\n~/Documents',
                onChange: (event) => set({ argsText: event.target.value }),
              }),
            ),
            h(Field, { key: 'env', label: t('fEnv'), hint: t('fEnvHint') },
              h(KeyValueEditor, {
                t,
                rows: draft.env,
                errors,
                field: 'env',
                disabled,
                keyPlaceholder: 'GITHUB_TOKEN',
                onChange: (env) => set({ env }),
              }),
            ),
            h(Field, { key: 'cwd', label: t('fCwd'), hint: t('fCwdHint'), htmlFor: 'dcm-cwd' },
              h('input', {
                id: 'dcm-cwd',
                className: 'dcm-input dcm-mono',
                value: draft.cwd,
                disabled,
                spellCheck: false,
                placeholder: '~/projects',
                onChange: (event) => set({ cwd: event.target.value }),
              }),
            ),
          ]
          : [
            h(Field, { key: 'url', label: t('fUrl'), hint: t('fUrlHint'), error: errors.url, htmlFor: 'dcm-url' },
              h('input', {
                id: 'dcm-url',
                className: 'dcm-input dcm-mono',
                value: draft.url,
                disabled,
                spellCheck: false,
                placeholder: 'https://example.com/mcp',
                'aria-invalid': Boolean(errors.url),
                onChange: (event) => set({ url: event.target.value }),
              }),
            ),
            h(Field, { key: 'headers', label: t('fHeaders'), hint: t('fHeadersHint') },
              h(KeyValueEditor, {
                t,
                rows: draft.headers,
                errors,
                field: 'headers',
                disabled,
                keyPlaceholder: 'Authorization',
                valuePlaceholder: 'Bearer …',
                onChange: (headers) => set({ headers }),
              }),
            ),
          ],
        h(Field, { label: t('fTimeout'), hint: t('fTimeoutHint'), error: errors.timeout, htmlFor: 'dcm-timeout' },
          h('input', {
            id: 'dcm-timeout',
            className: 'dcm-input',
            style: { maxWidth: 160 },
            inputMode: 'numeric',
            value: draft.timeoutSec,
            disabled,
            'aria-invalid': Boolean(errors.timeout),
            onChange: (event) => set({ timeoutSec: event.target.value }),
          }),
        ),
        h('div', { className: 'dcm-footer' },
          h(P.Button, { variant: 'ghost', onClick: onCancel, disabled: saving }, t('cancel')),
          h(P.Button, { variant: 'primary', onClick: () => { void submit() }, disabled }, saving ? t('saving') : t('save')),
        ),
      )
    }

    function ImportPanel(props) {
      const { t, existingNames, onCancel, onImport, writable } = props
      const [text, setText] = useState('')
      const [saving, setSaving] = useState(false)
      const [failure, setFailure] = useState('')
      const parsed = useMemo(() => (text.trim() ? parseImport(text, existingNames, t) : undefined), [text, existingNames, t])
      const ready = parsed && !parsed.error && parsed.entries.length > 0
      const submit = async () => {
        if (!ready) return
        setSaving(true)
        setFailure('')
        try {
          await onImport(parsed.entries, parsed.secrets)
        } catch (error) {
          setFailure(errorText(error))
          setSaving(false)
        }
      }
      return h('div', { className: 'dcm-root' },
        h('div', { className: 'dcm-back' },
          h('button', { type: 'button', className: 'dcm-icon', title: t('back'), 'aria-label': t('back'), onClick: onCancel }, icon(P.IconChevronLeftOutlineRegular)),
          h('div', { className: 'dcm-title' }, t('importTitle')),
        ),
        failure ? h('div', { className: 'dcm-banner', 'data-tone': 'error' }, failure) : null,
        h(Field, { label: 'JSON', hint: t('importHint'), htmlFor: 'dcm-import' },
          h('textarea', {
            id: 'dcm-import',
            className: 'dcm-textarea',
            style: { minHeight: 220 },
            value: text,
            autoFocus: true,
            spellCheck: false,
            disabled: saving || !writable,
            placeholder: '{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/Documents"]\n    }\n  }\n}',
            onChange: (event) => setText(event.target.value),
          }),
        ),
        parsed
          ? h('div', { className: 'dcm-banner', 'data-tone': parsed.error ? 'error' : 'info' },
            parsed.error
              ? parsed.error
              : [
                parsed.entries.length
                  ? fmt(t('importPreview'), { n: parsed.entries.length, names: parsed.entries.map(e => e.name).join('、') })
                  : t('importNothing'),
                parsed.secrets.length ? `\n${fmt(t('importSecrets'), { n: parsed.secrets.length })}` : '',
                parsed.notes.length ? `\n${parsed.notes.join('\n')}` : '',
              ].join(''),
          )
          : null,
        h('div', { className: 'dcm-footer' },
          h(P.Button, { variant: 'ghost', onClick: onCancel, disabled: saving }, t('cancel')),
          h(P.Button, { variant: 'primary', disabled: !ready || saving || !writable, onClick: () => { void submit() } }, saving ? t('saving') : t('importDo')),
        ),
      )
    }

    function McpSection(props) {
      const { t, controller } = props
      const form = props.useMcpForm(snapshot => snapshot)
      const status = props.useMcpStatus(snapshot => snapshot)
      const [mode, setMode] = useState({ kind: 'list' })
      const [busy, setBusy] = useState({})
      const [banner, setBanner] = useState('')
      const bannerTimer = useRef(undefined)

      useEffect(() => controller.startPolling(), [controller])
      useEffect(() => () => clearTimeout(bannerTimer.current), [])

      const servers = Array.isArray(form.value?.servers) ? form.value.servers.map(normalize) : []
      const writable = form.status === 'ready' && form.writable !== false

      const fail = (message) => {
        setBanner(message)
        clearTimeout(bannerTimer.current)
        bannerTimer.current = setTimeout(() => setBanner(''), 8000)
      }

      /** Serialize writes per server and surface refusals. */
      const write = async (name, list) => {
        setBusy(current => ({ ...current, [name]: true }))
        try {
          const ok = await controller.write(list)
          if (!ok) fail(t('eWrite'))
          return ok
        } finally {
          setBusy(current => {
            const next = { ...current }
            delete next[name]
            return next
          })
        }
      }

      const toggle = (name, enabled) => {
        void write(name, controller.servers().map(entry => (entry.name === name ? { ...entry, enabled } : entry)))
      }

      const toggleTool = (name, tool, enabled) => {
        void write(name, controller.servers().map((entry) => {
          if (entry.name !== name) return entry
          const off = entry.disabledTools.filter(item => item !== tool)
          return { ...entry, disabledTools: enabled ? off : [...off, tool] }
        }))
      }

      const remove = async (name) => {
        const before = controller.servers()
        const after = before.filter(entry => entry.name !== name)
        if (await write(name, after)) await controller.dropUnusedSecrets(before, after)
      }

      const restart = async (name) => {
        setBusy(current => ({ ...current, [name]: true }))
        try {
          await controller.restart(name)
        } catch (error) {
          fail(fmt(t('eRestart'), { msg: errorText(error) }))
        } finally {
          setBusy(current => {
            const next = { ...current }
            delete next[name]
            return next
          })
        }
      }

      const saveEntry = async (originalName, entry, secrets) => {
        try {
          await controller.storeSecrets(secrets)
        } catch (error) {
          throw new Error(fmt(t('eCredential'), { msg: errorText(error) }))
        }
        const before = controller.servers()
        const after = originalName === undefined
          ? [...before, entry]
          : before.map(item => (item.name === originalName ? entry : item))
        const ok = await controller.write(after)
        if (!ok) throw new Error(t('eWrite'))
        await controller.dropUnusedSecrets(before, after)
        setMode({ kind: 'list' })
      }

      const importEntries = async (entries, secrets) => {
        try {
          await controller.storeSecrets(secrets)
        } catch (error) {
          throw new Error(fmt(t('eCredential'), { msg: errorText(error) }))
        }
        const ok = await controller.write([...controller.servers(), ...entries])
        if (!ok) throw new Error(t('eWrite'))
        setMode({ kind: 'list' })
      }

      if (mode.kind === 'edit') {
        const original = mode.name === undefined ? undefined : servers.find(entry => entry.name === mode.name)
        const takenNames = new Set(servers.map(entry => entry.name).filter(name => name !== mode.name))
        return h(ServerEditor, {
          key: mode.name ?? '(new)',
          t,
          original,
          takenNames,
          writable,
          onCancel: () => setMode({ kind: 'list' }),
          onSave: (entry, secrets) => saveEntry(mode.name, entry, secrets),
        })
      }
      if (mode.kind === 'import') {
        return h(ImportPanel, {
          t,
          existingNames: servers.map(entry => entry.name),
          writable,
          onCancel: () => setMode({ kind: 'list' }),
          onImport: importEntries,
        })
      }

      const notice = form.status === 'loading'
        ? t('loading')
        : form.status !== 'ready'
          ? t('unavailable')
          : form.writable === false ? t('readOnly') : ''

      return h('div', { className: 'dcm-root' },
        h('div', { className: 'dcm-head' },
          h('div', { className: 'dcm-head-text' },
            h('div', { className: 'dcm-title' }, t('title')),
            h('div', { className: 'dcm-desc' }, t('description')),
          ),
          h('div', { className: 'dcm-actions' },
            h(P.Button, { size: 'sm', variant: 'outline', disabled: !writable, icon: icon(P.IconDownloadOutlineRegular), onClick: () => setMode({ kind: 'import' }) }, t('import')),
            h(P.Button, { size: 'sm', variant: 'primary', disabled: !writable, icon: icon(P.IconPlusOutlineRegular), onClick: () => setMode({ kind: 'edit' }) }, t('add')),
          ),
        ),
        notice ? h('div', { className: 'dcm-banner' }, notice) : null,
        banner ? h('div', { className: 'dcm-banner', 'data-tone': 'error' }, banner) : null,
        form.status === 'ready' && servers.length === 0
          ? h('div', { className: 'dcm-empty' },
            h('div', { className: 'dcm-empty-title' }, t('emptyTitle')),
            h('div', { className: 'dcm-hint', style: { maxWidth: 420 } }, t('emptyHint')),
          )
          : null,
        servers.map(entry => h(ServerRow, {
          key: entry.name,
          t,
          entry,
          status: status.servers[entry.name],
          busy: Boolean(busy[entry.name]),
          writable,
          onToggle: (enabled) => toggle(entry.name, enabled),
          onToggleTool: (tool, enabled) => toggleTool(entry.name, tool, enabled),
          onEdit: () => setMode({ kind: 'edit', name: entry.name }),
          onRemove: () => { void remove(entry.name) },
          onRestart: () => { void restart(entry.name) },
        })),
      )
    }

    /** The plugin's own page under Settings → 内置插件: a pointer to the real page. */
    function PluginCard(props) {
      const { t } = props
      const form = props.useMcpForm(snapshot => snapshot)
      if (props.view === 'summary') return t('pluginSummary')
      const servers = Array.isArray(form.value?.servers) ? form.value.servers.map(normalize) : []
      return h('div', { className: 'dcm-hint', style: { fontSize: 14, lineHeight: '22px' } },
        fmt(t('pluginPage'), { n: servers.length, m: servers.filter(entry => entry.enabled).length }))
    }

    return {
      /** Pure helpers, exposed for test/client.test.mjs. */
      internals: { splitCommandLine, parseImport, fromDraft, toDraft, compact, normalize, makeRef, sanitizeName, secretRefsOf, describeParameters },
      inject: ['slots', 'locale', 'remote', 'remote.credentials', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-custom-mcp: dictionaries')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.owner = PACKAGE
          style.textContent = CSS
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'dsh-custom-mcp: styles')
        const t = ctx.locale.bind(NS)
        const controller = new McpController(ctx)
        ctx.effect(() => () => { controller.dispose() }, 'dsh-custom-mcp: controller')
        ctx.effect(() => ctx.configForms.whileServed([ENTRY], () => {
          const disposers = [
            ctx.slots.inject('settings.section', () => ctx.slots.register({
              name: 'settings.section',
              id: 'custom-mcp',
              order: 16,
              label: () => t('nav'),
              locale: NS,
              inject: () => controller.face,
            }, McpSection)),
            ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
              name: 'plugins.bundle.config',
              key: PACKAGE,
              locale: NS,
              inject: () => controller.face,
            }, PluginCard)),
          ]
          return () => { for (const dispose of disposers) if (typeof dispose === 'function') dispose() }
        }), 'dsh-custom-mcp: settings page')
      },
    }
  },
})
