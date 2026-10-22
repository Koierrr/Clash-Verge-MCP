# Clash-Verge-MCP

A **zero-dependency** [MCP](https://modelcontextprotocol.io) server for **Clash Verge Rev / mihomo** on Windows.
Single file, no `npm install`, no build step — and it talks to the mihomo controller over its **Windows named pipe**,
so you don't have to open a TCP port or touch your Clash config.

```
MCP client ──stdio JSON-RPC──▶ server.mjs ──HTTP over named pipe──▶ mihomo core
```

## The problem this solves

Recent Clash Verge Rev builds **do not expose the mihomo controller over TCP** by default.
`external-controller` is left empty and the REST API is served on a **Windows named pipe** instead —
that is how the Verge desktop app itself talks to its core.

Worse, the pipe name in `config.yaml` is often **wrong**. Verge writes it from
`guard_external_controller_ipc()`, which unconditionally uses the *sidecar* name:

```rust
pub(crate) fn guard_external_controller_ipc() -> String {
    // "always use the current IPC path so the config matches the runtime path"
    sidecar_ipc_path()   // ← hardcoded sidecar; wrong when the core runs as a service
}
```

So you end up with two different names:

| Mode | Pipe name | Who launches the core |
|---|---|---|
| Sidecar (用户模式) | `\\.\pipe\verge-mihomo-sidecar-{release\|dev}-{owner_key}` | the Verge GUI, as your user |
| Service (服务模式) | `\\.\pipe\verge-mihomo-{production\|development}-{owner_key}` | `clash_verge_service` (LocalSystem, session 0) |

`owner_key` is the SHA-256 of your Windows user SID, so the suffix is the same in both —
only the middle segment differs. Any tool that trusts `config.yaml` breaks on service mode.

**This server doesn't trust the config file.** It enumerates `\\.\pipe\` for live `verge-mihomo*` pipes
and probes them, so it works in both modes and survives a core restart or a mode switch.

## Requirements

- Windows (named pipe transport). macOS/Linux work only with a TCP `external-controller`.
- Node.js ≥ 18
- Clash Verge Rev / Clash Verge running with the core up

## Install

```bash
git clone https://github.com/Koierrr/Clash-Verge-MCP.git
```

That's it. No dependencies.

## Self-check

```bash
node server.mjs --check
```

```
[clash-mcp] data dir: C:\Users\<you>\AppData\Roaming\io.github.clash-verge-rev.clash-verge-rev
[clash-mcp] channel: \\.\pipe\verge-mihomo-production-<hash>
[clash-mcp] core: {"meta":true,"version":"v1.19.32"}
core: v1.19.32 (mihomo)
mode: rule   mixed-port: 7897
groups: 29   nodes: 80
TUN: on
profile: Sufe
```

## Configure your MCP client

Generic stdio entry (use forward slashes or escape backslashes in JSON):

```json
{
  "mcpServers": {
    "clash": {
      "command": "node",
      "args": ["C:/path/to/Clash-Verge-MCP/server.mjs"]
    }
  }
}
```

**Claude Code**

```bash
claude mcp add clash --scope user -- node C:/path/to/Clash-Verge-MCP/server.mjs
```

**DSH (DeepSeek Harness)** — via the `dsh-mcp-connector` plugin:

```json
{
  "name": "Clash Verge Rev",
  "serverName": "clash",
  "transport": "stdio",
  "command": "C:\\Program Files\\nodejs\\node.exe",
  "args": ["C:\\path\\to\\Clash-Verge-MCP\\server.mjs"],
  "env": { "ELECTRON_RUN_AS_NODE": "1" }
}
```

> If you point `command` at an Electron binary (e.g. `DSH Desktop.exe`), the
> `ELECTRON_RUN_AS_NODE=1` env var is required, because DSH strips it from the inherited
> environment and the startup guard then fails. With a real `node.exe` it is ignored.

## Tools (14)

| Tool | Description |
|---|---|
| `clash_status` | Core version, mode, ports, controller channel, TUN / system-proxy flags, current profile |
| `clash_proxies` | List proxy groups; pass `group` for members + current selection |
| `clash_select` | Switch the active node of a selector group |
| `clash_delay` | Latency-test one node or a whole group (sorted by delay) |
| `clash_mode` | Get / set `rule` \| `global` \| `direct` |
| `clash_configs` | Read runtime config; `patch` to update fields |
| `clash_connections` | Active connections + cumulative traffic |
| `clash_close_connections` | Close one connection or all |
| `clash_rules` | List routing rules, filter by keyword |
| `clash_providers` | Proxy/rule providers: list, update, healthcheck |
| `clash_traffic` | Sample live up/down rate |
| `clash_logs` | Sample core logs |
| `clash_fakeip_flush` | Flush the fake-ip DNS cache |
| `clash_request` | Escape hatch: raw request to any controller endpoint |

## Environment variables

All optional — auto-discovery handles a standard Clash Verge install.

| Variable | Description |
|---|---|
| `CLASH_VERGE_DIR` | Clash Verge data dir (the one containing `config.yaml`) |
| `CLASH_PIPE` | Explicit named pipe |
| `CLASH_SECRET` | Controller secret (overrides the value read from config) |
| `CLASH_USE_TCP` | `1` to use the TCP `external-controller` instead of the pipe |
| `CLASH_CONTROLLER` | TCP address `host:port` |

## Troubleshooting

**`Cannot find a usable mihomo controller`**
The core isn't running. Start Clash Verge Rev and make sure the core is up.

**It connected but reads stale values**
`config.yaml` / `verge.yaml` are the *app side* and can drift from the core. Only the
`/configs` endpoint reflects the core's real state.

**`GET /configs` returns no `dns` section**
That's normal in service mode — the endpoint only exposes the general section.
Don't try to hot-reload a full config payload (`PUT /configs`) in service mode; it will drop the DNS section.
Use field-level `PATCH` instead (`clash_configs`).

**Node names must match exactly**, emoji included. Group names fall back to a
case-insensitive match, node names don't.

**Only `Selector` groups can be switched.** `URLTest` / `Fallback` groups pick their own node.

## Security

The server only talks to the local mihomo controller and makes no outbound network calls.
The controller secret is read at runtime and never written to disk. It can switch nodes,
change modes, and close connections — i.e. the same power as the Verge UI. Anything that
can spawn this process can control your proxy.

## 中文说明

一个**零依赖**的 MCP 服务器，让 AI 助手（Claude Code / Claude Desktop / DSH 等）直接控制本机的
**Clash Verge Rev / mihomo**：查看与切换节点、测延迟、切模式、看连接与规则、更新订阅等。

**为什么要自己发现管道名**：新版 Clash Verge Rev 默认不开 TCP 控制器，而是把 REST API 挂在
Windows 命名管道上。而 `config.yaml` 里写的管道名在**服务模式**下是错的——Verge 那段代码写死了
sidecar 的名字，实际内核由 Windows 服务拉起，用的是 `production` 那套命名。所以本服务器不读配置
文件里的管道名，而是扫描 `\\.\pipe\` 下真实存在的 `verge-mihomo*` 管道逐个探测，两种模式都能连，
内核重启或切换模式后也能自动恢复。

**安装**：`git clone` 即可，无需 `npm install`。用 `node server.mjs --check` 自检。

## License

[MIT](./LICENSE)
