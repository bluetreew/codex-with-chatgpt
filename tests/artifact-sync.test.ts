import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { formatArtifactSyncReceipt, materializeArtifact, parseArtifactBundle } from "../src/artifact-sync.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const dirs: string[] = [];
const root = () => {
  const dir = makeTmpDir("artifact-sync");
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs) cleanup(dir);
  dirs.length = 0;
});

function bundle(items: string[], newline = "\n"): string {
  return [
    "[ARTIFACT_SYNC_BUNDLE]",
    "BUNDLE_ID: test-bundle",
    "AFTER_SYNC: return-to-design",
    `ARTIFACT_COUNT: ${items.length}`,
    ...items,
    "[END_ARTIFACT_SYNC_BUNDLE]",
  ].join(newline);
}

function artifact(id: string, target: string, mode = "create", body = "# hello\n"): string {
  return [
    "<<<ARTIFACT",
    `ARTIFACT_ID: ${id}`,
    "KIND: document",
    `FILE_NAME: ${path.posix.basename(target)}`,
    `TARGET_PATH: ${target}`,
    `WRITE_MODE: ${mode}`,
    ">>>",
    body.replace(/\n/g, "\n"),
    "<<<END_ARTIFACT>>>",
  ].join("\n");
}

describe("parseArtifactBundle", () => {
  it("parses one artifact", () => {
    const parsed = parseArtifactBundle(bundle([artifact("a1", "docs/a.md")]));
    expect(parsed.artifacts).toHaveLength(1);
    expect(parsed.artifacts[0]).toMatchObject({ id: "a1", kind: "document", targetPath: "docs/a.md" });
  });

  it("parses multiple artifacts with both supported kinds", () => {
    const second = artifact("a2", "docs/log.md").replace("KIND: document", "KIND: log-sync");
    expect(parseArtifactBundle(bundle([artifact("a1", "docs/a.md"), second])).artifacts.map((a) => a.kind)).toEqual([
      "document",
      "log-sync",
    ]);
  });

  it("does not truncate nested Markdown code fences", () => {
    const body = "# Example\n```ts\nconst x = 1;\n```\n";
    expect(parseArtifactBundle(bundle([artifact("a1", "docs/a.md", "create", body)])).artifacts[0].body).toBe(body);
  });

  it("preserves CRLF in the Markdown body", () => {
    const text = bundle([artifact("a1", "docs/a.md", "create", "first\nsecond\n")], "\r\n");
    expect(parseArtifactBundle(text).artifacts[0].body).toContain("\r\n");
  });

  it("rejects count mismatch, duplicate ids, and unsupported artifact types", () => {
    expect(() => parseArtifactBundle(bundle([artifact("a1", "docs/a.md")]).replace("ARTIFACT_COUNT: 1", "ARTIFACT_COUNT: 2"))).toThrow(/ARTIFACT_COUNT/);
    expect(() => parseArtifactBundle(bundle([artifact("x", "docs/a.md"), artifact("x", "docs/b.md")]))).toThrow(/duplicate/);
    const bad = artifact("a1", "docs/a.md").replace("KIND: document", "KIND: source-code");
    expect(() => parseArtifactBundle(bundle([bad]))).toThrow(/KIND/);
  });
});

describe("materializeArtifact", () => {
  it("rejects traversal, absolute paths, non-Markdown, and protected destinations", () => {
    const workspace = root();
    for (const target of ["../outside.md", "C:\\outside.md", ".git/config.md", ".env.md", "docs/file.txt"]) {
      expect(() => materializeArtifact(workspace, parseArtifactBundle(bundle([artifact("x", target)])).artifacts[0])).toThrow();
    }
  });

  it("fails safe for create and only replaces an explicitly declared existing Markdown file", () => {
    const workspace = root();
    const create = parseArtifactBundle(bundle([artifact("x", "docs/a.md")])).artifacts[0];
    const first = materializeArtifact(workspace, create);
    expect(() => materializeArtifact(workspace, create)).toThrow(/refuses to overwrite/);
    const replacement = { ...create, writeMode: "replace" as const, body: "# replaced\n" };
    expect(materializeArtifact(workspace, replacement).sha256).not.toBe(first.sha256);
    expect(fs.readFileSync(path.join(workspace, "docs/a.md"), "utf8")).toBe(replacement.body);
    expect(() => materializeArtifact(workspace, { ...replacement, targetPath: "docs/missing.md" })).toThrow(/requires the declared target/);
  });

  it("verifies exact bytes and returns size plus SHA256", () => {
    const workspace = root();
    const source = "# UTF-8 中文\n```js\nconst value = 1;\n```\n";
    const saved = materializeArtifact(workspace, parseArtifactBundle(bundle([artifact("x", "docs/a.md", "create", source)])).artifacts[0]);
    const bytes = fs.readFileSync(path.join(workspace, "docs/a.md"));
    expect(saved.size).toBe(bytes.byteLength);
    expect(saved.sha256).toBe(createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex"));
    expect(bytes.toString("utf8")).toBe(source);
  });

  it("formats a receipt without claiming any implementation protocol state", () => {
    const workspace = root();
    const saved = materializeArtifact(workspace, parseArtifactBundle(bundle([artifact("x", "docs/a.md")])).artifacts[0]);
    const receipt = formatArtifactSyncReceipt("test-bundle", [saved]);
    expect(receipt).toContain("[ARTIFACT_SYNC_RECEIPT]");
    expect(receipt).toContain("NO_IMPLEMENTATION_PERFORMED: true");
    expect(receipt).toContain(`SHA256: ${saved.sha256}`);
    expect(receipt).not.toContain("STATE: EXECUTED");
  });
});
