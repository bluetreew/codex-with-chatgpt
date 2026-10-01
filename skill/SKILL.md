---
name: codex-with-chatgpt
description: >
  Use ChatGPT (web) as the planning and review brain for Codex coding sessions,
  while Codex keeps full execution ownership. Use when the user says
  "使用 Codex with ChatGPT ..." / "Set up Codex with ChatGPT" / "用 ChatGPT 规划",
  when they ask to connect ChatGPT to the current workspace, disconnect it,
  or run a task through the ChatGPT planning loop.
---

# Codex with ChatGPT

ChatGPT thinks. Codex works.

You (Codex) own execution: editing, shell, git, tests, recovery.
ChatGPT owns high-level reasoning: understanding, planning, review, debug strategy.
The C2C Bridge gives ChatGPT read-only MCP access to the current workspace, so
control messages between you and ChatGPT stay tiny (< 1 KB) — ChatGPT pulls
whatever data it needs by itself.

**Golden rules**

1. NEVER paste file contents, diffs, or logs into ChatGPT. ChatGPT reads them through MCP.
2. NEVER show the user technical internals (MCP, OAuth, PKCE, tunnel, ports, localhost).
   Speak in terms of "连接 ChatGPT / 安全连接 / 配对". The only exception is the
   **guided manual ChatGPT setup** below: expose only the exact settings
   field labels/values the user must enter, without explaining internals.
3. The pairing code is the ONLY credential you may ever type into a browser.
   Never touch OAuth tokens, cookies, or session storage.
4. If something fails, run `c2c doctor` and repair silently. Only involve the user
   for logins, CAPTCHA, 2FA, explicit consent screens, or **guided manual
   ChatGPT setup** below — and then give them ONE action.
   **C2C CHECK exception:** `C2C CHECK` is read-only. It never repairs,
   restarts, re-pairs, recreates a Connector, or changes session/project state;
   report the failed layer and recovery action instead.
   Before the first ChatGPT connection on this machine, `c2c prefs --json`:
   - `setupMode` missing: tell the user exactly `setupChoicePrompt`, wait for
     「1」or「2」, then `c2c prefs set --setup-mode auto|manual --json`.
     Do not start ChatGPT configuration until they answer. Do not guess.
   - `setupMode` is `manual`: skip automatic ChatGPT settings. Use guided
     manual from the start (chosen, not a failure).
   - `setupMode` is `auto`: automatic browser setup. Two explicit failures of
     the same configuration step after repair then enter guided manual.
     A browser/js timeout, a page still loading/generating, or waiting for
     user login/2FA does NOT count as a failure. Do not change the saved
     `setupMode` when falling back.
   `developerModeEnabled: true` means skip `#settings/Security` until a
   connector create fails because developer mode is required. Then open
   that page, enable it, and `c2c prefs set --developer-mode --json`.
   These prefs are for this machine, not per workspace. Do not ask again
   on reconnect or a second repo. A new computer (empty prefs) asks/checks
   once.
5. ALWAYS use the built-in in-app browser (iab) for every ChatGPT step.
   Follow **In-app browser (ChatGPT)** below. NEVER Computer Use (no
   screenshot-click). NEVER launch or control a third-party/external browser
   (Chrome, Safari, Edge…), and never use `open <url>` to hand off to one.
   - The ONLY exception: the user explicitly says the Cloudflare login must use
     their own browser session — that single Cloudflare login step may go through
     their browser; everything else stays in the built-in browser.
   - If the user asks to run ChatGPT in their own browser, refuse politely and
     explain: "Codex 需要持续调用 ChatGPT 和配置连接，这会频繁操作页面，可能影响
     你浏览器的正常使用。ChatGPT 只能跑在内置浏览器里。" Only if the user replies
     with an explicit "我愿意承担影响" may you proceed in their browser; otherwise
     keep ChatGPT in the built-in browser, every time they ask.
6. Conversation reuse depends on `c2c session --json` → `conversation.mode`
   (see Conversation management). Do not invent a second mode.
   - **long-chat** (legacy session file, or the user opted out): ONE ChatGPT
     conversation per workspace. Never silently start a new chat.
   - **project** (new workspaces, or an existing workspace that opted in):
     ONE ChatGPT Project (collection) per workspace, with a separate chat
     for each Codex conversation. A thread reuses only a Chat URL verified
     for THIS Codex conversation. The workspace-level `session.url` is not
     evidence that a Project chat belongs to this thread. A new Codex
     conversation opens a new chat from the Project collection page — never
     `goto` `https://chatgpt.com/` to create it or inherit another thread's chat.
   Each workspace also has exactly ONE ChatGPT connector. Do not create a
   second connector for the same workspace. Other workspaces may have their
   own connectors — never edit those.
7. After first-time setup, never ask the user to approve writing C2C's local
   settings directory. Run `c2c sandbox-allow --json` (idempotent). If it fails
   with EPERM / Operation not permitted, request elevated permissions and retry
   ONCE. After `{ "alreadyAllowed": true }` or `{ "added": true }`, stay silent.
8. ChatGPT pages: only the URLs in **In-app browser (ChatGPT)**. Never start
   from chatgpt.com and click through menus.
9. **Doctor gate.** After `c2c doctor --json`, do not `goto` ChatGPT and do not
   send `[C2C]` until local is green — except the reconnect settings pages when
   `chatgptRepair.needed` is true. Not green:
   - `report.bridge.ok` is not true
   - `report.mcp.ok` is not true (unauthenticated local `/mcp` must be 401)
   - sandbox / state-dir write failed (EPERM)
   - this workspace used to have a public URL and the tunnel is down
   - `chatgptRepair.needed` is true (fix the connector first, then doctor again)
   - `namedRepair.needed` is true (user must log in to Cloudflare, then doctor again.
     Do not Delete the ChatGPT connector — the address did not change)
   - `report.bridge` says 状态无法确认: the local bridge may still be running.
     Do not `c2c start`, do not Delete the connector, do not treat it as
     `chatgptRepair`. Wait and run doctor again.
   If doctor is already green and `chatgptRepair.needed` is false, do not
   `c2c restart`, do not start a second tunnel, and do not Delete the
   connector. ChatGPT/IAB-only errors are not permission to churn the
   public address.
   A ChatGPT-side 401 after a sent message is different: repair then, do not
   treat it as permission to skip this gate next time.

## In-app browser (ChatGPT)

### Official Browser Runtime (primary)

C2C's primary ChatGPT control surface is the official OpenAI Browser Runtime.
The bundled browser-client.mjs is its standard bootstrap mechanism.
Computer Use / CUA is not required by C2C and is not a recovery control path.

For every ChatGPT page operation, ensure one verified Browser Runtime agent and
its IAB browser:

1. Reuse an already verified runtime and iab handle in this Codex session.
2. Otherwise discover the active official bundled Browser plugin under
   .codex/plugins/cache/openai-bundled/. Resolve exactly one
   scripts/browser-client.mjs; if none or multiple candidates remain,
   fail closed with IAB_CONTROL_UNAVAILABLE and the discovery details.
   Never hardcode a plugin version or install/replace the browser service.
3. Import that module through node_repl, call
   setupBrowserRuntime({globals: globalThis}), and retain the returned agent.
4. Require agent.browsers.list() to expose type == "iab", then obtain it
   with agent.browsers.get("iab"). If metadata.codexSessionId is
   available, verify it matches the current Codex session before control.
5. Use the official Browser Runtime as the authority for browser health.
   A Browser Runtime control failure is IAB_CONTROL_UNAVAILABLE; it is not
   evidence of Bridge, MCP, Connector, or Tunnel failure and never authorizes
   changes to those healthy layers.

If the Node REPL resets or a handle becomes stale, re-bootstrap the same
official client, reacquire the existing IAB, list its tabs, and bind the
existing tab whose actual URL equals expectedChatUrl. A reset does not prove
that the IAB or tab was lost. Reuse the existing tab; do not create another
ChatGPT tab or conversation.

Official skill: `control-in-app-browser`. These C2C rules override defaults
that close the tab, hide the window, or stall on the settings page.

1. **Surface.** Once per Codex session: bootstrap the active bundled Browser
   plugin's `scripts/browser-client.mjs` as described above, then use the
   returned agent to call `agent.browsers.get("iab")`. Reuse `iab`. Do not
   re-read `documentation()` if it is already bound. Never `getDefault()`,
   `getForUrl()`, or Computer Use.

2. **Tab lifecycle is per Codex session.** A Codex session uses one IAB and one reusable ChatGPT tab. Reuse an existing exact-URL tab before navigating; never create another tab when a suitable tab exists.

   **Same-session handle reset:** A Node REPL reset or stale handle invalidates JavaScript handles, not the Codex session, IAB, or tab. Re-bootstrap the same official client, get the same IAB, list tabs, and bind the existing tab whose actual URL equals expectedChatUrl with `tabs.get(id)`. This path MUST NOT call `tabs.new()`.

   **Fresh Codex session:** A newly started Codex session may receive a new IAB whose tabs.list() is empty. An empty tab list while the IAB exists means Browser Runtime health is PASS and TAB_INITIALIZATION_REQUIRED; it is not IAB_CONTROL_UNAVAILABLE or TARGET_TAB_DISCOVERY failure by itself.

   Resolve expectedChatUrl before navigating. In long-chat, session.url is authoritative. In Project mode, only an explicit URL for THIS Codex conversation or a URL previously verified for THIS conversation is authoritative; workspace-level session.url alone is insufficient. If Project mode has no authoritative thread URL, stop with THREAD_BINDING_UNKNOWN and do not call goto.

   Choose the tab in this order:
   - If a tab already has the exact expected URL, bind it with `tabs.get(id)`.
   - If there is no exact match but exactly one reusable ChatGPT tab exists, bind it with `tabs.get(id)`, reuse it, and navigate that tab to expectedChatUrl.
   - If the current session is fresh and the IAB tab list is empty, create exactly one tab with tab = await iab.tabs.new(), then await tab.goto(expectedChatUrl).
   - If several non-matching tabs make the target ambiguous, stop and resolve the tab selection; do not create another tab.

   After navigation, require await tab.url() == expectedChatUrl and verify the Chat composer is present and enabled before sending. tabs.new() creates a browser tab for this Codex session; it does not create a ChatGPT conversation. Navigating to an existing expectedChatUrl reopens that existing conversation. Creating a ChatGPT conversation requires using the Project collection New chat composer. Report a tab-control failure only if tabs.new(), navigation, actual-URL verification, or composer observation fails; preserve the exact failed stage.
3. **Foreground + keep (standby).** Right after opening or claiming the tab:
   - `await (await iab.capabilities.get("visibility")).set(true)` — first-time
     setup and ChatGPT chatting stay in front of the user so they can watch.
   - `await tab.markHandoff()` immediately, then again at the start and end of
     every turn. After setup succeeds or the C2C chat is open, also
     `await tab.markDeliverable()`.
   Never close this tab. Finished, waiting for the user, or timed out: leave it
   marked (standby). Do not let default turn cleanup close it.

4. **URLs only** (same tab, `goto` — never hunt menus):
   - 开发人员模式: `https://chatgpt.com/#settings/Security`
     (skip when `c2c prefs --json` has `developerModeEnabled: true`)
   - 插件总管: `https://chatgpt.com/plugins`
   - 加插件: `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
   - 新对话 (long-chat only, and only if no saved chat): `https://chatgpt.com/`
   - Saved C2C chat: long-chat uses `conversation.chatUrl` / `session.url`.
     Project mode uses only a URL verified for THIS Codex conversation;
     `session.url` alone is never the current thread's target.
   - Saved Project collection: `conversation.projectUrl`
     (`https://chatgpt.com/g/g-p-…/project`)
   Never click Reconnect / Refresh on an existing connector. The old address is
   dead and that page hangs on "This site cannot be reached". When the address
   changed: Delete THIS workspace's `connectorName` only, then create it again
   via the 加插件 URL (same name, new Server URL). Do not put that public
   address into Project instructions — write the connector **name** only.

5. **Do not wait for 8 tools** on the settings page. "Connected" / authorize
   success / pairing accepted is enough. Confirm tools in the conversation with
   `workspace_info`.

6. **Batch.** Fill a known form in one Playwright / `js` script when you can.
   After an action, one cheap DOM check. Do not screenshot-poll.

7. **One conversation, Chat mode.** The first ChatGPT chat is the C2C
   conversation. Chat and Work (聊天 / 工作) are separate: a Work conversation
   cannot become Chat. On every NEW conversation, if a Chat/Work switcher is
   visible (often top-left), confirm **Chat** is selected before the boot
   prompt. If it is Work, do not continue there — Switch to a new Chat
   conversation (HANDOFF). If no switcher is visible, do not hunt menus; continue.
   Send the boot prompt and the workspace_info check in that Chat conversation.
   Confirm the reply names the current workspace **before** saving or replacing
   the session URL. If validation fails, keep the old saved URL. Do not open a
   throwaway verify chat and later another C2C chat.

   A collection or chat page that shows only `Retry` / `重试` is a navigation
   error, not generation and not a pairing failure. Reuse the same iab tab.
   Try Retry once. If it stays Retry-only, `goto` the last working chat URL
   from this thread (or `session.url` if that is the only saved chat), then
   click the on-page `Open … project` / `打开“… ”项目` link — that same-site
   hop is allowed. Do not treat the URLs-only rule as forbidding this link.
   On the collection, require the project chat list and new-chat composer
   before continuing. Keep the old saved URL/checkpoint until the replacement
   chat passes workspace_info. Do not `session clear`. Do not use Computer Use.

8. **Wait for a ChatGPT reply (do not hold one long browser wait).** After you
   send INIT, EXECUTED, boot, or the workspace_info check: `markHandoff`, keep
   the tab foreground, and stay in this same task. Do not `waitFor` 5 minutes
   and do not screenshot-poll. Every 20–30 seconds, one cheap DOM check:
   - still generating → wait again (do not type, do not resend);
   - `STATE: PLAN` / `DONE` / `BLOCKED` / the verify workspace name → read it
     and continue the existing protocol;
   - visible error → repair; do not start a new chat.
   A browser/js timeout is not failure. Claim the same tab, read the page, keep
   standby. If ChatGPT is still thinking, keep polling. Never open a second
   tab and never resend INIT/EXECUTED just because a wait timed out.

### Send gate, timeout recovery, and health layers

Before sending any message to ChatGPT, require all three checks:

1. `expectedChatUrl` comes from an explicit URL supplied for this Codex
   conversation or from a URL previously verified in THIS conversation.
   In long-chat, `session.url` may supply it. In project mode, the
   workspace-level `session.url` is never sufficient.
2. Obtain control of the target with the official `iab` browser-client and
   require `actualTabUrl == expectedChatUrl`. A `listTabs()` entry or URL
   metadata is not a controlled page.
3. Confirm the Chat composer is present and enabled.

If any check fails, do not send. For a project-mode URL with no proven
thread owner, report `THREAD_BINDING_UNKNOWN`. Connector health, a Project
name, a tab title, `listTabs()` metadata, and `workspace_info PASS` cannot
replace the exact URL or composer checks.

A timeout or kernel reset after pressing Send/Enter makes the side effect
unknown, not failed. Re-bootstrap the official browser-client, reacquire the
same `iab`, list tabs, and bind the existing tab whose actual URL equals
`expectedChatUrl`. Inspect that conversation for the exact outbound message
or marker. If it is present, treat the send as committed and do not resend.
Only if the target conversation is loaded and the exact message is definitely
absent may one controlled retry be considered; if the outcome is ambiguous,
stop without retrying. Before INIT, EXECUTED, HANDOFF, REVIEW, DONE, or a
probe, check for its unique `TASK_ID` + `STATE` + `ITERATION` or
user-specified marker; an existing marker means do not duplicate it.

Report these health layers separately:

- Connector → workspace (`workspace_info` identity)
- IAB/browser page control
- This Codex thread's Chat binding, send state, and delivery

`workspace_info PASS` proves only Connector → workspace. It does not prove
that IAB is controllable, the correct thread's chat is open, or a message
was delivered.

## Locations

### C2C-local network profile

If the workspace has a network profile in C2C's OS state directory, the CLI
automatically loads it for `setup`, `start`, `restart`, and `doctor`. Do not set
proxy variables in the Codex shell or Windows User/System environment. Do not
ask the user to repeat proxy parameters after a restart. Inspect the profile
with `c2c network -w <workspace> --json`; if absent on this machine, configure
it once with `c2c network -w <workspace> --proxy-url <local HTTP proxy> --cloudflared-path <absolute executable path> --json`.
The profile applies only to C2C child processes and public tunnel checks.
Treat `C2C_PROXY_UNAVAILABLE`, `QUICK_SERVICE_RELAY_FAILED`,
`QUICK_TUNNEL_ALLOCATION_FAILED`, `QUICK_TUNNEL_DNS_NOT_READY`,
`CLOUDFLARED_EDGE_FAILED`, and `PUBLIC_HEALTH_FAILED` as distinct diagnostics.
Only update the ChatGPT connector after `doctor` has a new public `mcpUrl` and
`chatgptRepair.needed` is true.
After the replacement is Connected and paired, run
`c2c connector-confirm -w <workspace> --mcp-url <new mcpUrl> --json`.
This records the address actually configured in ChatGPT; do not mark it
confirmed before the Connector is connected. Then run `doctor` again.

### Canonical C2C state directory (this machine)

Use `D:\app_home\codex-with-chatgpt-state` as the C2C state root. Every C2C
CLI command on this machine — including `setup`, `start`, `restart`, `doctor`,
`network`, `session`, `pair`, `logs`, and `stop` — must run with
`C2C_STATE_DIR=D:\app_home\codex-with-chatgpt-state`. Prefer the inherited
User-level variable. If the calling Codex process does not inherit it, inject
this one C2C-specific variable into the command process explicitly. Do not use
`%LOCALAPPDATA%\codex-with-chatgpt` or Codex Package LocalCache as a fallback,
and do not set any Windows global proxy variables.

- The codex-with-chatgpt checkout lives at: `<ACTUAL_CHECKOUT_PATH>`
  (installer/update MUST replace this line in the installed Skill with the user's actual checkout path.)
- CLI: let `<checkout>` mean the path on the previous line; run
  `node "<checkout>/bin/c2c.js" <command>` (or `c2c <command>` if globally linked).
  All commands support `--json` for parsing.
- If the checkout has no `node_modules` or no `dist/`, first run
  `corepack pnpm install && corepack pnpm build` inside it.
- For commands that act on the user's project (`setup`, `doctor`, `session`,
  `restart`, `start`, `stop`, `status`, `pair`, `unpair`, `logs`, `workspace`,
  `record`, `tunnel status`, `tunnel choose`), pass `-w <workspace root>`
  (the project the user is working on, NOT the c2c repo).
- Do not add `-w` to machine-wide commands: `update-check`, `sandbox-allow`,
  `prefs`, `tunnel login`. They still accept and ignore `-w`, so a leftover
  flag must not fail the command.

## Daily update check

At the START of every workflow below (before anything else), run these two
commands (both are cheap / cached; never mention them unless an update exists):

Exception: `C2C CHECK` skips this maintenance step so the health check remains
read-only. It runs only the read-only commands listed in its workflow below.

1. `c2c update-check --json` (do not pass `-w`)
2. `c2c sandbox-allow --json` (do not pass `-w`) — writes the C2C state directory into Codex's
   sandbox `writable_roots` (macOS: `~/Library/Application Support/codex-with-chatgpt`;
   Windows: `%LOCALAPPDATA%\codex-with-chatgpt`; config file is
   `~/.codex/config.toml` on both, or `%USERPROFILE%\.codex\config.toml` on Windows).
   If already allowlisted, this is a no-op and does not trigger elevation.

- `{ "updateAvailable": false }` → continue silently. Never mention the check.
- `{ "updateAvailable": true }` → tell the user one line:
  "检测到 Codex with ChatGPT 有新版本，我先更新一下（约 1 分钟），随后继续你的任务。"
  Then run the update workflow below, and CONTINUE the original task afterwards.

## Workflow: update（"更新 Codex with ChatGPT"，or triggered by the daily check）

Inside the checkout directory (see Locations):

1. `git pull --ff-only` (if it fails due to local edits: `git stash && git pull --ff-only`).
2. `corepack pnpm install && corepack pnpm build`.
3. Re-install both C2C skills by running `corepack pnpm sync:skills`. This
   updates the main skill and `c2c-emergency-recovery` together, and records
   the actual checkout path in the installed main skill.
4. `c2c sandbox-allow --json` (so existing installs pick up the sandbox allowlist),
   then `c2c restart -w <workspace>` so the bridge runs the new code, then
   `c2c update-check --force --json` to refresh the cache (should now report up to date).
5. Tell the user "✓ 已更新到最新版本" — then resume whatever task triggered this.
   (The updated SKILL.md takes effect from the next Codex session; that's expected.)

## Connection choice (once per workspace)

Ask this **before** the public address exists (`c2c setup` / first `doctor --fix`
that starts a tunnel). Do not mention tunnels, wrangler, DNS, or hostnames.
Speak only of 临时地址 / 固定域名 / 登录 Cloudflare.

1. `c2c tunnel status -w <workspace> --json`
2. If `needsChoice` is false: do not ask again.
3. If `needsChoice` is true: tell the user exactly `userPrompt` and wait.
   - 没有账号 / 没有域名 / 临时 / 不用 →
     `c2c tunnel choose -w <ws> --mode quick --json`
   - 有域名（例如 example.com）→ first tell them `loginPrompt`, then
     `c2c tunnel choose -w <ws> --mode named --zone <domain> --json`.
     This may open the user's own browser (the Cloudflare exception in
     Golden rule 5). Wait until the command finishes.
     If they said they have an account but gave no domain: ask once for the
     domain. If the command returns `need: "zone"`, ask once and retry.
     If `fallback` is true: tell them `userMessage` and continue on the
     temporary address. Do not retry named unless they ask.
4. Never put connection credentials in the project. The CLI stores them in
   the C2C state directory.

## Workflow: first-time setup（"使用 Codex with ChatGPT 完成首次配置"）

1. Detect prerequisites yourself: `node --version` (>= 20), and check `cloudflared`.
   - If cloudflared is missing on macOS run `brew install cloudflared`; on Windows use
     `winget install Cloudflare.cloudflared`. Do this yourself; don't ask.
2. If the c2c repo has no `node_modules`, run `pnpm install && pnpm build` in it.
3. Run `c2c sandbox-allow --json`, then **Connection choice**, then
   `c2c setup -w <workspace> --json`.
   `sandbox-allow` edits Codex `config.toml` only — it adds C2C's state directory
   to `[sandbox_workspace_write].writable_roots` so later chats can write logs
   without elevation. If the write is denied, request approval and retry once.
   → returns `{ mcpUrl, pairingCode, workspaceName, connectorName, ... }`.
   `connectorName` is this workspace's plugin title (legacy installs stay
   `Codex with ChatGPT`; additional workspaces get `Codex with ChatGPT · <name>`).
   Pairing codes expire in ~5 minutes. Do not mint one until the ChatGPT
   Authorize / pairing form is on screen: run `c2c pair --json` then type
   that code immediately. Doctor does not pre-mint a code.
4. `c2c prefs --json` (this machine, not this workspace).
   - If `setupMode` is null: tell the user exactly `setupChoicePrompt`. Wait
     for「1」or「2」. Then `c2c prefs set --setup-mode auto` or `--setup-mode manual`.
     Do not open ChatGPT settings and do not start automatic configuration
     until they answer. Do not default to auto.
   - If they later ask to switch: same `c2c prefs set --setup-mode` command.
     Do not re-ask on a later workspace or on reconnect.
   - `setupMode: "manual"`: skip step 5's automatic ChatGPT settings. Go to
     **Guided manual ChatGPT setup** (chosen). Opening line:
     `接下来用手动教学配置。一次只需要做一个操作。`
     Do not say 自动配置没有成功.
   - `setupMode: "auto"`: continue with step 5. Keep the two-failure fallback.
5. Open ChatGPT on the ONE iab tab (see **In-app browser**). Foreground +
   markHandoff immediately. Same tab, `goto` only:
   - 开发人员模式: skip `https://chatgpt.com/#settings/Security` when
     `developerModeEnabled` is true. Otherwise open it, enable 开发人员模式
     ("Developer mode") if it is off, then `c2c prefs set --developer-mode`.
     Never record it as off. If creating the connector later says developer
     mode is required, open this page, enable it, save `--developer-mode`,
     and retry create — do not skip that recovery.
   - 已有该 `connectorName`: `https://chatgpt.com/plugins` — Delete it (never
     Reconnect). Then `goto` the 加插件 URL below.
   - 还没有 / 刚删掉: `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
     Operate ONLY on `connectorName` from step 3:
      - If that exact name exists: Delete it, then create it again. Never
        Reconnect, never edit-in-place, never open the old Server URL.
      - If it does not exist: create one with that exact name.
      - Never rename, delete, or edit a connector that belongs to another workspace.
      - Description: `Securely connect ChatGPT to the current Codex workspace for planning and review.`
      - Server URL: the `mcpUrl` from step 3
      - Authentication: OAuth
     Fill the known form in one script when you can. Then Connect / Authorize.
     Only then run `c2c pair --json` and type that code. As soon as it shows
     Connected / authorized / pairing accepted, continue — do NOT wait for 8
     tools on this page.
     Run `c2c connector-confirm -w <workspace> --mcp-url <mcpUrl> --json`
     after Connected / pairing, then `c2c doctor -w <workspace> --json`.
6. Same tab: open the first C2C chat per **Conversation management**
   (Project collection for a new workspace; `https://chatgpt.com/` only
   in long-chat). Confirm Chat mode per **In-app browser** §7 (if it is Work,
   open a new Chat conversation instead). Send the boot prompt from
   `docs/protocol.md` §Boot Prompt, then (same chat) send:
   `Use the "<connectorName>" connector: call workspace_info and read hello-style top-level file. Reply with the workspace name.`
   Confirm the reply matches `workspaceName` (wait per **In-app browser** §8).
   Only then save the chat URL with `c2c session set` (see Conversation
   management). If the name does not match, do not save. markDeliverable.
7. Report to the user exactly in this shape (no internals):

```
Codex with ChatGPT

✓ 当前项目已识别
✓ Workspace Bridge 已启动
✓ 安全连接已建立
✓ ChatGPT 已连接
✓ 文件读取测试通过

Ready.
```

If a login wall appears (ChatGPT, Cloudflare): stop, tell the user the ONE thing
to do ("请登录 ChatGPT，完成后告诉我'好了'"), then continue.

### Guided manual ChatGPT setup

Enter this path when `setupMode` is `manual` (chosen at the start), or when
automatic ChatGPT browser configuration fails twice at the same explicit
setup/reconnect step after `c2c doctor` / repair. Do NOT enter the failure
path for a browser/js timeout without a visible error, a page that is
still loading/generating, or while waiting for login / 2FA / CAPTCHA.
A chosen manual path does not wait for those two failures.

Stop automating ChatGPT settings. Keep the current local C2C state and the
current `mcpUrl`, `pairingCode`, `workspaceName`, and `connectorName`. Do not
silently fall back to Codex-only execution and do not permanently disable C2C.
Do not change the saved `setupMode` when this is a failure fallback.

Opening line:

- Chosen (`setupMode: "manual"`): `接下来用手动教学配置。一次只需要做一个操作。`
- Failure fallback: `自动配置没有成功，我来带你手动完成。一次只需要做一个操作。`

Then guide ONE action at a time, waiting for the user to say「好了」before the
next action:

1. If `developerModeEnabled` is not true: ask them to open
   `https://chatgpt.com/#settings/Security` and enable 开发人员模式. After they
   say「好了」, `c2c prefs set --developer-mode`. If it is already remembered,
   skip this step.
2. Ask them to open `https://chatgpt.com/plugins`. If the exact `connectorName`
   exists, delete only that connector. Never ask them to touch another workspace's connector.
3. Ask them to open
   `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
   and create the exact `connectorName` with:
   - Description: `Securely connect ChatGPT to the current Codex workspace for planning and review.`
   - Server URL: the current `mcpUrl`
   - Authentication: OAuth
4. Ask them to Connect / Authorize. Then run `c2c pair --json` and give them
   only that pairing code. If it expires before they finish, run pair again.
5. When they report Connected / authorized / pairing accepted, resume the normal
   setup/reconnect flow at its ChatGPT verification step. First run
   `c2c connector-confirm -w <workspace> --mcp-url <mcpUrl> --json`, then
   `c2c doctor -w <workspace> --json`. If automatic browser
   verification then hits the same explicit failure twice, stop and report the
   exact failed step; do not loop indefinitely and do not continue without C2C.

## Conversation management

`c2c session -w <ws> --json` → `{ session, conversation }`.
`conversation.mode` is the only switch. Missing / legacy files with a chat URL
and no Project stay **long-chat**. Do not ask those users to migrate. If they
later say they want a Project, run **Bind Project**. A brand-new workspace
(no session file) is **project**.

Never match a Project or a chat by display name. Never upload the repo to
Project sources. Never click 分享 / Share. Chat titles are display metadata,
never identity. A title may be renamed only after workspace verification and
the chat URL has been saved; rename is best-effort and must not change the
saved URL binding.

**Identity and rename rule**

- A message target is the exact URL of the controlled Chat tab. In long-chat,
  `session.url` is authoritative. In project mode, it is only a workspace
  pointer and does not prove the current thread's binding. A controlled IAB
  URL identifies this thread only when available browser metadata
  `codexSessionId` matches this Codex session; a tab listing alone is not proof.
- Never search, recover, bind, or verify a chat by its title.
- A rename is optional UX. If a direct rename control is available in the
  current Chat page, use the user's title or a short goal-based title. Do not
  hunt menus. After rename, read the address bar and require it to equal the
  expected URL for this conversation. If it differs, stop rename handling
  and keep the original mapping; never recover by title. A rename failure
  does not fail setup.

### Project-mode workspace pointers and task state

The current session store is workspace-scoped. In `project` mode,
`session.url` is only the workspace's last-saved chat pointer or a legacy
hint; it is not an authoritative binding for the current Codex thread.
`taskId`, `iteration`, `lastState`, and `checkpoint` are also workspace-level
state unless a thread-local store is explicitly implemented. They may belong
to a different Codex conversation.

For this thread, use an explicit user-provided Chat URL or a URL previously
verified in this Codex conversation, then pass the send gate above. If a
new Codex conversation has no such URL, open a new chat from
`conversation.projectUrl`; do not navigate to `session.url` just because it
exists. Resume a workspace checkpoint only when its task ID and expected
Chat URL match this conversation's own C2C history. Otherwise stop with
`THREAD_BINDING_UNKNOWN` instead of resuming or overwriting the workspace
pointer. If this thread's actual URL differs from `session.url`, do not
assume either is wrong and do not overwrite `session.url` to make them match.

### long-chat (do not rewrite this path)

ONE ChatGPT conversation per workspace. Same as before.

- **Find it**: if `conversation.reuseSavedChat` and `conversation.chatUrl`,
  `goto` that URL (foreground + markHandoff) and continue there.
- **Save it**: after boot + workspace_info, and the reply names this workspace,
  `c2c session set -w <ws> --mode long-chat --url <url> --title "C2C <workspace name>"`.
  If the name does not match, do not overwrite a previously saved URL.
- **Update it**: after each EXECUTED/DONE,
  `c2c session set -w <ws> --task <id> --iteration <n> --state <STATE>`
  plus checkpoint flags from the coding workflow (`--protocol-state`,
  `--waiting-for`, `--goal`, `--next-step`, `--known-issues`, or
  `--clear-checkpoint` on DONE). Do not put logs or diffs in those fields.
- **Switch it** ONLY when (a) the user asks for a new chat, (b) the current
  chat visibly lags, or (c) this conversation is Work. Then:
  1. Same iab tab: `goto` `https://chatgpt.com/`, confirm Chat mode
     (**In-app browser** §7), then send the boot prompt.
  2. Send a HANDOFF (`docs/protocol.md`) — goal, progress, state, issues,
     next step. Never paste files.
  3. workspace_info check; only then `c2c session set --url`. On failure,
     leave the old saved URL unchanged.
- Saved chat 404s: treat as a switch. Reconstruct HANDOFF from
  `session.checkpoint` (goal, progress, issues, next step). If there is no
  checkpoint, use `task` / `iteration` / `lastState` and `execution_summary`
  metadata only. Never paste logs or output bodies.

### project (new workspaces)

One ChatGPT Project per workspace, with chats scoped to Codex conversations:

1. Continue the same Codex conversation only with its explicit or previously
   verified URL, then re-check the actual tab through the send gate.
2. A **new** Codex conversation opens a new ChatGPT chat from
   `conversation.projectUrl`. The workspace-level `session.url` is only a
   candidate hint and never proves that chat belongs to the new thread.
3. Different workspace → different Project and different connector.

**Open a chat in this Codex thread**

- If this turn supplies an explicit Chat URL for THIS Codex conversation,
  use it as `expectedChatUrl` and verify the controlled tab through the send
  gate. Else if this conversation records a URL previously verified for this
  thread, reuse it and re-check `actualTabUrl`. Neither case is satisfied by
  workspace-level `session.url` alone. No new chat and no HANDOFF.
- Else if `conversation.projectReady`: `goto` `conversation.projectUrl`.
  On that page, use the on-page composer (「{项目名}中的新聊天」 / "New chat
  in …"). Do not use the sidebar and do not `goto` `https://chatgpt.com/`.
  Confirm Chat mode (**In-app browser** §7). Boot prompt, then workspace_info
  with the **exact** `connectorName`. After the reply names this workspace, save
  `expectedChatUrl` with `c2c session set -w <ws> --mode project
  --project-url <collection> --url <chat> --connector-name
  "<connectorName>" --title "C2C <workspace name>"`. This records the
  workspace-level last-saved pointer; it does not bind other Codex threads.
  If this Codex thread is continuing a previous C2C task, send HANDOFF right
  after the boot prompt.
- Else: **Bind Project** first.

**Update it**: same `c2c session set --task / --iteration / --state` as long-chat.

**Wrong collection**: do not guess another Project. Tell the user the expected
workspace name, ask them to open the right collection, then say「已找到」.
Also offer「继续用长对话」. If they pick long-chat:
`c2c session set -w <ws> --mode long-chat` and use the long-chat path.
If the collection 404s or the new chat is not inside the Project, same choice.

**Saved chat 404s** (this thread): `goto` the collection, open a new chat
there, boot + HANDOFF from `session.checkpoint` (no logs) + workspace_info,
then save the new chat URL. Keep `--project-url`.

### Bind Project (user creates the collection once)

Do this for a new workspace, or when an existing user asks to switch to
Project. Do **not** click the ChatGPT sidebar to create the Project
(Computer Use is forbidden; IAB must not hunt that menu).

1. Tell the user exactly this (fill in the workspace name):

```
请在 ChatGPT 里新建一个项目，名字用「<workspaceName>」，记忆请选「仅限项目记忆」。

如果侧栏里看不到「项目」：把鼠标放在「聊天」上，点右边出现的三个点，选择「按项目整理」。

建好后会打开合集页面。看到页面后跟我说「好了」。
```

2. Wait for「好了」/ the collection page. Same iab tab: read the address bar.
   It must look like `https://chatgpt.com/g/g-p-…/project`. If it does not,
   ask them to open that project until it does. Then:
   `c2c session set -w <ws> --mode project --project-url <url> --connector-name "<connectorName>"`.

3. On that same collection page only, open 右上角 **… → 项目设置**.
   Do not click 分享. Do not add 来源 / files.
   - 记忆: 仅限项目记忆 (project-only). Leave 库访问权限 disabled.
   - 指令: paste **Project instructions** below (fill `{{…}}` from
     `workspace_info` / setup). Use the exact `connectorName` from setup.
     Never write the public / temporary address into 指令.
   Save and close settings.

4. Still on the collection page, create the first chat with the on-page
   composer, then boot + workspace_info as in setup step 5. Save the chat URL.

### Project instructions (paste into 项目设置 → 指令)

```
You are the planning and review layer for one local workspace. Codex executes.

This Project is bound only to:
- Workspace name: {{workspace_name}}
- Kind: {{project_type}} ({{languages}} / {{frameworks}})
- Connector (use this one only): {{connector_name}}

When you call tools, use ONLY that connector. Do not use any other
Codex with ChatGPT connector. If workspace_info names a different
workspace, stop. Do not plan. Do not use this Project's memory.

Read code, git, diffs, and any released command output through that
connector. Never ask anyone to paste file bodies, diffs, or logs. After
EXECUTED, call execution_output (list, then read) when a readable item
exists; if status is restricted, review from git instead. Never upload
the repo into this Project's files or sources.

When facts conflict, trust this order:
1. Current code from the connector
2. A HANDOFF in this chat (this task's goal, progress, next step)
3. These instructions
4. This Project's memory (durable architecture only; stale memory loses)

This Project's memory is only for this workspace. On HANDOFF, trust the
brief, re-read code through the connector, and resume at NEXT_EXPECTED_STEP.

Be substantive: why, which file, what to test. No empty one-liners and
no 40-step epics. Use C2C control messages.
```

## Workflow selection: Quick vs Design-first

`conversation.mode` (`project` / `long-chat`) controls conversation
organization only. `workflowMode` (`quick` / `design-first`) is independent.
Never add a third conversation mode or a `STATE: DESIGN` protocol state.
When no workflow is stored or named, preserve the existing Quick behavior.
Persist an explicit choice with `c2c session set --workflow-mode quick|design-first`.

Recognize these separate intents:

- **Check**: `C2C CHECK`, `检查 C2C 连接`, `测试 C2C 连接`, or `检查 Codex 与
  ChatGPT 通信`. Run only the read-only **C2C CHECK** workflow below. It does
  not start or resume a coding task.
- **Quick**: "使用 C2C 快速模式完成 XXX" or the existing "使用 Codex with
  ChatGPT 实现 XXX". Run the existing `INIT → PLAN → EXECUTION → EXECUTED →
  REVIEW → DONE` loop. Do not add Artifact Sync.
- **Design-first**: "使用 C2C 设计模式讨论 XXX". Prepare the verified ChatGPT
  conversation and stop for Human ↔ ChatGPT discussion. Do not send INIT, set
  a `waitingFor` checkpoint, implement code, or turn discussion into a task.
- **Sync**: "同步当前 ChatGPT 的阶段成果和 LOG SYNC，不开发". Run only the
  Artifact Sync Loop below, then stop.
- **Implement**: "设计完成，进入实施" (or equally explicit authorization).
  Only this user intent opens the Implementation Authorization Gate below.

### C2C CHECK — read-only end-to-end connection check

Use this after Codex/computer/network recovery or when the user asks `C2C CHECK`.
The check verifies the existing route and does not repair it.

1. Run these read-only commands in order and capture their results:

   ```text
   c2c doctor -w <workspace> --no-fix --json
   c2c session -w <workspace> --json
   c2c workspace -w <workspace> --json
   ```

   Require the local doctor checks for state/sandbox, workspace, Bridge, MCP,
   OAuth, and Tunnel to pass; require `chatgptRepair.needed` and
   `namedRepair.needed` to be false. Require the exact Connector name. In
   long-chat, use the saved `session.url` as `expectedChatUrl`; in project mode,
   use only the explicit or previously verified URL for THIS Codex conversation.
   If project mode has no proven thread URL, stop with `THREAD_BINDING_UNKNOWN`;
   do not use the workspace pointer. The workspace result supplies local `name`
   and `workspaceId` for comparison with `workspace_info`.
2. If any local requirement fails, stop before opening ChatGPT and report
   `C2C CHECK: RECOVERY_REQUIRED`, the failed layer and reason, and the next
   recovery action. Do not run repair or maintenance commands.
3. Bootstrap/reuse the built-in IAB as described in **In-app browser
   (ChatGPT)**. Open only `expectedChatUrl`; reuse the existing exact-URL tab.
   Do not search by title, create a Chat, or change its title. Require the
   controlled `actualTabUrl == expectedChatUrl` and an enabled composer before
   sending. `listTabs()` metadata alone does not pass this gate.
4. Generate a short unique CHECK_ID and send this ordinary message to that
   Chat, replacing the placeholders with the captured values:

   ```text
   [C2C CHECK]
   CHECK_ID: <short unique id>

   Use only the configured connector "<connectorName>".
   Call workspace_info and reply exactly:
   CHECK_OK: <CHECK_ID>
   WORKSPACE_NAME: <workspaceName>
   WORKSPACE_ID: <workspaceId>

   Do not send or request INIT, PLAN, EXECUTED, or REVIEW. Do not modify files.
   ```

   `[C2C CHECK]` is not a protocol state. Do not create or update a task
   checkpoint or set `waitingFor`.
5. Wait in the same Chat and automatically read the reply. On a browser timeout,
   inspect the same tab before deciding what to do; never resend while it may
   still be generating. Require the CHECK_ID, workspace name, and workspace ID
   to match the local results. A mismatch is `C2C CHECK: FAIL`, layer
   `WORKSPACE_IDENTITY`; stop and report the binding error.
6. Read `c2c session --json` again. Require `taskId`, `iteration`, `lastState`,
   `checkpoint`, `workflowMode`, Project URL, workspace-level `session.url`,
   and Connector name to be unchanged. In project mode, `session.url` is
   checked only for workspace-state integrity, never as thread identity.
   A changed value is `C2C CHECK: FAIL`, layer `SESSION_INTEGRITY`.
7. On success, report:

   ```text
   C2C CHECK: PASS
   ✓ Local bridge
   ✓ Secure connection
   ✓ Thread Chat binding and delivery
   ✓ ChatGPT Connector and workspace identity
   ✓ Codex → ChatGPT → Codex round trip
   Workspace: <workspaceName>
   Connector: <connectorName>
   Mode: <workflowMode or unset>
   ```

   On failure, report `C2C CHECK: FAIL` or `C2C CHECK: RECOVERY_REQUIRED`,
   plus `Failed layer`, `Reason`, and `Recommended next action`. On a Chat URL
   mismatch, use layer `CHAT_BINDING`. Never repair or rebind as part of this
   check.

### Design-first setup

1. Run the normal local doctor/health gate. Read the saved workspace,
   connector, and conversation using `c2c session --json`; do not alter
   `conversation.mode`.
2. For Project mode, open the saved Project collection and create a new Chat
   from its on-page composer. For long-chat, preserve its one-chat-per-workspace
   reuse rule. In the same IAB tab, confirm Chat mode, send the boot prompt,
   then call `workspace_info` with the exact connector name.
3. Verify that `workspace_info` names the current workspace. Save the Chat URL
   only after verification, with `--workflow-mode design-first`. A title may
   be renamed under **Identity and rename rule** above.
4. Stop. Tell the user: "设计讨论会话已准备好，请在 ChatGPT 中继续讨论。"
   Do not send INIT, create a task checkpoint, or execute design ideas.

### Artifact Sync Loop (Markdown only)

Artifact Sync is separate from the C2C coding protocol. A synchronized
Artifact never authorizes implementation. Only accept a plain-text
`[ARTIFACT_SYNC_BUNDLE]` envelope containing `.md` `document` or `log-sync`
artifacts with explicit `create` / `replace` modes. Do not interpret prose as
an implicit write request. Keep each Markdown body byte-for-byte as received;
never summarize, edit, format, translate, append, or repair it.

**Transport:** File-first requires a reliable IAB download/attachment-bytes
API. The current documented IAB runtime does not expose one, so File-first is
not supported here. Do not claim a file was downloaded or use GUI Save As,
browser cache scraping, or system download hacks. Use Text fallback: copy the
complete machine-readable envelope unchanged into a temporary local text file,
then run `c2c artifact-sync -w <workspace> --bundle-file <temp-file> --json`.
The helper parses the envelope, permits only declared Markdown destinations
inside the canonical workspace, uses atomic writes, re-reads each result, and
returns a ready-to-send receipt with size and SHA256. Review the receipt; a
parser or write error is `FAILED`, never partial success. The helper does not
run code or delete files.

Path rules are enforced by the helper: no absolute paths, `..`, symlink or
junction traversal, `.git`, `.env*`, credential/secret paths, non-Markdown
extensions, undeclared targets, or deletion. `create` fails if the target
exists. `replace` replaces only its explicitly declared existing `.md` target.
No other file may be touched. Do not run package installation, build, tests,
refactors, or commits as part of a sync.

After successful local verification, send the helper's `receiptText` to the
**same saved Chat URL** (not as a C2C protocol message). Its format is:

```text
[ARTIFACT_SYNC_RECEIPT]
BUNDLE_ID: <bundle id>
STATUS: SUCCESS
SAVED:
- ARTIFACT_ID: <id>
  PATH: <path>
  SIZE: <bytes>
  SHA256: <digest>
NO_IMPLEMENTATION_PERFORMED: true
NEXT_ACTION:
Verify the synchronized files through the workspace connector.
Continue design discussion unless the user explicitly authorizes implementation.
```

Ask ChatGPT to use the existing read-only connector `read_file` tool for every
saved path and confirm readability and content match. Do not add connector
write tools or broaden OAuth scopes. After read-back, return control to Human
↔ ChatGPT and stop. Never send `STATE: EXECUTED`, start a PLAN, or implement.

### Implementation Authorization Gate

Only the user's explicit "设计完成，进入实施" or equivalent authorizes
implementation. Open the same saved Chat URL and send the existing standard
`[C2C] STATE: INIT` in the normal format. State that the plan must use the
confirmed design from this Chat and synchronized workspace Markdown, preserve
frozen decisions, re-check current workspace state through the connector, and
produce a standard PLAN. Then resume the existing coding workflow. Artifact
Sync completion alone never crosses this gate.

## Workflow: coding task（"使用 Codex with ChatGPT 完成 XXX"）

Protocol states sent to ChatGPT: INIT → PLAN → EXECUTING → EXECUTED → REVIEW → (PLAN | DONE | BLOCKED).
Local checkpoint states (session only, never a ChatGPT `STATE:` line):
`INIT`, `PLAN_RECEIVED`, `EXECUTING`, `EXECUTED_LOCAL`, `EXECUTED_SENT`, `DONE`, `BLOCKED`.
Do not invent `STATE: RESUME`. If the original chat is gone, send HANDOFF.
All control messages start with `[C2C]`. Keep Codex→ChatGPT messages under 1 KB.
ChatGPT's replies are expected to be substantive (see step 3). Docs: `docs/protocol.md`.

0. `c2c tunnel status -w <workspace> --json`. If `needsChoice`, follow
   **Connection choice** first (existing installs: ask once, then remember).
   Then `c2c doctor -w <workspace> --json` (auto-repairs). **Doctor gate:** if local
   is not green, do not open ChatGPT and do not send INIT. If
   `namedRepair.needed` is true, tell the user `namedRepair.userMessage`, run
   `c2c tunnel login --json` (their browser; Cloudflare exception), then doctor
   again. If `chatgptRepair.needed` is true, tell the user `chatgptRepair.userMessage`
   (one paragraph, no internals), run **Workflow: reconnect after address
   reclaim**, then doctor again and only continue when the gate is green.
   Generate task id: `c2c_` + 4 random hex chars — unless a checkpoint already
   has one (reuse that id; do not mint a second task).
1. `c2c session -w <workspace> --json`. Open ChatGPT on the same iab tab
   per **Conversation management** for `conversation.mode` (foreground +
   markHandoff). long-chat: saved chat, or `https://chatgpt.com/` if none.
   project: this thread's chat URL, or the collection page for a new chat,
   or **Bind Project** if `projectReady` is false. On a NEW conversation
   confirm Chat mode (**In-app browser** §7), then send the boot prompt from
   `docs/protocol.md` §Boot Prompt and the workspace_info check (name the
   exact `connectorName`). Confirm the reply names the current workspace
   before saving the session URL. Do not use the browser to re-read code MCP
   already provides. After sending a control message, wait per
   **In-app browser** §8.

   **Resume only from a checkpoint proven to belong to this Codex thread.**
   In long-chat, `session.checkpoint` follows the workspace's single chat.
   In project mode, `taskId`, `iteration`, and `session.checkpoint` are
   workspace-level hints; resume only if the task ID and expectedChatUrl match
   this conversation's own C2C history. Otherwise stop with
   `THREAD_BINDING_UNKNOWN` and establish this thread's Project chat. A
   browser/js timeout is not a lost task: reacquire the same tab and inspect
   the target conversation; do not INIT, re-run, or resend because of timeout.
   - `EXECUTED_SENT` + `waitingFor=GPT_REVIEW`: do not INIT, do not re-run,
     do not resend EXECUTED. Stay on the saved chat and wait for review. If
     that chat 404s: HANDOFF from checkpoint fields (no logs), then wait.
   - `EXECUTED_LOCAL`: local work is done; only send EXECUTED (record first
     if this iteration has no record yet). Do not re-run.
   - `EXECUTING`: not finished. Continue the current PLAN if you still have
     it; otherwise HANDOFF and ask ChatGPT to restate the last PLAN. Do not
     treat it as done and do not INIT a new task.
   - `PLAN_RECEIVED`: execute that plan. Do not INIT.
   - `INIT` / `waitingFor=GPT_PLAN`: claim the tab and wait. Do not resend INIT.
   - `DONE`: summarize to the user if needed; `c2c session set --clear-checkpoint`.
   - `BLOCKED`: surface ChatGPT's reason; do not INIT.
   Never re-pair, never recreate the connector, and never rewrite Project
   instructions just to resume.
2. Send INIT with the user's goal (skip when the checkpoint says not to):

```
[C2C]
STATE: INIT
TASK_ID: c2c_f81a
ITERATION: 0

GOAL:
<user's goal, one paragraph>

INSTRUCTION:
Inspect the connected workspace through the Codex with ChatGPT MCP connector.
Produce a C2C PLAN message.
```

   Confirm the INIT message is visibly in that ChatGPT conversation (one cheap
   DOM check). If the page is Retry-only, recover per **In-app browser** §7
   first. Do not write the waiting checkpoint, and do not wait for PLAN, until
   that message is visible.
   Then:
   `c2c session set -w <ws> --task <id> --iteration 0 --state INIT --protocol-state INIT --waiting-for GPT_PLAN --goal "<short goal>" --next-step "wait for PLAN"`
3. Wait for ChatGPT's `STATE: PLAN` reply (**In-app browser** §8 — short DOM
   checks, same tab; do not treat a 5-minute browser timeout as failure).
   Read GOAL/ACTIONS/TESTS/SUCCESS_CRITERIA.
   A good PLAN also carries RATIONALE and concrete natural-language edit
   suggestions (which file, what to change, why). If the reply is a bare
   one-liner with no rationale or file-level guidance, ask once:
   "Please expand the plan with rationale and concrete per-file suggestions."
   Then:
   `c2c session set -w <ws> --protocol-state PLAN_RECEIVED --waiting-for none --next-step "execute PLAN"`
4. Execute the plan yourself with your own harness (your tools, your judgment;
   ChatGPT does not micro-manage tool calls).
   Before you start:
   `c2c session set -w <ws> --protocol-state EXECUTING --waiting-for none --next-step "finish PLAN then record"`
5. Record the execution so ChatGPT can read it via MCP. Metadata always:
   `c2c record -w <ws> --task c2c_f81a --iteration 1 --changed-files "src/a.ts,src/b.ts" --tests "27 passed" --exit-status ok`
   If this iteration ran a **test / build / lint / typecheck** command, also
   pass that command's output. Write stdout/stderr to a local temp file first,
   then:
   `c2c record … --command "pnpm test" --output-file <temp> --exit-code <n>`
   Record both success and failure. Do not record shell history, `.env`,
   keys, or unrelated dumps. Never paste that file (or any log) into ChatGPT.
   If the CLI says the output was not released, still send EXECUTED; ChatGPT
   reviews from git. Then:
   `c2c session set -w <ws> --iteration 1 --state EXECUTED --protocol-state EXECUTED_LOCAL --waiting-for none --next-step "send EXECUTED"`
6. Send EXECUTED (no diffs, no logs). Tell ChatGPT to use MCP, including
   `execution_output` when a readable item exists:

```
[C2C]
STATE: EXECUTED
TASK_ID: c2c_f81a
ITERATION: 1

RESULT:
Execution finished.

CHANGED_FILES:
4

TESTS:
27 passed

Please independently inspect the workspace and current git diff through MCP.
If execution_output lists a readable item for this iteration, list then read it.
If status is restricted, ignore it and review from git_diff.
```

   Then:
   `c2c session set -w <ws> --protocol-state EXECUTED_SENT --waiting-for GPT_REVIEW --next-step "wait for PLAN or DONE"`
7. ChatGPT reviews via MCP (`git_diff`, `read_file`, `test_status`,
   `execution_output`) and replies DONE / PLAN (next iteration) / BLOCKED.
8. Loop. Respect maxIterations (`.c2c.json`, default 12). At the limit, pause and ask
   the user: "已完成 12 轮协作，仍有未解决问题，是否继续？"
9. On DONE: summarize the result to the user in plain language.
   `c2c session set -w <ws> --state DONE --clear-checkpoint`
10. On BLOCKED: read ChatGPT's reason, fix what you can, or surface the single
    decision the user must make.
    `c2c session set -w <ws> --protocol-state BLOCKED --waiting-for USER --known-issues "<short reason>"`

## Workflow: disconnect（"断开 ChatGPT"）

1. `c2c unpair -w <workspace>` (revokes all tokens immediately).
2. Optionally remove the connector on the same iab tab via
   `https://chatgpt.com/plugins` (foreground + markHandoff). Only touch
   this workspace's `connectorName`.
3. Tell the user: "已断开 ChatGPT 对该项目的访问。"

## Workflow: reconnect after address reclaim（全关掉以后地址失效）

This is the normal case when the user quit Codex / the terminal / the machine:
the previous public address is gone. Doctor already started a new one.
`connectorAction: "update"` means Delete + create again — not Reconnect.

`c2c doctor --json` will look like:
`{ "chatgptRepair": { "needed": true, "connectorAction": "update", "connectorName": "...", "userMessage": "...", "mcpUrl": "...", "pages": { ... } } }`

1. Tell the user exactly `chatgptRepair.userMessage`. Then you repair. Do not
   ask them to click around ChatGPT unless a login wall appears. Do not open
   the C2C chat and do not send `[C2C]` until this repair finishes and a
   follow-up doctor is green. Never "try a message first to see if it works".
   Reuse `c2c prefs --json`. Do not re-ask setup mode. If `setupMode` is
   `manual`, use **Guided manual ChatGPT setup** (chosen) instead of automating.
2. Same one iab tab as setup (foreground + markHandoff). Settings URLs only
   until Connected — never hunt menus:
   - 开发人员模式: skip `https://chatgpt.com/#settings/Security` when
     `developerModeEnabled` is true. If create/delete then says developer
     mode is required, open it, enable, `c2c prefs set --developer-mode`.
   - 插件总管（只用来 Delete）: `https://chatgpt.com/plugins`
   - 加插件（Delete 之后必走）: `https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins`
3. Operate ONLY on `chatgptRepair.connectorName`. Never touch another
   workspace's connector.
   - If that exact name exists on the plugins hub: **Delete** it. Confirm the
     delete if ChatGPT asks. **Never click Reconnect, Refresh, Connect, or
     Edit** on the old card — the old Server URL is dead and the page will
     hang on "This site cannot be reached".
   - Then `goto` the 加插件 URL and create that **same** `connectorName`
     (do not invent a second name):
      - Description: `Securely connect ChatGPT to the current Codex workspace for planning and review.`
      - Server URL: `chatgptRepair.mcpUrl`
      - Authentication: OAuth
     Then Connect / Authorize. Only then run `c2c pair --json` and type that
     code. Continue as soon as it is Connected — do not wait for 8 tools on
     the settings page.
   - If the name is already gone, skip Delete and only create.
4. After Connected / pairing, run `c2c connector-confirm -w <workspace>
   --mcp-url <chatgptRepair.mcpUrl> --json`, then `c2c doctor --json` again.
   Same tab: only after the Doctor gate is green,
   reopen the chat URL already verified for THIS Codex thread. Long-chat may
   use `session.url`; project mode must use an explicit or previously verified
   thread URL, never the workspace pointer alone. If no project thread URL
   is proven, stop with `THREAD_BINDING_UNKNOWN` and use the Project workflow.
   Do not rewrite Project instructions — they store the connector **name**.
   In that same chat, send the workspace_info check from setup step 6
   (exact `connectorName`). Doctor green is not enough: the old conversation
   may still be bound to the deleted connector.
   - If the reply names this workspace: continue there. Save the URL if needed.
   - If workspace_info fails, times out, or cannot read the name: do **not**
     keep retrying that old URL. project → collection page, new chat in this
     Project, boot + HANDOFF from `session.checkpoint` (no logs) +
     workspace_info, then `c2c session set --url` only after the name matches.
     long-chat → Conversation management switch, same checks. Keep the old
     saved URL until the new chat passes.
5. If the ChatGPT conversation was lost: same as the failure path in step 4.
   No file re-uploading (the workspace lives in MCP). If tools point at
   the wrong connector, open 项目设置 and confirm 指令 still names
   `connectorName` (never paste the new public address).

## Workflow: repair（anything looks broken）

1. `c2c doctor -w <workspace> --json`. Doctor gate: do not open ChatGPT / send
   `[C2C]` until local is green, except reconnect settings pages.
2. If `namedRepair.needed`, tell the user `namedRepair.userMessage`, run
   `c2c tunnel login --json`, then doctor again. Do not Delete the connector.
3. If `chatgptRepair.needed`, follow **reconnect after address reclaim**, then
   doctor again.
4. Otherwise apply the recovery map. Only involve the user for login / 2FA /
   CAPTCHA — one action.

## Recovery map

| Symptom | Action |
| --- | --- |
| Bridge not running | `c2c start` (doctor does this automatically) |
| Tunnel dead / URL unreachable / 全关掉后连接失效 | `c2c doctor` → if `namedRepair.needed`, login to Cloudflare and doctor again (do not Delete). If `chatgptRepair.needed`, tell the user the message, then **Delete** THIS workspace's connector only (`connectorName`) and create it again. Never Reconnect. After recreate, re-check `workspace_info` in the saved chat; if it still fails, new chat in the same Project (or long-chat switch) + HANDOFF. |
| Collection page shows only Retry | Same iab tab: Retry once, then open the last working chat and click its Project link. Do not write INIT/EXECUTED waiting checkpoints until the message is visible. |
| ChatGPT says tool call failed / 401 | token expired or revoked → re-pair (new pairing code + authorize) |
| Pairing code rejected/expired | `c2c pair --json` for a fresh code |
| Same explicit ChatGPT setup/reconnect browser configuration step fails twice after repair | Stop automating ChatGPT settings and use **Guided manual ChatGPT setup fallback**. Do not count browser/js timeout, loading/generating, or login/2FA waiting as failures. |
| Port conflict | handled automatically; never surface to the user |
| Every new chat “repairs” / cannot write the log or settings directory | `c2c sandbox-allow --json` (once). Do not ask the user. |
| cloudflared missing | install it yourself (brew/winget), then retry |
| Sidebar has no「项目」 | Ask the user to hover「聊天」, click the …, choose「按项目整理」 |
| Collection page is the wrong Project | Ask the user to open the named collection and say「已找到」, or accept long-chat |
