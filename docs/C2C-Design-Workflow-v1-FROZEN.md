# C2C Design Workflow v1 — FROZEN

## 1. 文档状态

- Status: **FROZEN / ACCEPTED**
- Scope: 本机 `codex-with-chatgpt` 本地增强版 v1
- Acceptance baseline:
  - Branch: `local-v2ray-c2c-compat`
  - Commit: `64eb1c8`
- Current Connector: `Codex with ChatGPT · 职业教育-MOZI · v3`
- Canonical C2C state dir: `D:\app_home\codex-with-chatgpt-state`

本文件记录已经完成实机验收的 **C2C Design Workflow v1** 稳定行为基线。

“FROZEN”表示：
- 当前行为已经完成验收；
- 后续不得直接改写本文件来重新定义已通过的 v1 行为；
- 新能力、语义调整或破坏兼容性的改动应形成新的版本基线，例如 v1.1 / v2；
- 本文件不是 upstream `codex-with-chatgpt` 官方协议，而是本机本地增强的已接受基线。

---

## 2. 核心目标

在保留原有 Quick Workflow 的同时，为复杂设计任务提供一个独立的 Design-first Workflow，并增加受控的 Design Artifact Sync，使以下三类工作可以清晰分离：

1. 快速开发；
2. 人与 ChatGPT 的设计讨论；
3. 阶段设计成果与 LOG SYNC 的本地固化。

核心原则：

```text
Quick:
Codex → ChatGPT → Codex

Design-first:
Human ↔ ChatGPT

Artifact Sync:
ChatGPT → Codex → Workspace → ChatGPT

Implementation:
only after explicit Human authorization
```

角色边界：

```text
ChatGPT = design author / reviewer
Codex   = executor / artifact transporter
MCP     = read-only
Git     = local source of truth
Human   = authorization authority
```

---

## 3. Workflow 模型

`workflowMode` 与既有 `conversation.mode` 分离。

```text
conversation.mode
├─ project
└─ long-chat

workflowMode
├─ quick
└─ design-first
```

禁止将 `design-first` 实现为新的 `conversation.mode`。

禁止新增伪 C2C protocol state，例如：

```text
STATE: DESIGN
STATE: SYNC
```

现有核心协议语义保持：

```text
INIT → PLAN → EXECUTED → REVIEW → DONE
```

---

## 4. Quick Workflow

用途：
- 小任务；
- bug fix；
- 明确的实现任务；
- 小范围重构；
- 小型测试修改。

标准流程：

```text
Human
→ Codex
→ INIT
→ ChatGPT PLAN
→ Codex execution
→ EXECUTED
→ ChatGPT REVIEW
→ DONE
```

v1 验收已确认：

```text
Codex
→ INIT
→ ChatGPT
→ PLAN
→ Codex自动读取 PLAN
```

全程无需人工复制消息。

---

## 5. Design-first Workflow

用途：
- 复杂产品设计；
- 技术架构设计；
- 机制设计；
- 多阶段方案讨论；
- 需要 Human Gate 的长期设计工作。

准备阶段：

```text
Codex
→ 打开/关联 ChatGPT Project
→ 准备当前 conversation 对应 Chat
→ Boot Prompt
→ workspace_info
→ 保存 Chat URL
→ STOP
```

在此阶段：

- 不发送 INIT；
- 不写 `waitingFor=GPT_PLAN`；
- 不创建 implementation task；
- 不执行设计方案；
- Human 与 ChatGPT 在同一 Chat 中继续设计。

设计讨论可重复进行：

```text
DISCUSS
→ SYNC
→ DISCUSS
→ SYNC
→ DISCUSS
```

而不是：

```text
DISCUSS
→ SYNC
→ DEVELOP
```

只有 Human 明确授权“设计完成，进入实施”或等价表达后，才允许转入标准 C2C implementation protocol。

---

## 6. Chat Rename 语义

已实机验证：

```text
Chat URL   = identity
Chat title = display metadata
```

v1 的要求是 **rename-safe**，不是要求 Codex 自动操作 ChatGPT UI 执行 Rename。

用户可以在 ChatGPT UI 中手工修改 Chat 标题。

只要：
- Chat URL 不变；
- Project 不变；
- Connector 不变；

C2C session 应继续绑定同一 Chat。

严禁：
- 通过 title 搜索并恢复 Chat；
- 通过 title 判断 identity；
- 通过 title 重新建立 session mapping。

本次验收中，Chat 从：

`Codex规划审查 layer`

人工改名为：

`MOZI · C2C Design Workflow`

改名前后 Chat URL 完全一致，Connector 与双向通信均正常。

因此：

**Chat Rename = PASS**

---

## 7. Artifact Sync Loop

Design-first 中增加独立 Artifact Sync Loop：

```text
ChatGPT
↓
正式设计 Artifact
↓
Codex
↓
Local Workspace
↓
ChatGPT read-back
↓
继续设计
```

必须保持：

```text
Artifact synchronized
!=
Implementation authorized
```

Artifact Sync 不属于：

```text
INIT → PLAN → EXECUTED
```

因此 Artifact Sync 不使用：

```text
[C2C]
STATE: EXECUTED
```

而使用独立的 Artifact Sync receipt。

---

## 8. Artifact 类型与传输

v1 支持的主要 Artifact：

```text
document
log-sync
```

第一版仅允许受控 Markdown Artifact。

### 8.1 File-first

设计目标是：

```text
ChatGPT .md file artifact
→ Codex acquire
→ original save
```

但当前已验证 IAB 路径没有可靠的附件 bytes / download event 获取能力。

因此：

**File-first 在 v1 中不作为已支持能力。**

不得通过：
- Windows GUI Save As；
- 浏览器缓存抓取；
- 系统级下载 hack；

来伪造 File-first。

### 8.2 Text-fallback

v1 已接受并实机验证：

```text
ChatGPT inline Artifact Bundle
→ Codex读取完整正文
→ artifact-sync CLI
→ 原样 UTF-8 materialization
→ SHA256
→ Workspace
```

Codex在此阶段是：

**transport/materialization agent, not an editor**

禁止：
- summary；
- rewrite；
- cleanup；
- reformat；
- translate；
- 补内容；
- 基于理解重写正文。

---

## 9. Artifact Sync 安全边界

受控写入必须满足：

- 目标位于当前 workspace；
- 第一版仅允许 `.md`；
- 禁止 path traversal；
- 禁止 workspace escape；
- 禁止 `.git`；
- 禁止 secrets / credential 路径；
- 禁止 `.env*`；
- 禁止 delete；
- 仅允许明确声明的 create / replace；
- 应使用安全 materialization / verification；
- 保存后计算 SHA256。

成功 receipt 必须明确包含：

```text
NO_IMPLEMENTATION_PERFORMED: true
```

---

## 10. ChatGPT Read-back

Artifact Sync 完成后，ChatGPT通过当前 read-only Connector 重新读取本地 Markdown。

形成闭环：

```text
ChatGPT生成
↓
Codex运输
↓
Workspace
↓
ChatGPT回读
```

v1 已实机验证：
- Artifact从真实 ChatGPT页面提取；
- 原样同步；
- SHA256校验；
- Connector read-back；
- 测试文件清理；
- 没有自动进入 implementation。

---

## 11. Human Authorization Gate

Design-first 中必须保留 Human Gate。

以下动作均不构成 implementation authorization：

- 设计讨论完成一个阶段；
- 生成阶段成果；
- 生成 LOG SYNC；
- Artifact Sync 完成；
- ChatGPT read-back 完成；
- Chat 重命名；
- Connector恢复。

只有明确的人类授权，例如：

```text
设计完成，进入实施。
```

才允许进入：

```text
INIT
→ PLAN
→ Codex execution
→ EXECUTED
→ REVIEW
```

---

## 12. 最终验收矩阵

C2C Design Workflow v1 最终验收结果：

| 验收项 | 结果 |
|---|---|
| Quick Workflow（当前 v3 Connector） | PASS |
| Design-first | PASS |
| Chat Rename | PASS |
| Artifact extraction | PASS |
| Artifact Sync | PASS |
| ChatGPT read-back | PASS |
| No-auto-implementation | PASS |

v3 Quick smoke test 已实机确认：

```text
Codex
→ INIT
→ ChatGPT
→ PLAN
→ Codex读取 PLAN
```

未执行 PLAN，未修改 MOZI 项目文件。

---

## 13. 当前稳定运行基线

### Connector

`Codex with ChatGPT · 职业教育-MOZI · v3`

### Canonical state dir

`D:\app_home\codex-with-chatgpt-state`

### Source branch / commit

```text
branch: local-v2ray-c2c-compat
commit: 64eb1c8
```

### Source status

- 未提交的 C2C 源码改动：无；
- 验收期间未修改 MOZI 项目文件；
- 旧 stale checkpoint 已清除；
- 旧 `taskId`、`iteration`、`lastState` 可作为历史 session metadata 保留。

---

## 14. 运行与网络边界

当前稳定架构保持：

```text
v2rayN TUN OFF
local HTTP proxy 127.0.0.1:10809
        ↓
C2C network processes only
        ↓
Quick-Service Relay
        ↓
cloudflared HTTP/2
        ↓
Cloudflare Quick Tunnel
        ↓
ChatGPT Connector
```

禁止为了 C2C 日常工作主动修改：
- Windows system proxy；
- v2ray 全局路由；
- permanent TUN；
- browser/ChatGPT 全局网络。

Quick Tunnel endpoint 是运行时临时地址，不属于冻结常量。

电脑重启或 Tunnel 重启后 endpoint 可能变化。

如 endpoint 变化，应按既有恢复流程更新对应 Connector，而不是修改本文件中的稳定语义。

---

## 15. 已知运行注意事项

曾出现：

```text
spawn EPERM
```

已定位为：
- Bridge 在受限 Codex 执行环境中启动；
- 该 Bridge 不能继续 `fork` relay Node 子进程；
- 后续命令复用受限 Bridge；
- 停止该实例并在允许 child-process spawn 的环境重新启动后恢复。

该问题属于运行环境 / Bridge lifecycle 问题，不改变 C2C Design Workflow v1 的设计语义。

---

## 16. Source of Truth 纪律

本文件是：

**C2C Design Workflow v1 的已验收冻结基线文档。**

它不是：
- upstream C2C protocol 的替代；
- 当前 Skill 的逐行实现规范；
- 新需求 backlog；
- 自动授权开发的输入。

后续如需修改：
1. 先提出变更原因；
2. 明确与 v1 的差异；
3. 保留 v1 FROZEN 文档不改；
4. 新建 v1.1 / v2 proposal；
5. 独立实现；
6. 独立验收；
7. 验收通过后再形成新的 FROZEN 基线。

---

## 17. v1 冻结结论

```text
C2C Design Workflow v1 — ACCEPTED / FROZEN
```

当前可以停止继续改造 C2C 工具，并将工作重心返回 MOZI 正常设计与开发流程。

后续使用时：

```text
小任务
→ Quick Workflow

复杂设计
→ Design-first Workflow

阶段成果固化
→ Artifact Sync

真正开发
→ Human explicit authorization
→ INIT / PLAN / Execution
```
