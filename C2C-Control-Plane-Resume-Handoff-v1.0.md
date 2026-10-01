# C2C CONTROL PLANE RESUME HANDOFF v1.0

## 0. Purpose

This handoff resumes the previously frozen CONTROL plane / recovery-system work, now that a usable main C2C environment exists.

Model split:

- Codex execution side: GPT-6 Luna / Medium
- ChatGPT planning/review side: GPT-5.6 Sol / High

Primary objective:

```text
Achieve the first successful live end-to-end CONTROL activation.
Only then harden further.
```

Do not let the auxiliary recovery system expand into another parallel infrastructure project before it has worked once end to end.

---

# 1. Main C2C environment is now usable

A clean published baseline was restored and proven usable.

Published baseline:

```text
origin/main
9663b88753e35c76796c5bce000293e0bd22cd9e
```

Disposable verification workspace:

```text
D:\workshop\chatgpt\c2c-published-recovery
workspaceId: 7078a2d1285d
```

Verified:

```text
fresh install          PASS
build                  PASS
Bridge                 PASS
local health           PASS
cloudflared            PASS
Quick Tunnel           PASS
public health          PASS
MCP connector          PASS
workspace_info         PASS
read_file              PASS
git_status             PASS
```

Working ChatGPT connector for that disposable workspace:

```text
codex-with-chatgpt-扩展c2c-v1
```

Important:

```text
That connector points to c2c-published-recovery.
It is NOT the CONTROL source workspace connector.
```

---

# 2. CONTROL source and TARGET

CONTROL source workspace:

```text
D:\app_home\codex-with-chatgpt
```

TARGET / MOZI workspace:

```text
D:\workshop\职业教育-MOZI
```

TARGET state:

```text
D:\app_home\codex-with-chatgpt-state
```

Legacy CONTROL state:

```text
D:\app_home\codex-with-chatgpt-repair-control-state
```

Stable canonical CONTROL state root committed before freeze:

```text
<canonical home>\.codex\c2c-repair-control-state
```

Current machine path:

```text
C:\Users\66483\.codex\c2c-repair-control-state
```

Stable managed cloudflared root:

```text
<canonical home>\.codex\cloudflared
```

Current machine path:

```text
C:\Users\66483\.codex\cloudflared
```

Known trusted cloudflared:

```text
version: 2026.9.1
SHA256:
2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712
```

---

# 3. Last known CONTROL Git state

Historical working branch:

```text
local-v2ray-c2c-compat
```

Personal remote:

```text
https://github.com/bluetreew/codex-with-chatgpt
```

Original upstream:

```text
https://github.com/XiaoDuoYa/codex-with-chatgpt.git
```

Known key commits:

```text
64eb1c8
design-first C2C workflow/artifact sync

2ff5d42
end-to-end C2C connection check workflow

f79eb2e9df3b6ca6b97ab43e169cbb3f68182e06
feat: add deterministic C2C emergency recovery harness

1e2fc08d10b5e7e8b4c37d51b90d56a8379f44b7
feat: support legacy bridge recovery migration

cca73d2fe375aaa95474b5b195bcb2e477b3a363
feat: add control-plane capable execution handoff

f93f37d3ed6067e13e0a6bc7fd5b7778892250ca
cloudflared resolver wiring fix

5bdc027d546ece00f355423613027f581479e6d6
feat: harden control-plane recovery runtime

4cb2bc20e71d3ea5c1a187facab5371a7b84d158
fix: move control state to stable home root
```

Last known branch tip:

```text
4cb2bc20e71d3ea5c1a187facab5371a7b84d158
```

At that time:

```text
local == remote
working tree clean
```

Codex must verify current reality before changing anything.

---

# 4. What had already been built

## 4.1 Deterministic emergency recovery harness

Implemented:

```text
child-process probes
restricted Bridge classification
no-human-shell
local health gate
endpoint comparison
pairing state machine
one capable-context escalation guard
session preservation
post-pair auto-resume
cloudflared validation
```

Core invariant at the time:

```text
Deterministic harness first
model reasoning second
human shell never
human UI only at MCP App / OAuth / security gates
```

## 4.2 Legacy Bridge migration

Implemented:

```text
bounded migration/replacement
safe guards
concurrency marker
fail-closed semantics
```

Commit:

```text
1e2fc08d10b5e7e8b4c37d51b90d56a8379f44b7
```

## 4.3 CONTROL capable execution handoff

Implemented:

```text
fixed paths
traversal protections
junction protections
atomic retry marker
concurrency guard
```

Commit:

```text
cca73d2fe375aaa95474b5b195bcb2e477b3a363
```

## 4.4 Cloudflared resolver / trust path

Implemented and verified:

```text
CONTROL cloudflared execution must not trust arbitrary PATH/env/profile
managed trusted binary
hash validation
version validation
resolver wiring
```

Commit:

```text
f93f37d3ed6067e13e0a6bc7fd5b7778892250ca
```

## 4.5 SCOPE_C / SCOPE_D hardening

Implemented:

```text
stable managed cloudflared root under canonical home .codex
CONTROL start/doctor/named/precheck trust gate
legacy runtime reconciliation before duplicate start
structured listener query errors
fail-closed listener semantics
exact process creation provenance via processCreatedAt
runtime startedAt retained as readiness timestamp
old runtime records without processCreatedAt fail closed
atomic one-shot retirement marker
durable retirement intent before shutdown
progress-write failure prevents shutdown
concurrent reconciliation exactly one stop/start
direct ETIMEDOUT integration coverage
```

Relevant hardening commit:

```text
5bdc027d546ece00f355423613027f581479e6d6
```

Test history:

```text
full suite: 367/367 PASS
build: PASS
no-human-shell: PASS
```

After stable canonical state-root change:

```text
full suite: 371/371 PASS
CONTROL: 120/120 PASS
recovery: 96/96 PASS
build: PASS
```

Corresponding commit:

```text
4cb2bc20e71d3ea5c1a187facab5371a7b84d158
```

---

# 5. Live cleanup already completed

Legacy Bridge:

```text
PID 16208
127.0.0.1:58317
```

Already completed:

```text
exact identity revalidation
authenticated /admin/info PASS
command identity PASS
graceful authenticated shutdown
force kill: NO
PID retired
listener closed
legacy runtime record removed by normal shutdown
```

Only append-only log changes occurred:

```text
logs\bridge.log
logs\bridge-d32f8bd61681.out.log
```

Rule:

```text
Do not touch PID 16208 again
unless new live evidence requires it.
```

---

# 6. Actual blocker at freeze time

Stable canonical state root had been moved to:

```text
C:\Users\66483\.codex\c2c-repair-control-state
```

The live CONTROL bootstrap then hit:

```text
state write probe
→ EPERM
```

Result:

```text
CONTROL_STATE_NOT_WRITABLE
```

It did NOT return:

```text
RETRY_CAPABLE_CONTEXT
```

Therefore:

```text
canonical CONTROL Bridge did not start
state root remained absent at that time
```

A tiny proposed fix existed conceptually:

```text
classify state-write EPERM/EACCES
as one-shot capable-context handoff
```

But this was intentionally NOT pursued because CONTROL work was frozen while the main C2C environment was restored.

---

# 7. Do NOT blindly implement the old proposed fix

The first action now is NOT:

```text
EPERM/EACCES → capable handoff
```

Re-evaluate the live environment first.

Why:

During main-environment recovery, capable/elevated execution was later proven to work, including:

```text
pnpm install
build
Bridge
cloudflared
Quick Tunnel
```

Therefore the old state-write EPERM may have been execution-context-specific and may no longer justify a source change.

Rule:

```text
Reproduce first.
Patch only if the blocker still exists.
```

---

# 8. Priority for the resumed work

Do NOT optimize for:

```text
more recovery architecture
more review cycles
more defensive layers
```

Optimize for:

```text
first successful live CONTROL E2E activation
```

First-stage success path:

```text
CONTROL source clean
→ build/test baseline green
→ canonical state root writable
→ CONTROL Bridge starts
→ local health PASS
→ trusted cloudflared validation PASS
→ public/MCP endpoint if required
→ pairing/OAuth if required
→ CONTROL can inspect/repair TARGET without human shell
```

Only after one E2E success should reliability hardening resume.

---

# 9. Model roles

## Codex — GPT-6 Luna / Medium

Role:

```text
execute
read code
run deterministic checks
edit source
run tests
return evidence
```

Operating style:

```text
narrow tasks
one blocker at a time
no scope expansion
no architecture rewrite unless ChatGPT explicitly requests it
```

Human must NOT be asked to:

```text
run shell
paste shell output
relay PLAN / EXECUTED manually
```

Human interaction is limited to:

```text
MCP App
OAuth
pairing
security approval
```

## ChatGPT — GPT-5.6 Sol / High

Role:

```text
planning
architecture judgment
failure classification
code review
scope control
deciding the next narrow PLAN
```

---

# 10. Current ChatGPT conversation to reuse

Current ChatGPT Project:

```text
chatgpt
```

Project URL:

```text
https://chatgpt.com/g/g-p-6aaecc889cc48191993fa8ab880e6243-chatgpt/project
```

Current ChatGPT chat URL:

```text
https://chatgpt.com/g/g-p-6aaecc889cc48191993fa8ab880e6243-chatgpt/c/6ab70d3e-ff28-83e8-bbf1-42311fbe3a64
```

This chat already contains:

```text
the full CONTROL-plane design/debug history
the freeze decision
the main-environment recovery
the current C2C architecture understanding
```

For CONTROL resume, prefer reusing this exact ChatGPT chat rather than creating an empty one.

---

# 11. CONTROL workspace needs its own connector

The existing working connector:

```text
codex-with-chatgpt-扩展c2c-v1
```

points to:

```text
D:\workshop\chatgpt\c2c-published-recovery
```

It must NOT be used as the CONTROL source connector.

For:

```text
D:\app_home\codex-with-chatgpt
```

start that workspace's own C2C Bridge/Tunnel and create a dedicated connector.

Suggested connector name:

```text
codex-with-chatgpt-control-plane-v1
```

Historical intended name was:

```text
Codex with ChatGPT · C2C Repair
```

The exact name matters less than this invariant:

```text
workspace_info through that connector must identify
D:\app_home\codex-with-chatgpt
```

Never accept a connector merely because its label looks correct.

---

# 12. Resume sequence

## Phase A — verify source only

In:

```text
D:\app_home\codex-with-chatgpt
```

verify:

```text
workspace_info
git status
branch
HEAD
remotes
working tree
package manager
build/test scripts
```

Goal:

```text
confirm or update the last-known 4cb2bc20... source state
```

Do not edit yet.

## Phase B — start C2C for CONTROL workspace

Use the C2C skill in the CONTROL source workspace.

Goal:

```text
start that workspace's own Bridge/Tunnel
obtain that workspace's own MCP endpoint
```

Human gate:

```text
create/connect CONTROL connector
pairing/OAuth
```

Then ChatGPT must verify via the new CONTROL connector:

```text
workspace_info
read_file
git_status
```

## Phase C — resume live CONTROL work

First live probe:

```text
is canonical CONTROL state root writable now?
```

If:

```text
PASS
```

then:

```text
do not patch source
continue live CONTROL bootstrap / activation
```

If:

```text
EPERM / EACCES
```

then that becomes the single blocker sent to ChatGPT for a narrow plan.

---

# 13. First-round prohibitions

Do not:

```text
redesign recovery architecture
invent another state root
invent another cloudflared resolver
touch legacy PID 16208
modify TARGET/MOZI
modify real user main config
rewrite the whole CONTROL subsystem
run endless review cycles
```

Do not reopen the abandoned:

```text
C2C-Control-State-Write-Capable-Handoff-Fix-v0.1.md
```

unless fresh live evidence again proves state-write EPERM/EACCES is the current blocker.

---

# 14. First ChatGPT INIT message

After the CONTROL connector is created and verified, Codex should send this into the CURRENT ChatGPT chat:

```text
[C2C]
STATE: INIT

GOAL:
Resume the frozen CONTROL plane / recovery system in D:\app_home\codex-with-chatgpt.

CURRENT_PRIORITY:
Achieve the first successful live end-to-end CONTROL activation before any further hardening.

KNOWN_LAST_STATE:
- Last known source tip: 4cb2bc20e71d3ea5c1a187facab5371a7b84d158
- Legacy PID 16208 already retired; do not repeat.
- Trusted cloudflared 2026.9.1 already validated.
- Canonical CONTROL state root: C:\Users\66483\.codex\c2c-repair-control-state
- Frozen blocker was state-write EPERM in the then-current execution context.
- Do not assume the old EPERM still reproduces.
- CONTROL work was intentionally frozen while the main C2C environment was restored.

REQUEST:
1. Verify current source/runtime state.
2. Reproduce the smallest live CONTROL bootstrap path.
3. If it succeeds, continue to first live E2E activation.
4. If it fails, return exactly one current blocker and a narrow PLAN.
5. Do not broaden the architecture.
```

---

# 15. First execution report format

```text
C2C CONTROL PLANE RESUME RESULT v1.0

Workspace:
...

Branch:
...

HEAD:
...

Working tree:
CLEAN / DIRTY

Build:
PASS / FAIL

Relevant tests:
PASS / FAIL

CONTROL canonical state root:
...

State write probe:
PASS / FAIL

CONTROL bootstrap:
PASS / FAIL / NOT_RUN

CONTROL Bridge:
PASS / FAIL / NOT_RUN

Local health:
PASS / FAIL / NOT_RUN

Trusted cloudflared validation:
PASS / FAIL / NOT_RUN

Tunnel/MCP:
PASS / FAIL / NOT_RUN

TARGET/MOZI modified:
NO

Legacy PID 16208 touched:
NO

STATUS:
CONTROL_E2E_READY /
CONTROL_RUNTIME_BLOCKED /
SOURCE_BASELINE_BLOCKED

BLOCKER:
NONE / <single exact blocker>

NEXT:
CONTINUE_E2E /
ASK_CHATGPT_FOR_NARROW_PLAN
```

---

# 16. Success definition

Only after at least one:

```text
CONTROL_E2E_READY
```

may the system be described as operational.

Until then, avoid labels such as:

```text
high reliability
self-healing
production-ready
```

After the first E2E success, ChatGPT should decide:

```text
which hardening is still justified
which recovery logic should be deleted
which capabilities should be merged back into the normal path
```

---

# 17. Main lesson from the frozen phase

The previous process over-invested in:

```text
proving the system could not fail dangerously
```

before proving:

```text
the system could actually run successfully
```

The new order is:

```text
1. WORKING
2. REPEATABLE
3. SAFE
4. HARDENED
```

not:

```text
SAFE
→ MORE SAFE
→ MORE REVIEW
→ still never worked
```

---

# 18. One-line handoff

```text
Resume the frozen CONTROL plane from the last known clean source state, use the now-working C2C environment to collaborate with ChatGPT, re-test the old state-write blocker instead of assuming it still exists, and optimize for the first successful live end-to-end CONTROL activation before any further hardening.
```
