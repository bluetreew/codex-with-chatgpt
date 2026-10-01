# Troubleshooting

First identify the failing layer. For Bridge/MCP/OAuth/Tunnel symptoms, run:

```
c2c doctor
```

It checks Node, workspace, Bridge, MCP, OAuth and Tunnel, and may repair
infrastructure when its own checks require it. A browser-control or Project
chat-binding failure alone is not evidence to restart the Bridge or Tunnel;
use the IAB cases below and preserve a healthy Connector.

## Common situations

### "Bridge 未运行"
`c2c start` (or let doctor do it). Bridge logs:
`c2c logs`, or verbose: `c2c logs --verbose`.

If doctor says the bridge state is **uncertain** (无法确认), do not start a
second bridge and do not Delete the ChatGPT connector. Wait and run doctor
again. The local process may still be running.

### Everything was quit and ChatGPT can no longer connect
Quitting Codex / the terminal stops the public address. The next `c2c doctor`
starts a new address and sets `chatgptRepair.needed`. The Skill should tell the
user that the old address expired, then **Delete** THIS workspace's
connector (`chatgptRepair.connectorName`) and create it again with the new
address (never click Reconnect — the old URL is dead). Other workspaces keep
their own connectors so two projects can stay connected at once.

Mint the pairing code only when the ChatGPT Authorize form is on screen
(`c2c pair`). After the connector is recreated, doctor being green is not
enough: the saved ChatGPT conversation must pass `workspace_info` again. If
that old chat still cannot read the workspace, open a new chat in the same
Project (or switch long-chat) and continue there.

Fixed ChatGPT pages for first-time setup and later repair (do not hunt the UI):

- Developer mode: https://chatgpt.com/#settings/Security
- Plugins hub (manage existing connectors): https://chatgpt.com/plugins
- Add a connector:
  https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins

### Tunnel URL unreachable / ChatGPT says the connector is broken
Same as above: `c2c doctor`, then Delete + recreate THIS workspace's
connector if `chatgptRepair.needed`. Mint a pairing code with `c2c pair` only
when the Authorize form is on screen.
If this workspace uses a stable hostname, doctor sets `namedRepair` instead —
re-login to Cloudflare (`c2c tunnel login`) and doctor again. Do not Delete
the connector; the address did not change.

### I have a Cloudflare domain and want a stable hostname
During first-time setup (or the next coding session, once), say you have a
Cloudflare account and give the domain. Codex opens a browser for Cloudflare
login, then keeps `c2c-<project>.your-domain.com`. To stay on the temporary
address, say you do not have a domain. Switching later: tell Codex you want
the stable hostname; it runs `c2c tunnel choose --mode named --zone <domain>`.

### "配对码无效/过期"
Pairing codes are one-time and expire after ~5 minutes. Generate one only
when the ChatGPT Authorize page is ready:

```
c2c pair
```

Older codes become invalid immediately. Do not mint a code during `c2c doctor`.

### Temporary address keeps dropping on a UDP-filtered network
cloudflared defaults to QUIC. If the tunnel reconnects over and over on a
corporate network, set `C2C_TUNNEL_PROTOCOL=http2` and restart the bridge.
Leave it unset to keep cloudflared's default.

### ChatGPT gets 401 on every tool call
The access token expired and refresh failed (e.g. after `c2c unpair` or a
long offline period). Delete THIS workspace's connector if the address also
changed; otherwise run Authorize again in ChatGPT and enter a fresh pairing
code. Never use Reconnect when the public address has been replaced.

### cloudflared is not installed
macOS: `brew install cloudflared`
Windows: `winget install Cloudflare.cloudflared`
Linux: see Cloudflare's package instructions.
The Skill installs this automatically during setup.
If cloudflared is installed in a custom location that is not on `PATH`, set
`C2C_CLOUDFLARED_PATH` to the executable's absolute path before running `c2c`.

### Every new Codex chat “repairs” the connection / cannot write logs
The C2C state directory lives outside the project (macOS:
`~/Library/Application Support/codex-with-chatgpt`; Windows:
`%LOCALAPPDATA%\codex-with-chatgpt`). Codex's default sandbox cannot write
there, so each new chat looks like a health-check failure.

`c2c setup`, `c2c doctor` and `c2c sandbox-allow` add that directory to
`[sandbox_workspace_write].writable_roots` in `~/.codex/config.toml`
(`%USERPROFILE%\.codex\config.toml` on Windows). After that, later chats
do not need elevation.

## Independent health layers

Check these separately:

- Connector → workspace (`workspace_info` identity)
- IAB/browser page control
- The current Codex thread's expected Chat URL, actual tab, and delivery

`workspace_info PASS` validates only Connector → workspace. It does not prove
IAB control, current-thread binding, or message delivery.

### Official Browser Runtime cannot control the IAB

Use the official OpenAI Browser Runtime as the C2C browser-health authority.
Bootstrap the active bundled browser-client.mjs through node_repl with
setupBrowserRuntime({globals: globalThis}), then obtain the existing IAB with
agent.browsers.get("iab"). A previous CUA metadata result or CUA timeout does
not establish Browser Runtime health and is never a Bridge failure.

If bundled-client discovery or page control fails, report
IAB_CONTROL_UNAVAILABLE with the exact failure. Keep healthy Connector,
endpoint, Bridge, and Tunnel state unchanged. Do not install or use an
unofficial browser bridge. Re-bootstrap after a kernel
reset and reacquire the existing exact-URL tab before deciding it is lost.

### Fresh Codex session has an empty IAB tab list

An official Browser Runtime bootstrap can succeed and provide an IAB whose tab list is empty in a new Codex session. This is a new session-scoped browser context; it does not prove browser failure or that the existing ChatGPT conversation disappeared.

Resolve an authoritative expectedChatUrl first. Long-chat may use session.url. Project mode needs an explicit URL for this Codex conversation or one previously verified in this conversation; workspace-level session.url alone is insufficient. Without a proven Project thread URL, stop with THREAD_BINDING_UNKNOWN.

When the current IAB has no tabs and expectedChatUrl is authoritative, create exactly one tab, navigate it to expectedChatUrl, verify the actual URL, and confirm the composer is present and enabled. A new browser tab reopens the existing conversation; it does not create a ChatGPT conversation.

After a same-session Node REPL reset, reacquire the existing IAB and tab instead; do not call tabs.new().

### Send timed out after Enter

Treat the send result as unknown, not failed. Re-bootstrap the official
browser-client, reacquire the same IAB and the tab whose actual URL equals
`expectedChatUrl`, then inspect the same conversation for the exact outbound
text or unique marker. If present, it is committed: do not resend. Only when
the conversation is fully loaded and the exact item is definitely absent may
one controlled retry be considered. If presence is uncertain, stop without
retrying. For INIT/EXECUTED/HANDOFF/REVIEW/DONE/probe, check the unique
`TASK_ID` + `STATE` + `ITERATION` marker before a send.

### Project mode shows a different chat than `session.url`

Project mode stores `session.url`, task ID and checkpoint at workspace scope.
They are last-saved pointers, not proof of the current Codex thread's binding.
Use only a URL explicitly supplied for this thread or verified in this
Codex conversation. If none is known, open a chat from the expected
`conversation.projectUrl`; do not silently navigate to or overwrite
`session.url`. If ownership remains unclear, stop with
`THREAD_BINDING_UNKNOWN`.

### Port already in use
Handled automatically: an existing healthy bridge for the same workspace is
reused; anything else makes the bridge pick a free port. Configuration follows
automatically.

### Reading a file returns ACCESS_DENIED_SENSITIVE_FILE
Working as intended: `.env`, keys, credentials and anything matched by
`.c2cignore` are never readable through ChatGPT. `.env.example` is allowed.

### I cannot see Projects in the ChatGPT sidebar
Hover **Chats** /「聊天」, click the … that appears, and choose
**Organize by project** /「按项目整理」. Then create a project named after
this workspace, with **project-only memory**. Tell Codex「好了」when the
collection page is open (`https://chatgpt.com/g/g-p-…/project`).

### This workspace opened the wrong ChatGPT Project
Do not pick another project by name automatically. Open the collection that
matches this workspace and tell Codex「已找到」, or say you want the old
long-chat instead. Each workspace has its own Project and its own connector.

### Completely stuck

Use a full stop/setup cycle only when C2C infrastructure checks prove the
Bridge or Tunnel itself cannot be recovered. It recreates the Bridge, Tunnel,
and pairing session from scratch. A healthy infrastructure with an IAB-only
or thread-binding failure does not qualify; follow the browser and Project
cases above. Existing authorizations stay valid unless you also ran
`c2c unpair`.

```
c2c stop
c2c setup
```
