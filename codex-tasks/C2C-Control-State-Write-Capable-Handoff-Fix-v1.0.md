# C2C CONTROL — State Write Capable Handoff Fix v1.0

## 现在要做什么

当前冻结前的 blocker 已经被重新现场复现：

```text
CONTROL_STATE_NOT_WRITABLE
state write probe: EPERM
state root exists: no
CONTROL Bridge: not started
```

因此现在可以实施此前冻结的 **单点修复**：

```text
canonical CONTROL state-root write probe
EPERM / EACCES
→ exactly one capable-context retry
```

目标不是绕过 state gate，而是：

```text
在更有权限的 execution context 中
重新执行同一个 canonical state write probe
```

如果 capable retry 仍失败：

```text
继续 fail closed
```

---

# 1. Scope

CONTROL source workspace：

```text
D:\app_home\codex-with-chatgpt
```

Canonical CONTROL state root：

```text
C:\Users\66483\.codex\c2c-repair-control-state
```

当前 blocker：

```text
CONTROL_BOOTSTRAP_BLOCKED
CONTROL_STATE_NOT_WRITABLE
EPERM
```

本轮只允许修改：

```text
负责 CONTROL bootstrap/state write probe 结果分类
以及 capable-context handoff 的最小相关代码/测试
```

禁止修改：

```text
TARGET/MOZI
state root 路径
cloudflared resolver
Bridge trust model
legacy migration
PID 16208
normal published runtime path
```

---

# 2. Required behavior

## Case A — ordinary context write probe returns EPERM/EACCES

返回：

```text
RETRY_CAPABLE_CONTEXT
```

并触发现有的：

```text
one-shot capable/elevated execution handoff
```

要求：

```text
same source workspace
same canonical state root
same write probe
same bootstrap path
```

不得：

```text
换 state root
跳过 probe
直接启动 Bridge
```

---

## Case B — capable-context retry write probe PASS

继续正常 bootstrap：

```text
state root created/writable
→ CONTROL bootstrap
→ CONTROL Bridge
→ local health
```

不要要求第二次人工 shell。

---

## Case C — capable-context retry仍 EPERM/EACCES

必须停止：

```text
CONTROL_STATE_NOT_WRITABLE
CONTROL_BOOTSTRAP_BLOCKED
```

禁止无限重试。

---

## Case D — 其他写入错误

例如：

```text
ENOENT
EINVAL
ENOSPC
unexpected I/O failure
```

不要误分类为 capable retry。

继续原有 fail-closed 分类。

---

# 3. Guardrails

必须保留：

```text
exactly one capable-context escalation
atomic/retry marker if already present
concurrency guard
canonical path validation
junction/traversal protections
no-human-shell invariant
```

不要创建新的 recovery subsystem。

不要增加第二套 state path。

---

# 4. Tests

至少增加/更新以下 focused coverage：

```text
1. ordinary write probe EPERM
   → RETRY_CAPABLE_CONTEXT

2. ordinary write probe EACCES
   → RETRY_CAPABLE_CONTEXT

3. non-permission write error
   → remains blocked / original classification

4. capable retry succeeds
   → bootstrap continues

5. capable retry returns EPERM again
   → hard stop, no second escalation

6. concurrent duplicate trigger
   → only one capable retry path

7. TARGET/MOZI untouched

8. canonical state root unchanged
```

如果已有同类 tests：

```text
扩展现有 tests
不要新建平行测试框架
```

---

# 5. Validation order

先运行：

```text
focused CONTROL/state/bootstrap tests
```

然后：

```text
build
```

如果以上 PASS，再运行：

```text
CONTROL/recovery relevant suite
```

最后如执行成本合理，再运行：

```text
full suite once
```

不要进入多轮 review 循环。

---

# 6. Live validation after code PASS

重新执行 CONTROL bootstrap。

期望路径：

```text
ordinary context
→ state write EPERM
→ RETRY_CAPABLE_CONTEXT
→ capable context
→ same state write probe PASS
→ canonical state root created
→ CONTROL Bridge starts
→ local health PASS
```

如果 capable context 下仍失败：

```text
STOP
```

并只报告：

```text
CAPABLE_CONTEXT_STATE_WRITE_FAILED
```

不要继续改架构。

---

# 7. Success criteria

本轮成功不是“测试通过”，而是至少达到：

```text
State write probe: PASS in capable context
CONTROL bootstrap: PASS
CONTROL Bridge: PASS
Local health: PASS
```

然后继续后续 Tunnel/MCP 流程。

---

# 8. Required report

```text
C2C CONTROL STATE-WRITE CAPABLE HANDOFF RESULT v1.0

Workspace:
D:\app_home\codex-with-chatgpt

HEAD before:
...

Files changed:
...

Focused tests:
PASS / FAIL

Build:
PASS / FAIL

Relevant suite:
PASS / FAIL / NOT_RUN

Full suite:
PASS / FAIL / NOT_RUN

Ordinary-context state write:
EPERM / EACCES / PASS / OTHER

Ordinary classification:
RETRY_CAPABLE_CONTEXT / BLOCKED / N/A

Capable retry executed:
YES / NO

Capable-context state write:
PASS / FAIL / NOT_RUN

Canonical state root created:
YES / NO

CONTROL bootstrap:
PASS / FAIL / NOT_RUN

CONTROL Bridge:
PASS / FAIL / NOT_RUN

Local health:
PASS / FAIL / NOT_RUN

TARGET/MOZI modified:
NO

Legacy PID 16208 touched:
NO

STATUS:
CONTROL_BOOTSTRAP_RECOVERED /
CONTROL_RUNTIME_BLOCKED /
SOURCE_FIX_FAILED

BLOCKER:
NONE / <single exact blocker>

NEXT:
CONTINUE_CONTROL_E2E /
ASK_CHATGPT_FOR_NARROW_PLAN
```

Then STOP.

---

# One-line invariant

```text
Convert only canonical CONTROL state-root EPERM/EACCES into one existing capable-context retry; never bypass the state gate, never change the state root, and fail closed after one retry.
```
