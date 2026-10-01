---
name: c2c-emergency-recovery
description: "Recover a Codex C2C workspace after Bridge, Quick Tunnel, MCP endpoint, OAuth pairing, or Connector failure. Use the structured recovery helpers; the user handles ChatGPT MCP App/OAuth UI only. Never ask the user to run local commands."
metadata:
  short-description: Deterministic C2C recovery with one ChatGPT pairing gate
---

# C2C Emergency Recovery

Use this only after the C2C path is unavailable. Recovery helpers own local
diagnosis, transitions, process probes, endpoint comparison, and validation.
Follow the returned `state` and `nextAction`; do not infer a different path.

## Boundaries

- Never ask the user to run CMD, PowerShell, Node, C2C, or cloudflared commands.
- Never change Windows proxy, v2rayN/TUN, DNS, hosts, or unrelated project files.
- Never alter the C2C protocol, session schema, saved Chat URL, workflow mode,
  checkpoint, or Project URL during recovery.
- Never search for a Chat by title, create a Chat, or change its title.
- The only human gate is ChatGPT MCP App/OAuth setup and pairing-code entry.
- If local process creation remains blocked after one capable-context retry,
  report `BLOCKED_LOCAL_EXECUTION` and stop. Do not hand commands to the user.

## Isolated CONTROL bootstrap

CONTROL bootstrap is separate from target recovery. The built-in `mozi` target
profile preserves the original binding; additional targets are registered and
resolved by profile id.

```text
profileId
workspaceId
workspaceRoot
stateDir
```

Every recovery run binds progress to all four values and rechecks them on each
transition. PowerShell wrappers require `-TargetProfile <id>`; optional
workspace/state arguments are assertions against the profile. The wrappers set
`C2C_STATE_DIR` from the resolved target profile and have no workspace-specific
fallback. Never read or write another profile's session, runtime, recovery
progress, or Project files.

Use the hidden `c2c control-bootstrap` helper for local readiness. It performs
an effective state-directory create/read/delete probe, checks the local process
probe, verifies an existing Bridge without restarting it, or starts a missing
Bridge only after process capability is `CAPABLE`. It then requires the Bridge's
authenticated `/admin/info` and structured `/admin/recovery-probe` to pass.
It never starts a Tunnel and never reads `config.toml` or edits `writable_roots`.
For CONTROL only, use this effective probe as the sandbox readiness evidence;
the generic `doctor.sandbox` exact `writable_roots` result is metadata-only and
must not override a passing effective probe. Keep all other required doctor
checks. TARGET recovery retains the existing doctor contract.

When the helper returns `nextAction: RETRY_CAPABLE_CONTEXT`, Codex orchestration
must invoke that same helper exactly once through the Codex `exec_command` tool
with `sandbox_permissions: require_escalated` and `--capable-context-retry`.
Set `C2C_STATE_DIR` to the CONTROL state path in that tool invocation too. This
is the only context handoff: the CLI does not elevate, call `runas`, or create a
privileged shell. The helper persists `capableContextAttempted` before probing
again. If the second probe or Bridge verification fails, surface
`CONTROL_BOOTSTRAP_BLOCKED` and stop; never retry a second time or ask the user
to run a command.

The Codex-only invocation form is:

```powershell
$canonicalHome = [Environment]::GetFolderPath('UserProfile')
$env:C2C_STATE_DIR = Join-Path (Join-Path $canonicalHome '.codex') 'c2c-repair-control-state'
node 'D:\app_home\codex-with-chatgpt\bin\c2c.js' control-bootstrap `
  --workspace 'D:\app_home\codex-with-chatgpt' `
  --control-state-dir $env:C2C_STATE_DIR `
  --target-profile mozi --json
```

Only the single retry adds `--capable-context-retry` and uses the Codex
execution tool's `require_escalated` setting. Never present this invocation to
the user as a command to run.

Do not start a Quick Tunnel as part of this helper. Continue to the separate
public-endpoint approval gate only after `CONTROL_BRIDGE_READY` and all local
readiness checks pass.

## State machine

```text
START → LOCAL_DIAGNOSIS
  ├─ verified legacy Bridge (authenticated /admin/info 200 + /admin/recovery-probe 404)
  │    → LEGACY_BRIDGE_PROBE_UNSUPPORTED
  │    → one authorized Bridge replacement → immediate info/probe verification
  └─ other recoverable failure → existing LOCAL_RECOVERY
       ↓
     LOCAL_HEALTH_PASS → ENDPOINT_COMPARE
      ├─ CONNECTOR_STILL_VALID → POST_RECOVERY_VERIFY → COMPLETE
      └─ CONNECTOR_UPDATE_REQUIRED → HUMAN_MCP_APP_GATE
           → WAIT_PAIR_CODE_GENERATION → WAIT_PAIRING_COMPLETE
           → AI_CONFIRM_CONNECTOR
           → POST_RECOVERY_VERIFY → COMPLETE
```

The structured helper may instead return `BLOCKED_LOCAL_EXECUTION`,
`BLOCKED_BRIDGE_UNKNOWN`, `BLOCKED_STATE_INCONSISTENT`, or
`LOCAL_RECOVERY_FAILED`. Surface that state and stop. Browser control failures
are reported separately as `IAB_CONTROL_UNAVAILABLE`; never map a CUA or IAB
control timeout to `BLOCKED_BRIDGE_UNKNOWN`.

## Browser control contract

All ChatGPT page control in this recovery uses the official OpenAI Browser
Runtime. Its standard bootstrap is the active bundled Browser plugin's
scripts/browser-client.mjs, imported through node_repl:

1. Reuse a verified Browser Runtime agent and IAB handle when they are already
   available in this Codex session.
2. Otherwise discover exactly one active client under
   .codex/plugins/cache/openai-bundled/; fail closed with
   IAB_CONTROL_UNAVAILABLE if it is missing or ambiguous.
3. Import browser-client.mjs, call
   setupBrowserRuntime({globals: globalThis}), and retain the returned agent.
4. Require an IAB entry from agent.browsers.list(), then call
   agent.browsers.get("iab"). Match metadata.codexSessionId to the
   current Codex session when the field is supplied.
5. Use that Browser Runtime as the C2C browser-health authority. Do not use
   cua.getState(), cua.listBrowsers(), cua.listTabs(), cua.getTab(),
   or cua.createBrowserTab() as the recovery control path. A CUA timeout is
   not a Bridge finding and cannot produce BLOCKED_BRIDGE_UNKNOWN.

Only Bridge/MCP/Tunnel checks can produce their corresponding infrastructure
failure states. A failed Browser Runtime control attempt reports
IAB_CONTROL_UNAVAILABLE with its exact initialization or page-control error;
it does not authorize changes to a healthy Connector, endpoint, Bridge, or
Tunnel.

## Procedure

1. Select a target with `c2c control-target list --json`, then resolve it with
   `c2c control-target resolve --profile <id> --json`. Resolve the installed
   C2C CLI from known paths/environment only. Pass `-TargetProfile <id>` to
   every recovery wrapper. First run `scripts/c2c-status.ps1` without
   `-StartNewRecovery` so matching progress is resumed. Only if the
   result explicitly says there is no active recovery run, start one with
   `scripts/c2c-status.ps1 -TargetProfile <id> -StartNewRecovery`. In particular, an existing
   `BLOCKED_BRIDGE_UNKNOWN` run is re-evaluated in place from fresh Bridge
   evidence; never replace it with a new run. The stored binding includes
   profile id, workspace id, canonical workspace root, and state directory.
   The C2C session schema remains unchanged.
   For diagnosis that must preserve recovery progress, pass `-ReadOnly` to
   `c2c-status.ps1`. This evaluates the current plan without writing progress;
   it cannot be combined with `-StartNewRecovery`, `-AuthorizeRestart`, or a
   transition event. Normal recovery continues to use the stateful wrapper.
2. Follow `nextAction`. For `REPLACE_LEGACY_BRIDGE_ONCE`, require authenticated
   `/admin/info` success, probe HTTP 404, local process capability `CAPABLE`,
   unhealthy Tunnel, an unchanged session snapshot, and no prior Bridge replacement.
   Run `scripts/c2c-start-tunnel.ps1 -TargetProfile <id> -Action migrate-legacy` once. The helper stops
   only the verified managed Bridge, starts the current runtime, rechecks `/admin/info`
   and `/admin/recovery-probe`, and verifies the protected session before continuing
   through the normal Tunnel path. If the replacement still lacks a structured probe
   or any check fails, report the blocked state and stop. Never retry replacement.
   Use `scripts/c2c-start-tunnel.ps1 -TargetProfile <id>` only for `START_BRIDGE_AND_TUNNEL` or
   `START_TUNNEL`. Use its `restart` action only
   when the existing Bridge probe classifies `RESTRICTED_BRIDGE_CONTEXT` and
   local probe classifies `CAPABLE`. Snapshot the session before and after any
   restart and require URL, Project URL, workflow mode, checkpoint, task id,
   iteration, and last state to match.
3. For `RETRY_CAPABLE_CONTEXT`, retry the same helper once in an available
   AI-controlled execution context. Carry forward `facts.capableContextAttempted`
   from the returned plan. The next process probe, not the `RunContext` label,
   decides whether child creation works. If it does not, emit
   `BLOCKED_LOCAL_EXECUTION` and stop.
4. Enter `HUMAN_MCP_APP_GATE` only after Bridge, local MCP, OAuth, Tunnel, public
   health, and doctor local checks pass. If endpoint comparison says
   `CONNECTOR_STILL_VALID`, skip the gate. If it says
   `CONNECTOR_UPDATE_REQUIRED`, present only the current endpoint, OAuth, and a
   suggested Connector name (increment a trailing `vN`; otherwise append
   `· recovery`). Ask the user to create/update that MCP App, Scan Tools/Connect,
   and say `配对页已打开`. If Project instructions explicitly pin the old
   Connector name, ask the user during this same gate to replace only that
   binding. Otherwise leave Project instructions unchanged. Keep the old App
   until final verification.
5. Carry the planner's `state` into each next `c2c-status.ps1` call as
   `-RecoveryState`; the stored run state must also match. After `配对页已打开`,
   submit `PAIRING_PAGE_OPENED`; only `WAIT_PAIR_CODE_GENERATION` permits
   `scripts/c2c-pair.ps1 -TargetProfile <id> -RecoveryState WAIT_PAIR_CODE_GENERATION`. The helper
   validates before creating a code, records `PAIR_CODE_GENERATED`, and returns
   `WAIT_PAIRING_COMPLETE`. If code generation fails, it records terminal
   `LOCAL_RECOVERY_FAILED`; begin a new diagnosed recovery before trying again.
   After `配对完成，Connector 名为：<name>`, submit
   `PAIRING_COMPLETED` with that name; only `AI_CONFIRM_CONNECTOR` permits
   `scripts/c2c-confirm.ps1 -TargetProfile <id> -RecoveryState AI_CONFIRM_CONNECTOR`. It validates
   the requested MCP URL against the doctor endpoint before changing session
   or endpoint metadata, then records
   `CONNECTOR_CONFIRMED` and returns `POST_RECOVERY_VERIFY`.
6. Resume automatically using the official Browser Runtime contract above. Get the current session IAB and list its tabs before choosing a tab.

   A Node REPL reset or stale handle within the same Codex session must reacquire that session IAB and its existing exact-URL tab. This recovery path MUST NOT call tabs.new(). A newly started Codex session may receive a new IAB with an empty tab list; that state means Browser Runtime PASS and TAB_INITIALIZATION_REQUIRED, not IAB_CONTROL_UNAVAILABLE.

   Resolve expectedChatUrl first: long-chat uses authoritative session.url; Project mode requires an explicit URL for this Codex conversation or a URL previously verified for this conversation. Workspace-level session.url alone is not authoritative. Without a proven Project thread URL, report THREAD_BINDING_UNKNOWN and stop before goto or send.

   If an exact-URL tab exists, bind it with `tabs.get(id)`. If no exact match exists but exactly one reusable ChatGPT tab exists, bind it with `tabs.get(id)`, reuse it, and navigate it to expectedChatUrl. If this is a fresh Codex session and tabs.list() is empty, create exactly one tab with tab = await iab.tabs.new(), then await tab.goto(expectedChatUrl). Verify await tab.url() == expectedChatUrl and verify a present, enabled composer. If multiple non-matching tabs make selection ambiguous, stop without creating a tab.

   tabs.new() creates a browser tab in this Codex session; it does not create a ChatGPT conversation. Navigating to the authoritative expectedChatUrl reopens the existing conversation. A new ChatGPT conversation is created through the Project collection New chat composer. Report a browser/tab control failure only if tabs.new(), navigation, actual-URL verification, or composer observation fails; preserve the exact failed stage.


   Before sending the read-only CHECK, require the expected URL, the controlled
   tab's exact actual URL, and a present, enabled composer. Check that the
   unique CHECK_ID is absent. After a send timeout or reset, report
   SIDE_EFFECT_UNKNOWN, re-bootstrap the official client, reacquire the same
   IAB and exact-URL tab, and inspect for the exact CHECK_ID. If present, treat
   it as committed and do not resend. If absent only after the conversation is
   fully loaded, at most one controlled retry is allowed; if uncertain, stop.

Call workspace_info through the confirmed Connector; require workspace
   name and id to match local workspace --json. Send a unique, read-only
   [C2C CHECK] to that same URL and automatically verify its CHECK_ID and
   workspace fields. Require URL, Project URL, workflow mode, checkpoint, task
   id, iteration, and last state to remain unchanged. Pass the observed values
   to c2c-status.ps1 -Phase POST_RECOVERY_VERIFY -ConnectorConfirmed
   (-WorkspaceInfoName, -WorkspaceInfoId, -SavedChatUrlAfter, -CheckId,
   and -ReplyCheckId). Require the returned state to be COMPLETE. Do not
   send INIT, PLAN, EXECUTED, or REVIEW.

7. Return `COMPLETE` only when local health, endpoint/Connector confirmation,
   workspace identity, saved-Chat round trip, and session integrity all pass.
   Do not modify Project settings.

## Helper contract

The PowerShell wrappers pass C2C arguments through explicit string arrays and
`--workspace`, so Chinese and spaced workspace paths remain one argument.
`c2c recovery-probe` returns Node child-spawn, cloudflared-spawn, and relay-fork
results for the local context and, when Bridge is healthy, for the Bridge
context. `c2c recovery-plan` returns `{ ok, state, nextAction,
humanActionRequired, facts }`. Tests inject fixtures; they never stop a Bridge,
start a Tunnel, change a Connector, or call a live workspace.
