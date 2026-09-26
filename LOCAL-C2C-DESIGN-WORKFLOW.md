# Local C2C Design Workflow

## Two independent choices

`conversation.mode` (`project` or `long-chat`) organizes ChatGPT conversations.
`workflowMode` (`quick` or `design-first`) chooses how a task proceeds. An
unset workflow keeps the existing Quick behavior.

## Quick workflow

Use "使用 C2C 快速模式完成 …" or the existing "使用 Codex with ChatGPT 实现 …".
The established `INIT → PLAN → EXECUTION → EXECUTED → REVIEW → DONE` loop
continues unchanged. Quick tasks do not use Artifact Sync.

## Design-first workflow

Use "使用 C2C 设计模式讨论 …". Codex checks health, opens the workspace's
verified Project/chat and read-only connector, verifies `workspace_info`, saves
the Chat URL, and stops for Human ↔ ChatGPT discussion. It does not send INIT,
create a GPT_PLAN checkpoint, or implement proposals. Chat URL is identity;
title is display metadata only. Optional rename happens only after workspace
verification and URL persistence, never changes identity, and must leave the
current URL equal to the saved URL.

## Artifact Sync Loop

Use "同步当前 ChatGPT 的阶段成果和 LOG SYNC，不开发" after ChatGPT emits a
plain-text `[ARTIFACT_SYNC_BUNDLE]`. Version one supports Markdown files with
`document` or `log-sync` kind and explicit `create` or `replace` mode.

The current documented IAB interface has no reliable attachment byte-download
API, so this version uses Text fallback. Keep the envelope and each body
unchanged in a temporary text file, then run:

```text
c2c artifact-sync -w <workspace> --bundle-file <temporary-file> --json
```

The helper restricts writes to declared `.md` files within the canonical
workspace, rejects traversal, absolute paths, symlinks/junctions, `.git`,
`.env*`, and secret/credential paths, and does not delete or append. `create`
fails when a file exists; `replace` requires its exact declared target to
exist. Writes are atomic. The helper reads back each saved file and returns
its size and SHA256. A failure is not success.

Send a receipt to the same saved Chat with `NO_IMPLEMENTATION_PERFORMED: true`.
ChatGPT must read each synchronized path using the existing read-only
`read_file` connector and confirm it is readable and matches. Then stop and
return control to Human ↔ ChatGPT. Do not send `EXECUTED`, request a PLAN,
change files outside the bundle, install packages, build, test, or commit.

## Implementation authorization

Artifact Sync does not authorize coding. Only "设计完成，进入实施" or equally
explicit user wording crosses the gate. Codex reopens the same saved Chat,
sends the normal `[C2C] STATE: INIT`, asks ChatGPT to use the confirmed design
and synchronized documents, and then follows the unchanged Quick coding loop.

## Daily commands

- Quick: `使用 C2C 快速模式完成 <task>`
- Design: `使用 C2C 设计模式讨论 <topic>`
- Sync: `同步当前 ChatGPT 的阶段成果和 LOG SYNC，不开发`
- Implement: `设计完成，进入实施`

## Limits

- File-first attachment acquisition is not supported by the currently
  documented IAB runtime; use Text fallback.
- Artifact Sync handles Markdown only. It does not make design decisions,
  interpret arbitrary attachments, or perform implementation.
- Connector access remains read-only. No write-file, shell, git, or OAuth
  permission is added to ChatGPT.

Accepted baseline: [C2C Design Workflow v1 — FROZEN](docs/C2C-Design-Workflow-v1-FROZEN.md).
