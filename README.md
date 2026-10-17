# dsh-custom-mcp

在 DeepSeek Harness 的「设置」里管理 MCP 服务器：添加、编辑、开关、删除、查看连接状态和工具列表，全部即时生效，不用手改 `cordis.yml`，也不用重启。

## 插件界面

<img width="1608" height="1032" alt="image" src="https://github.com/user-attachments/assets/476d6986-f43d-4764-9221-22b4b030652c" />

<img width="1668" height="1420" alt="image" src="https://github.com/user-attachments/assets/e1f54b3e-3c3d-4382-a9f7-aaf6566b4bfa" />


支持显示mcp远程工具描述

<img width="1646" height="1102" alt="image" src="https://github.com/user-attachments/assets/8440ad0e-6b90-4f6d-8e43-d95c799bfff4" />

支持点击mcp禁用某个工具

<img width="1878" height="816" alt="image" src="https://github.com/user-attachments/assets/0f508ff8-0af9-4842-a8f1-888096ec7d1d" />



## 功能

- **设置侧栏新增「MCP 服务器」页**（位于「内置插件」之后）。
- **每个服务器一个开关**：关闭即断开并移除其工具；打开即连接。
- **单个工具开关**：展开服务器，点击工具即可启用 / 禁用；禁用的工具不提供给模型，切换即时生效且不重连。鼠标悬停在工具上显示完整工具名、说明和参数（类型、是否必填、可选值、默认值）。
- **添加 / 编辑**：本地命令（stdio）或远程 Streamable HTTP；参数、环境变量、请求头、工作目录、工具调用超时。命令栏可以直接粘贴整行 `npx -y @scope/server`，保存时自动拆参数。
- **实时状态**：已连接 · N 个工具 / 连接中 / 正在重试（第 n/10 次）/ 连接失败，附最近错误、工具名列表和最近日志；一键「重连」。
- **密钥不落配置文件**：环境变量和请求头可勾选「密文」，值存入 DSH 凭据库，配置里只写 `${secret:MCP_…}`。名称含 KEY / TOKEN / SECRET / AUTH 等字样时自动勾选。删除服务器时一并清理它独占的凭据。
- **导入 JSON**：直接粘贴 Claude Desktop / Cursor / Claude Code 的 `{"mcpServers": {...}}` 或 VS Code 的 `{"servers": {...}}`；`${VAR}` 自动转成 `${env:VAR}`，密钥自动移入凭据库，`disabledTools`（Roo Code、Windsurf 等）原样保留。
- **桌面版 PATH 修正**：从 Dock 启动的桌面版 Host 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，`npx`、`uvx`、`docker` 都找不到。插件启动时读取一次登录 shell 的 PATH，交给 stdio 服务器，并把裸命令解析为绝对路径；找不到时直接提示，而不是重试十次。

## 工作原理

```
设置页（lib/client.js）
  └─ ctx.configForms.get('custom-mcp').set('servers', [...])   ← 官方设置服务：校验 + 写入 profile 的 cordis.patch.yml
Host 插件（lib/index.js）
  ├─ servers 是 volatile 字段 → loader/volatile-update → 对比差异
  ├─ 每个启用的服务器 = 一个官方 @deepseek-ai/dsh-mcp-client 子实例（ctx.plugin）
  │    工具命名、重连退避、资源、图片结果与手写 MCP 行完全一致
  ├─ 子实例看到的 ctx.tools 是一道闸门（ctx.extend）：记下每个工具的说明和参数，
  │    只把未禁用的转交给真正的工具注册表；切换单个工具只增删注册，不碰连接
  ├─ 只重启配置变化的那一个；开关 / 备注 / 单个工具开关不触发重连
  ├─ 解析 ${secret:REF}（凭据库）与 ${env:VAR}（Host 环境）
  └─ GET  /dsh-custom-mcp/status   状态（经 Host 的请求鉴权门；不含任何密钥值）
     POST /dsh-custom-mcp/restart  重连（另需同源 + JSON content-type）
```

状态来自 `dsh-mcp-client` 自己的日志叙述（`mcp-client(<name>): …`），插件用 logger exporter 订阅并解析，不修改官方客户端。

## 安装

需要 DSH 0.2（`@deepseek-ai/dsh-mcp-client` 随 `dsh-base` 提供）。仓库里已附带构建好的 `lib/`，从 GitHub 安装不需要构建权限。

**命令行 dsh**：

```bash
dsh plugin --profile web add github:Fleey/deepseek-harness-custom-mcp
```

或克隆后安装本地目录：

```bash
git clone https://github.com/Fleey/deepseek-harness-custom-mcp.git
```

```bash
dsh plugin --profile web add ./deepseek-harness-custom-mcp
```

**桌面版（DSH NEXT，macOS）**——先退出桌面版，再用桌面版自带的插件命令装进 `desktop` profile（该命令来自桌面版的 `lib/plugin-cli.js`，与 `dsh plugin` 同一实现，尚未在桌面版上实测）：

```bash
ELECTRON_RUN_AS_NODE=1 DSH_HOME="$HOME/.dsh" "/Applications/DSH NEXT.app/Contents/MacOS/DSH NEXT" --expose-internals "/Applications/DSH NEXT.app/Contents/Resources/app/lib/plugin-cli.js" desktop add /path/to/deepseek-harness-custom-mcp
```

重新打开桌面版 → 设置 → MCP 服务器。卸载把 `add <路径>` 换成 `remove dsh-custom-mcp`。

也可以 `pnpm pack` 后安装生成的 `dsh-custom-mcp-0.2.1.tgz`。

## 配置

页面写入的就是这一行（位于 profile 的 `cordis.patch.yml`），也可以手改：

```yaml
- id: custom-mcp
  name: dsh-custom-mcp
  config:
    servers:
      - name: github
        enabled: true
        transport: stdio
        command: npx
        args: [-y, '@modelcontextprotocol/server-github']
        env:
          GITHUB_PERSONAL_ACCESS_TOKEN: ${secret:MCP_GITHUB_ENV_GITHUB_PERSONAL_ACCESS_TOKEN}
      - name: docs
        enabled: false
        transport: streamable-http
        url: https://example.com/mcp
        headers:
          Authorization: ${secret:MCP_DOCS_HDR_AUTHORIZATION}
        disabledTools: [delete_page]   # 不提供给模型的工具
    # 以下为可选的非即时字段（修改后插件会重载）
    loginShellPath: true        # 给 stdio 服务器补登录 shell 的 PATH
    loginShellTimeoutMs: 8000
    logLines: 40                # 每个服务器保留的日志行数
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `name` | 必填 | 工具命名空间，`[A-Za-z0-9_-]{1,32}`，工具名为 `mcp__<name>__<tool>` |
| `enabled` | `true` | 开关 |
| `transport` | `stdio` | `stdio` 或 `streamable-http` |
| `command` / `args` / `env` / `cwd` | — | stdio；`cwd` 支持 `~` |
| `url` / `headers` | — | Streamable HTTP |
| `toolCallTimeoutMs` | `60000` | 单次工具调用超时 |
| `disabledTools` | `[]` | 不提供给模型的工具，写 `mcp__<name>__` 之后的部分；设置页点击工具即可增删，修改不触发重连 |
| `description` | `''` | 备注，仅在设置页显示 |

字符串值里可以写 `${secret:REF}`（读 DSH 凭据库）和 `${env:VAR}`（读 Host 进程环境）。缺少引用的值时，该服务器显示「配置有误：缺少 凭据 REF」且不启动；之后在凭据库补上，服务器会自动启动。

## 限制

- 不支持旧版 SSE 传输（官方客户端只有 stdio 和 Streamable HTTP）；导入 `type: sse` 时按 Streamable HTTP 处理并提示。
- 设置侧栏的图标目前只能是默认齿轮——`settings.section` slot 还不接受图标。
- 只在本机地址（loopback / 桌面版）上可写，与官方设置页相同。
- 与手写在 `cordis.yml` 里的 `dsh-mcp-client` 行共用命名空间；同名时后加载的一个报错。
- 单个工具开关要在服务器已连接时操作（工具列表来自服务器）；也可以直接在配置里写 `disabledTools`，连接时生效。

## 开发

```bash
pnpm install
pnpm build        # lib/index.js（esbuild 打包 src/）+ lib/client.js（直接复制 client/client.js）
pnpm typecheck
pnpm test         # 客户端纯函数、Host 纯函数、以及对真实 dsh-mcp-client 的集成测试
```

集成测试用桌面版自带的运行时（`/Applications/DSH NEXT.app`，可用 `DSH_RUNTIME` / `DSH_NODE` 覆盖），起一个测试用 stdio MCP 服务器（`test/fixtures/fake-mcp-server.mjs`），覆盖：连接、密钥注入、`~` 展开、登录 shell PATH、开关、单个工具开关（不重连）与工具说明 / 参数、凭据后到自动启动、重连路由鉴权、状态不泄露密钥、删除与卸载清理。

`scripts/dev-web.sh` 在隔离的 `DSH_HOME`（默认 `/tmp/dcm-home`）里建 `mcpdev` profile、link 本目录并启动 Web 版（端口 3099），不碰 `~/.dsh`。
