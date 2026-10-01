# C2C CONTROL Workspace — Boot First, Then Repair v0.1

## 目标

先让 `D:\app_home\codex-with-chatgpt` 这个 workspace 通过 **正常 published C2C 路径** 上线可用。

然后再在已经工作的 C2C 通道里修复 CONTROL plane / recovery system。

本轮明确：

```text
不要调用 control-bootstrap
不要要求 canonical CONTROL state root 先通过
不要让 CONTROL safety gate 阻止 workspace 上线
```

CONTROL / recovery system 保持冻结，直到正常 C2C 通道建立。

---

# 1. 当前 workspace

```text
D:\app_home\codex-with-chatgpt
```

先只读确认：

```text
workspace/root
git branch
HEAD
working tree
package manager
build scripts
```

不要改源码。

---

# 2. 使用正常 C2C startup path

目标是复用已经在 `c2c-published-recovery` 证明可工作的方式：

```text
normal setup
→ Bridge
→ local health
→ cloudflared
→ Quick Tunnel
→ MCP endpoint
```

要求：

```text
使用 isolated / disposable CODEX_HOME 或 runtime state
不要使用 c2c-repair-control-state
不要调用 custom CONTROL bootstrap
不要做 legacy reconciliation
不要触碰 TARGET/MOZI
```

这是“让 workspace 上线”的路径，不是“验证 CONTROL recovery system”的路径。

---

# 3. 如果普通 context 遇到 EPERM

允许一次：

```text
capable/elevated execution context
```

目标只是在正常 C2C startup path 中完成：

```text
install/build if needed
Bridge
Tunnel
```

不要因此修改 CONTROL safety code。

---

# 4. 成功标准

达到：

```text
Bridge PASS
Local health PASS
Quick Tunnel PASS
Public health PASS
MCP endpoint generated
```

然后返回：

```text
HUMAN_ACTION_REQUIRED: MCP_APP
```

并给出：

```text
Public MCP endpoint:
https://.../mcp
```

保持 Bridge 和 Tunnel 运行。

---

# 5. 人工创建 connector

用户在 ChatGPT 侧创建新的 MCP connector。

建议名称：

```text
codex-with-chatgpt-control-live-v1
```

完成 pairing / OAuth。

然后 ChatGPT 验证：

```text
workspace_info
read_file
git_status
```

必须确认连接到：

```text
D:\app_home\codex-with-chatgpt
```

而不是：

```text
c2c-published-recovery
```

---

# 6. 建立通道后再修 CONTROL plane

只有 C2C 正常通道建立后，才恢复 CONTROL plane 工作。

修复顺序：

```text
1. 通过工作中的 connector 读取 CONTROL source
2. 复现 control-bootstrap 的 canonical-state EPERM
3. 让 ChatGPT 规划最小修复
4. Codex 执行
5. 用工作中的正常 C2C 通道做 review / recovery
```

这样即使 CONTROL safety 版本仍失败：

```text
主通信通道仍然可用
```

---

# 7. 禁止事项

本轮禁止：

```text
修改 TARGET/MOZI
处理 legacy PID 16208
修改 canonical CONTROL state root
重新设计 recovery architecture
先修 CONTROL_STATE_NOT_WRITABLE 再上线
```

---

# 8. Required report

```text
C2C CONTROL WORKSPACE BOOT-FIRST RESULT v0.1

Workspace:
D:\app_home\codex-with-chatgpt

Normal C2C startup path used:
YES / NO

CONTROL bootstrap used:
NO

Isolated runtime/state used:
YES / NO

Bridge:
PASS / FAIL

Local health:
PASS / FAIL

Quick Tunnel:
PASS / FAIL

Public health:
PASS / FAIL

MCP endpoint:
...

TARGET/MOZI modified:
NO

STATUS:
HUMAN_ACTION_REQUIRED: MCP_APP /
MAIN_RUNTIME_BLOCKED

BLOCKER:
NONE / <single exact blocker>
```

Then STOP.

---

# One-line invariant

```text
Get the CONTROL source workspace online through the normal proven C2C path first; repair the stricter CONTROL recovery system only after a working ChatGPT↔Codex channel exists.
```
