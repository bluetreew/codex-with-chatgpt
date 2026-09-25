import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ArtifactKind = "document" | "log-sync";
export type ArtifactWriteMode = "create" | "replace";

export interface SyncArtifact {
  id: string;
  kind: ArtifactKind;
  fileName: string;
  targetPath: string;
  writeMode: ArtifactWriteMode;
  body: string;
}

export interface ParsedArtifactBundle {
  bundleId: string;
  afterSync: string;
  artifacts: SyncArtifact[];
}

const START = "[ARTIFACT_SYNC_BUNDLE]";
const END = "[END_ARTIFACT_SYNC_BUNDLE]";
const BLOCK_START = "<<<ARTIFACT";
const BLOCK_END = "<<<END_ARTIFACT>>>";

function requiredHeader(block: string, name: string): string {
  const match = block.match(new RegExp(`^${name}:\\s*(.+)$`, "mi"));
  if (!match) throw new Error(`artifact is missing ${name}`);
  return match[1].trim();
}

/** Parse the plain-text transport envelope. Artifact bodies are copied verbatim. */
export function parseArtifactBundle(input: string): ParsedArtifactBundle {
  const lineEnding = input.match(/\r\n|\n|\r/)?.[0] ?? "\n";
  const lines = input.split(/\r\n|\n|\r/);
  const start = lines.indexOf(START);
  const end = lines.lastIndexOf(END);
  if (start < 0 || end <= start || lines.slice(0, start).some((line) => line.trim())) {
    throw new Error("invalid Artifact Sync bundle envelope");
  }
  if (lines.slice(end + 1).some((line) => line.trim())) throw new Error("unexpected content after bundle");
  const firstArtifact = lines.indexOf(BLOCK_START, start + 1);
  const headerEnd = firstArtifact < 0 ? end : firstArtifact;
  const header = lines.slice(start + 1, headerEnd).join("\n");
  const bundleId = requiredHeader(header, "BUNDLE_ID");
  const afterSync = requiredHeader(header, "AFTER_SYNC");
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(bundleId)) throw new Error("invalid BUNDLE_ID");
  const count = Number(requiredHeader(header, "ARTIFACT_COUNT"));
  if (!Number.isSafeInteger(count) || count < 1 || count > 50) throw new Error("invalid ARTIFACT_COUNT");

  const artifacts: SyncArtifact[] = [];
  let cursor = headerEnd;
  while (cursor < end) {
    while (cursor < end && !lines[cursor].trim()) cursor++;
    if (cursor >= end) break;
    if (lines[cursor] !== BLOCK_START) throw new Error("expected <<<ARTIFACT");
    const blockHeader: string[] = [];
    cursor++;
    while (cursor < end && lines[cursor] !== ">>>") blockHeader.push(lines[cursor++]);
    if (lines[cursor] !== ">>>") throw new Error("unterminated artifact header");
    cursor++;
    const body: string[] = [];
    while (cursor < end && lines[cursor] !== BLOCK_END) body.push(lines[cursor++]);
    if (lines[cursor] !== BLOCK_END) throw new Error("unterminated artifact body");
    cursor++;
    const block = blockHeader.join("\n");
    const kind = requiredHeader(block, "KIND");
    const writeMode = requiredHeader(block, "WRITE_MODE");
    if (kind !== "document" && kind !== "log-sync") throw new Error("unsupported artifact KIND");
    if (writeMode !== "create" && writeMode !== "replace") throw new Error("unsupported WRITE_MODE");
    const id = requiredHeader(block, "ARTIFACT_ID");
    const fileName = requiredHeader(block, "FILE_NAME");
    const targetPath = requiredHeader(block, "TARGET_PATH");
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(id)) throw new Error("invalid ARTIFACT_ID");
    if (path.posix.basename(targetPath.replace(/\\/g, "/")) !== fileName) throw new Error("FILE_NAME must match TARGET_PATH basename");
    artifacts.push({
      id,
      kind,
      fileName,
      targetPath,
      writeMode,
      body: body.join(lineEnding),
    });
  }
  if (artifacts.length !== count) throw new Error("ARTIFACT_COUNT does not match parsed artifacts");
  const ids = new Set<string>();
  const targets = new Set<string>();
  for (const artifact of artifacts) {
    const target = artifact.targetPath.replace(/\\/g, "/").toLowerCase();
    if (ids.has(artifact.id) || targets.has(target)) throw new Error("duplicate artifact id or target path");
    ids.add(artifact.id);
    targets.add(target);
  }
  return { bundleId, afterSync, artifacts };
}

function safeTargetPath(workspaceRoot: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new Error("artifact target must be a relative workspace path");
  }
  const normalizedInput = relativePath.replace(/\\/g, "/");
  const pieces = normalizedInput.split("/");
  if (pieces.some((piece) => !piece || piece === "." || piece === ".." || /[<>:"|?*]/.test(piece))) {
    throw new Error("artifact target contains an unsafe path segment");
  }
  if (path.posix.extname(normalizedInput).toLowerCase() !== ".md") throw new Error("only .md artifacts are supported");
  if (pieces.some((piece) => piece.toLowerCase() === ".git" || /^\.env/i.test(piece) || /secret|credential/i.test(piece))) {
    throw new Error("artifact target is in a protected path");
  }
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, ...pieces);
  if (!target.startsWith(root + path.sep)) throw new Error("artifact target escapes workspace");
  let current = root;
  for (const piece of pieces.slice(0, -1)) {
    current = path.join(current, piece);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("artifact target traverses a non-directory or symlink");
      if (!fs.realpathSync(current).startsWith(fs.realpathSync(root) + path.sep)) throw new Error("artifact target escapes workspace");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error("artifact target may not be a symlink");
    if (!stat.isFile()) throw new Error("artifact target must be a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
}

/** Validate every declared destination before the CLI starts writing any of them. */
export function validateArtifactTargets(workspaceRoot: string, artifacts: SyncArtifact[]): void {
  for (const artifact of artifacts) {
    const target = safeTargetPath(workspaceRoot, artifact.targetPath);
    const exists = fs.existsSync(target);
    if (artifact.writeMode === "create" && exists) throw new Error(`create mode refuses to overwrite: ${artifact.targetPath}`);
    if (artifact.writeMode === "replace" && !exists) throw new Error(`replace mode requires existing target: ${artifact.targetPath}`);
  }
}

export interface ArtifactReceiptEntry {
  artifactId: string;
  targetPath: string;
  size: number;
  sha256: string;
  status: "SUCCESS";
}

export function formatArtifactSyncReceipt(bundleId: string, saved: ArtifactReceiptEntry[]): string {
  const entries = saved.map((item) => [
    `- ARTIFACT_ID: ${item.artifactId}`,
    `  PATH: ${item.targetPath}`,
    `  SIZE: ${item.size}`,
    `  SHA256: ${item.sha256}`,
  ].join("\n"));
  return [
    "[ARTIFACT_SYNC_RECEIPT]",
    "",
    `BUNDLE_ID: ${bundleId}`,
    "",
    "STATUS: SUCCESS",
    "",
    "SAVED:",
    ...entries,
    "",
    "NO_IMPLEMENTATION_PERFORMED: true",
    "",
    "NEXT_ACTION:",
    "Verify the synchronized files through the workspace connector.",
    "Continue design discussion unless the user explicitly authorizes implementation.",
  ].join("\n");
}

/** Materialize one declared Markdown artifact atomically and verify exact bytes. */
export function materializeArtifact(
  workspaceRoot: string,
  artifact: SyncArtifact
): ArtifactReceiptEntry {
  const target = safeTargetPath(workspaceRoot, artifact.targetPath);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  // Re-check after directory creation to catch symlink/junction insertion.
  if (safeTargetPath(workspaceRoot, artifact.targetPath) !== target) throw new Error("artifact target changed during validation");
  const exists = fs.existsSync(target);
  if (artifact.writeMode === "create" && exists) throw new Error("create mode refuses to overwrite an existing file");
  if (artifact.writeMode === "replace" && !exists) throw new Error("replace mode requires the declared target to exist");

  const bytes = Buffer.from(artifact.body, "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const temp = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
    const written = fs.readFileSync(temp);
    if (!written.equals(bytes)) throw new Error("temporary artifact verification failed");
    if (safeTargetPath(workspaceRoot, artifact.targetPath) !== target) throw new Error("artifact target changed before commit");
    if (artifact.writeMode === "create") {
      // A hard-link install is atomic and refuses to clobber a racing create.
      fs.linkSync(temp, target);
      fs.unlinkSync(temp);
    } else {
      fs.renameSync(temp, target);
    }
    const saved = fs.readFileSync(target);
    const savedHash = createHash("sha256").update(saved).digest("hex");
    if (!saved.equals(bytes) || savedHash !== digest) throw new Error("saved artifact verification failed");
    return { artifactId: artifact.id, targetPath: artifact.targetPath, size: saved.byteLength, sha256: savedHash, status: "SUCCESS" };
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  }
}
