# 本机 C2C 运行说明（Windows 11 / v2rayN）

适用工作区：`D:\workshop\职业教育-MOZI`。稳定运行状态为 **v2rayN TUN = OFF**，本地 HTTP 代理为 `http://127.0.0.1:10809`。不需要 Windows 全局代理环境变量或永久 TUN。

## 固定位置与配置

- Canonical C2C state dir：`D:\app_home\codex-with-chatgpt-state`。
- C2C network profile：`D:\app_home\codex-with-chatgpt-state\network-profiles\8b01a8558a23.json`（不在 MOZI 仓库）。
- cloudflared：`D:\app_home\cloudflared\cloudflared.exe`。
- C2C checkout：`D:\app_home\codex-with-chatgpt`；Quick-Service Relay：该目录下的 `relay.cjs`。
- profile 使用 `tunnelProtocol = http2`、`quickServiceRelay = true`、`noProxy = localhost,127.0.0.1,::1`。

Quick-Service Relay 仅监听 `127.0.0.1`，将 cloudflared 的 Quick Tunnel 分配请求经本地 HTTP 代理转发给 Cloudflare。C2C 在启动子进程时从 profile 构造代理环境；公网健康检查也使用该代理。不要把代理变量写入 Windows User/System 环境。

`C2C_STATE_DIR` 已设置为当前用户级环境变量，并由重启后的 Codex 自动继承。所有 C2C CLI 命令都必须使用这个 canonical 状态目录；不要把 `%LOCALAPPDATA%\codex-with-chatgpt` 或 Codex Package LocalCache 当作跨进程状态识别机制。

## 正常启动和验收

`c2c doctor` 会读取此工作区 profile，启动或复用 Bridge，检查本地 MCP/OAuth，按需启动 Relay 和 HTTP/2 Quick Tunnel，等待新域名解析与公网 `/health`，最后报告 Connector 是否需要更新。正常结果应为 `report.bridge.ok=true`、`report.mcp.ok=true`、`report.tunnel.ok=true`、`chatgptRepair.needed=false`。

在**全新 PowerShell 进程**中确认无需父进程代理变量：

```powershell
Remove-Item Env:HTTP_PROXY,Env:HTTPS_PROXY,Env:ALL_PROXY,Env:http_proxy,Env:https_proxy,Env:all_proxy -ErrorAction SilentlyContinue
Test-NetConnection 127.0.0.1 -Port 10809
$env:C2C_STATE_DIR
node 'D:\app_home\codex-with-chatgpt\bin\c2c.js' doctor -w 'D:\workshop\职业教育-MOZI' --json
```

在 v2rayN 配置中确认 `TunModeItem.EnableTun = false`；同时确认 v2rayN 正在运行且 `127.0.0.1:10809` 可连接。完全重启 Codex 后再执行上述命令，才是重启验收。

## 地址变化后的 Connector

Quick Tunnel URL 可能在重启后变化。仅当 `doctor` 给出新的 `chatgptRepair.mcpUrl` 且 `chatgptRepair.needed=true`，才在 ChatGPT 中**删除**本工作区的旧 Connector 定义，按原名 `Codex with ChatGPT · 职业教育-MOZI` 和新 URL 创建 OAuth Connector；“卸载”不是“删除”。在授权页出现后运行 `c2c pair` 并完成配对。显示已连接后运行：

```powershell
node 'D:\app_home\codex-with-chatgpt\bin\c2c.js' connector-confirm -w 'D:\workshop\职业教育-MOZI' --mcp-url '<doctor 返回的新 mcpUrl>' --json
node 'D:\app_home\codex-with-chatgpt\bin\c2c.js' doctor -w 'D:\workshop\职业教育-MOZI' --json
```

只操作 MOZI Connector。回到原 ChatGPT 项目会话验证 `workspace_info`；若旧会话仍绑定已删除 Connector，则在**同一个 ChatGPT 项目**中新开对话并验证。

## 内置浏览器与自动传递

Codex 的新 `node_repl` 会话需要先按当前 bundled Browser skill 动态定位并 import `scripts/browser-client.mjs`，调用 `setupBrowserRuntime({ globals: globalThis })`，取得 `agent.browsers.get('iab')`。不写死 Browser 插件版本，不使用 CUA，也不让用户复制 INIT/PLAN。

最小只读测试：由 Codex 在内置 ChatGPT 项目对话中要求使用上述 Connector 调用 `workspace_info`；确认返回 `workspaceName=职业教育-MOZI` 和正确的 workspace ID。随后 Codex 自动发送 `[C2C] STATE: INIT`，核对消息已出现在页面中，再自动读取 ChatGPT 的同一 `TASK_ID`、`STATE: PLAN` 回复。整个测试不修改 MOZI 文件。

验收结论：C2C 在 v2rayN TUN OFF、无全局 proxy env 的条件下，通过 C2C-local network profile 和统一 `C2C_STATE_DIR` 正常工作。
