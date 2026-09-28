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
`LOCAL_RECOVERY_FAILED`. Surface that state and stop.

## Procedure

1. Resolve the current workspace, canonical `C2C_STATE_DIR`, and installed C2C
   CLI from known paths/environment only. First run `scripts/c2c-status.ps1`
   without `-StartNewRecovery` so any existing progress is resumed. Only if the
   result explicitly says there is no active recovery run, start one with
   `scripts/c2c-status.ps1 -StartNewRecovery`. In particular, an existing
   `BLOCKED_BRIDGE_UNKNOWN` run is re-evaluated in place from fresh Bridge
   evidence; never replace it with a new run. The run state and one-escalation
   flag are stored separately under the C2C state directory; the C2C session
   schema remains unchanged.
2. Follow `nextAction`. For `REPLACE_LEGACY_BRIDGE_ONCE`, require authenticated
   `/admin/info` success, probe HTTP 404, local process capability `CAPABLE`,
   unhealthy Tunnel, an unchanged session snapshot, and no prior Bridge replacement.
   Run `scripts/c2c-start-tunnel.ps1 -Action migrate-legacy` once. The helper stops
   only the verified managed Bridge, starts the current runtime, rechecks `/admin/info`
   and `/admin/recovery-probe`, and verifies the protected session before continuing
   through the normal Tunnel path. If the replacement still lacks a structured probe
   or any check fails, report the blocked state and stop. Never retry replacement.
   Use `scripts/c2c-start-tunnel.ps1` only for `START_BRIDGE_AND_TUNNEL` or
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
   `scripts/c2c-pair.ps1 -RecoveryState WAIT_PAIR_CODE_GENERATION`. The helper
   validates before creating a code, records `PAIR_CODE_GENERATED`, and returns
   `WAIT_PAIRING_COMPLETE`. If code generation fails, it records terminal
   `LOCAL_RECOVERY_FAILED`; begin a new diagnosed recovery before trying again.
   After `配对完成，Connector 名为：<name>`, submit
   `PAIRING_COMPLETED` with that name; only `AI_CONFIRM_CONNECTOR` permits
   `scripts/c2c-confirm.ps1 -RecoveryState AI_CONFIRM_CONNECTOR`. It validates
   the requested MCP URL against the doctor endpoint before changing session
   or endpoint metadata, then records
   `CONNECTOR_CONFIRMED` and returns `POST_RECOVERY_VERIFY`.
6. Resume automatically. Use the built-in IAB and the saved session Chat URL.
   Call `workspace_info` through the confirmed Connector; require workspace
   name and id to match local `workspace --json`. Send a unique, read-only
   `[C2C CHECK]` to that same URL and automatically verify its CHECK_ID and
   workspace fields. Require URL, Project URL, workflow mode, checkpoint,
   task id, iteration, and last state to remain unchanged. Pass the observed
   values to `c2c-status.ps1 -Phase POST_RECOVERY_VERIFY -ConnectorConfirmed`
   (`-WorkspaceInfoName`, `-WorkspaceInfoId`, `-SavedChatUrlAfter`, `-CheckId`,
   and `-ReplyCheckId`). Require the returned state to be `COMPLETE`. Do not
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
