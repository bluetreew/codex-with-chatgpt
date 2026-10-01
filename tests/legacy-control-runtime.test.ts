import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeLegacyRetirementMarker,
  inspectLegacyControlRuntime,
  legacyRetirementIntentFile,
  parseLegacyProcessProbeResult,
  retireExactLegacyControlRuntime,
  waitForLegacyRetirement,
  type LegacyAdminInfo,
  type LegacyProcessEvidence,
} from "../src/bridge/legacy-control-runtime.js";
import type { RuntimeState } from "../src/bridge/runtime.js";
import { cleanup } from "./helpers.js";

const roots: string[] = [];
const workspaceRoot = path.join(os.tmpdir(), "c2c-control-workspace-fixture");
const workspaceId = "abcdef123456";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-legacy-control-"));
  roots.push(root);
  const legacyStateDirectory = path.join(root, "legacy-state");
  const controlStateDirectory = path.join(root, "canonical-state");
  const runtimeDirectory = path.join(legacyStateDirectory, "runtime");
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  fs.mkdirSync(controlStateDirectory, { recursive: true });
  const processCreatedAt = "2025-01-01T00:00:00.000Z";
  const readyAt = "2025-01-01T00:00:03.000Z";
  const runtime: RuntimeState = {
    service: "c2c-bridge",
    version: "fixture",
    workspaceId,
    workspaceRoot,
    pid: 12345,
    port: 48765,
    adminToken: "fixture-token-never-log-this",
    publicUrl: null,
    startedAt: readyAt,
    processCreatedAt,
  };
  fs.writeFileSync(path.join(runtimeDirectory, `${workspaceId}.json`), JSON.stringify(runtime));
  const processEvidence: LegacyProcessEvidence = {
    state: "PRESENT",
    processId: runtime.pid,
    createdAt: processCreatedAt,
    executablePath: "C:\\Program Files\\nodejs\\node.exe",
    commandLine: `node D:\\legacy\\dist\\cli\\index.js serve --workspace "${workspaceRoot}"`,
    listenerQuery: {
      status: "ok",
      listeners: [{ localAddress: "127.0.0.1", localPort: runtime.port, ownerPid: runtime.pid }],
    },
  };
  const adminInfo: LegacyAdminInfo = {
    status: 200,
    body: {
      service: runtime.service,
      workspaceId: runtime.workspaceId,
      workspaceRoot: runtime.workspaceRoot,
      pid: runtime.pid,
      port: runtime.port,
      startedAt: runtime.startedAt,
    },
  };
  return { root, legacyStateDirectory, controlStateDirectory, runtime, processEvidence, adminInfo };
}

afterEach(() => {
  for (const root of roots.splice(0)) cleanup(root);
});

describe("fixed legacy CONTROL runtime ownership", () => {
  it("requires process, loopback listener, authenticated admin info, and health to all match", async () => {
    const value = fixture();
    const result = await inspectLegacyControlRuntime(workspaceId, workspaceRoot, {
      legacyStateDirectory: value.legacyStateDirectory,
      processEvidence: () => value.processEvidence,
      adminInfo: async () => value.adminInfo,
      health: async () => true,
    });
    expect(result).toEqual({ disposition: "EXACT", runtime: value.runtime });
  });

  it.each([
    ["PID reused with a different OS start time", (value: ReturnType<typeof fixture>) => ({ ...value.processEvidence, createdAt: new Date(Date.now() - 600_000).toISOString() })],
    ["unrelated process command line", (value: ReturnType<typeof fixture>) => ({ ...value.processEvidence, commandLine: "node other.js" })],
    ["non-Node executable", (value: ReturnType<typeof fixture>) => ({ ...value.processEvidence, executablePath: "C:\\other\\app.exe" })],
    ["listener owned by another PID", (value: ReturnType<typeof fixture>) => ({ ...value.processEvidence, listenerQuery: { status: "ok" as const, listeners: [{ ...value.processEvidence.listenerQuery.listeners[0]!, ownerPid: 99999 }] } })],
    ["listener address is not exact loopback", (value: ReturnType<typeof fixture>) => ({ ...value.processEvidence, listenerQuery: { status: "ok" as const, listeners: [{ ...value.processEvidence.listenerQuery.listeners[0]!, localAddress: "0.0.0.0" }] } })],
    ["OS process ID differs from the record", (value: ReturnType<typeof fixture>) => ({ ...value.processEvidence, processId: 99999 })],
    ["listener port differs from the record", (value: ReturnType<typeof fixture>) => ({ ...value.processEvidence, listenerQuery: { status: "ok" as const, listeners: [{ ...value.processEvidence.listenerQuery.listeners[0]!, localPort: 48766 }] } })],
  ])("fails closed for %s", async (_name, makeEvidence) => {
    const value = fixture();
    const result = await inspectLegacyControlRuntime(workspaceId, workspaceRoot, {
      legacyStateDirectory: value.legacyStateDirectory,
      processEvidence: () => makeEvidence(value),
      adminInfo: async () => value.adminInfo,
      health: async () => true,
    });
    expect(result.disposition).toBe("CONFLICT");
  });

  it.each([
    ["authenticated admin endpoint unavailable", async (_value: ReturnType<typeof fixture>) => ({ status: 401, body: null })],
    ["admin endpoint returns non-200", async (_value: ReturnType<typeof fixture>) => ({ status: 204, body: {} })],
    ["admin identity differs", async (value: ReturnType<typeof fixture>) => ({ ...value.adminInfo, body: { ...(value.adminInfo.body as object), workspaceId: "other" } })],
  ])("does not claim ownership when %s", async (_name, makeAdmin) => {
    const value = fixture();
    const result = await inspectLegacyControlRuntime(workspaceId, workspaceRoot, {
      legacyStateDirectory: value.legacyStateDirectory,
      processEvidence: () => value.processEvidence,
      adminInfo: async () => makeAdmin(value),
      health: async () => true,
    });
    expect(result.disposition).toBe("CONFLICT");
  });

  it("classifies a dead PID with no listener as stale without mutating the old record", async () => {
    const value = fixture();
    const record = fs.readFileSync(path.join(value.legacyStateDirectory, "runtime", `${workspaceId}.json`), "utf8");
    const result = await inspectLegacyControlRuntime(workspaceId, workspaceRoot, {
      legacyStateDirectory: value.legacyStateDirectory,
      processEvidence: () => ({ state: "MISSING", listenerQuery: { status: "ok", listeners: [] } }),
    });
    expect(result).toEqual({ disposition: "STALE", reason: "PROCESS_MISSING" });
    expect(fs.readFileSync(path.join(value.legacyStateDirectory, "runtime", `${workspaceId}.json`), "utf8")).toBe(record);
  });

  it("fails closed on legacy runtime records without authoritative processCreatedAt", async () => {
    const value = fixture();
    const oldRecord = { ...value.runtime } as Partial<RuntimeState>;
    delete oldRecord.processCreatedAt;
    fs.writeFileSync(path.join(value.legacyStateDirectory, "runtime", `${workspaceId}.json`), JSON.stringify(oldRecord));
    const processEvidence = vi.fn(() => value.processEvidence);
    const adminInfo = vi.fn(async () => value.adminInfo);

    const result = await inspectLegacyControlRuntime(workspaceId, workspaceRoot, {
      legacyStateDirectory: value.legacyStateDirectory,
      processEvidence,
      adminInfo,
    });

    expect(result).toEqual({ disposition: "CONFLICT", reason: "LEGACY_RUNTIME_CREATION_PROVENANCE_MISSING" });
    expect(processEvidence).not.toHaveBeenCalled();
    expect(adminInfo).not.toHaveBeenCalled();
  });

  it.each([
    ["spawn EPERM", { status: null, stdout: "", error: { code: "EPERM", message: "spawn denied" } }],
    ["listener query ETIMEDOUT", { status: null, stdout: "", error: { code: "ETIMEDOUT", message: "query timed out" } }],
    ["non-zero query", { status: 1, stdout: "", error: null }],
    ["malformed output", { status: 0, stdout: "not json", error: null }],
    ["malformed listener payload", { status: 0, stdout: JSON.stringify({ process: null, listenerQuery: { status: "ok", listeners: "not-an-array" } }), error: null }],
  ] as const)("preserves listener query %s as structured error", async (_name, processResult) => {
    const evidence = parseLegacyProcessProbeResult(processResult);
    expect(evidence.listenerQuery.status).toBe("error");
    const value = fixture();
    const inspection = await inspectLegacyControlRuntime(workspaceId, workspaceRoot, {
      legacyStateDirectory: value.legacyStateDirectory,
      processEvidence: () => evidence,
    });
    expect(inspection).toMatchObject({ disposition: "CONFLICT" });
  });

  it("compares process creation timestamps at exact shared millisecond precision", async () => {
    const value = fixture();
    const exactEvidence = {
      ...value.processEvidence,
      createdAt: value.runtime.processCreatedAt!.replace("Z", "+00:00"),
    };
    const exact = await inspectLegacyControlRuntime(workspaceId, workspaceRoot, {
      legacyStateDirectory: value.legacyStateDirectory,
      processEvidence: () => exactEvidence,
      adminInfo: async () => value.adminInfo,
      health: async () => true,
    });
    expect(exact.disposition).toBe("EXACT");

    for (const differenceMs of [1, 1_000, 120_000]) {
      const mismatch = await inspectLegacyControlRuntime(workspaceId, workspaceRoot, {
        legacyStateDirectory: value.legacyStateDirectory,
        processEvidence: () => ({
          ...value.processEvidence,
          createdAt: new Date(Date.parse(value.runtime.processCreatedAt!) - differenceMs).toISOString(),
        }),
        adminInfo: async () => value.adminInfo,
        health: async () => true,
      });
      expect(mismatch.disposition).toBe("CONFLICT");
    }
  });

  it("blocks retirement when its listener verification query fails", async () => {
    const value = fixture();
    const evidence = parseLegacyProcessProbeResult({ status: 1, stdout: "", error: null });
    await expect(waitForLegacyRetirement(value.runtime, {
      processEvidence: async () => evidence,
      timeoutMs: 0,
    })).resolves.toBe(false);
  });

  it("returns RETIREMENT_INCOMPLETE when the post-shutdown listener query times out", async () => {
    const value = fixture();
    const timeoutEvidence = parseLegacyProcessProbeResult({
      status: null,
      stdout: "",
      error: { code: "ETIMEDOUT", message: "listener query timed out" },
    });
    let stopCount = 0;
    let canonicalStartCount = 0;
    const result = await retireExactLegacyControlRuntime(value.controlStateDirectory, value.runtime, {
      requestShutdown: async () => { stopCount += 1; return true; },
      waitForRetirement: (runtime) => waitForLegacyRetirement(runtime, {
        processEvidence: () => timeoutEvidence,
        timeoutMs: 0,
      }),
    });
    if (result === "RETIRED") canonicalStartCount += 1;

    expect(timeoutEvidence.listenerQuery.status).toBe("error");
    expect(result).toBe("INCOMPLETE");
    expect(stopCount).toBe(1);
    expect(canonicalStartCount).toBe(0);
  });

  it("does not declare retirement while the exact legacy PID is still running", async () => {
    const value = fixture();
    const controlRuntime = { ...value.runtime, workspaceRoot: "D:\\app_home\\codex-with-chatgpt" };
    const liveWithoutListener: LegacyProcessEvidence = {
      ...value.processEvidence,
      commandLine: 'node D:\\legacy\\dist\\cli\\index.js serve --workspace "D:\\app_home\\codex-with-chatgpt"',
      listenerQuery: { status: "ok", listeners: [] },
    };
    await expect(waitForLegacyRetirement(controlRuntime, {
      processEvidence: async () => liveWithoutListener,
      timeoutMs: 0,
    })).resolves.toBe(false);
  });

  it("fails closed if legacy state redirects through a junction", async () => {
    const value = fixture();
    const alias = path.join(value.root, "legacy-alias");
    try { fs.symlinkSync(value.legacyStateDirectory, alias, "junction"); }
    catch { return; }
    const result = await inspectLegacyControlRuntime(workspaceId, workspaceRoot, { legacyStateDirectory: alias });
    expect(result.disposition).toBe("CONFLICT");
  });
});

describe("atomic one-shot legacy retirement", () => {
  it("uses one real exclusive-create marker under concurrent same-runtime calls", async () => {
    const value = fixture();
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    let stopCount = 0;
    let startCount = 0;
    const options = {
      requestShutdown: async () => { stopCount += 1; await stopGate; return true; },
      waitForRetirement: async () => true,
    };
    const first = retireExactLegacyControlRuntime(value.controlStateDirectory, value.runtime, options);
    await Promise.resolve();
    const second = await retireExactLegacyControlRuntime(value.controlStateDirectory, value.runtime, options);
    if (second === "RETIRED") startCount += 1;
    releaseStop();
    const firstResult = await first;
    if (firstResult === "RETIRED") startCount += 1;
    expect(firstResult).toBe("RETIRED");
    expect(second).toBe("ALREADY_ATTEMPTED");
    expect(stopCount).toBe(1);
    expect(startCount).toBe(1);
  });

  it("keeps the marker after an uncertain stop so a later call cannot stop twice", async () => {
    const value = fixture();
    let stopCount = 0;
    const first = await retireExactLegacyControlRuntime(value.controlStateDirectory, value.runtime, {
      requestShutdown: async () => { stopCount += 1; return false; },
    });
    const second = await retireExactLegacyControlRuntime(value.controlStateDirectory, value.runtime, {
      requestShutdown: async () => { stopCount += 1; return true; },
      waitForRetirement: async () => true,
    });
    expect(first).toBe("INCOMPLETE");
    expect(second).toBe("ALREADY_ATTEMPTED");
    expect(stopCount).toBe(1);
  });

  it("blocks after a real progress-intent file collision without sending shutdown or retrying", async () => {
    const value = fixture();
    let stopCount = 0;
    fs.mkdirSync(path.dirname(legacyRetirementIntentFile(value.controlStateDirectory, value.runtime)), { recursive: true });
    fs.writeFileSync(legacyRetirementIntentFile(value.controlStateDirectory, value.runtime), "preexisting inconsistent intent", { flag: "wx" });
    const first = await retireExactLegacyControlRuntime(value.controlStateDirectory, value.runtime, {
      requestShutdown: async () => { stopCount += 1; return true; },
    });
    const retry = await retireExactLegacyControlRuntime(value.controlStateDirectory, value.runtime, {
      requestShutdown: async () => { stopCount += 1; return true; },
    });
    expect(first).toBe("INCOMPLETE");
    expect(retry).toBe("ALREADY_ATTEMPTED");
    expect(stopCount).toBe(0);
  });

  it("makes durable non-secret retirement intent visible before authenticated shutdown", async () => {
    const value = fixture();
    let intentVisibleAtStop = false;
    const result = await retireExactLegacyControlRuntime(value.controlStateDirectory, value.runtime, {
      requestShutdown: async () => {
        const intent = JSON.parse(fs.readFileSync(legacyRetirementIntentFile(value.controlStateDirectory, value.runtime), "utf8")) as Record<string, unknown>;
        intentVisibleAtStop = intent.attemptState === "RETIREMENT_ATTEMPTED" && !("adminToken" in intent);
        return false;
      },
    });
    expect(result).toBe("INCOMPLETE");
    expect(intentVisibleAtStop).toBe(true);
  });

  it("gives distinct runtime identities distinct durable markers", () => {
    const value = fixture();
    const nextRuntime = { ...value.runtime, pid: value.runtime.pid + 1, startedAt: new Date(Date.now() - 10_000).toISOString() };
    expect(consumeLegacyRetirementMarker(value.controlStateDirectory, value.runtime)).toBe("CREATED");
    expect(consumeLegacyRetirementMarker(value.controlStateDirectory, nextRuntime)).toBe("CREATED");
  });
});
