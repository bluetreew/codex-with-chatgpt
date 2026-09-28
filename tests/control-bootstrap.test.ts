import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeObservation, RuntimeState } from "../src/bridge/runtime.js";
import {
  APPROVED_CONTROL_BOOTSTRAP_IDENTITIES,
  controlBootstrapRetryMarkerFile,
  createControlBootstrapRetryMarker,
  probeControlStateDirectoryWrite,
  readControlBootstrapProgress,
  runControlBootstrap,
  validateControlBootstrapIsolation,
  type ControlBootstrapAdapter,
  type ControlBootstrapIdentities,
  type ControlBootstrapInput,
  type StateDirectoryWriteProbe,
} from "../src/control-bootstrap.js";
import type { ExecutionProbe } from "../src/recovery/harness.js";
import type { BridgeProbeObservation } from "../src/recovery/probe.js";

const roots: string[] = [];

const junctionFixtureSupported = (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-control-junction-capability-"));
  try {
    fs.mkdirSync(path.join(root, "target"));
    fs.symlinkSync(path.join(root, "target"), path.join(root, "alias"), "junction");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-control-bootstrap-"));
  roots.push(root);
  const controlWorkspaceRoot = path.join(root, "codex-with-chatgpt");
  const controlStateDir = path.join(root, "c2c-repair-control-state");
  const targetWorkspaceRoot = path.join(root, "mozi");
  const targetStateDir = path.join(root, "target-state");
  fs.mkdirSync(controlWorkspaceRoot, { recursive: true });
  fs.mkdirSync(targetWorkspaceRoot, { recursive: true });
  fs.mkdirSync(targetStateDir, { recursive: true });
  const approvedIdentities: ControlBootstrapIdentities = {
    controlWorkspaceRoot,
    controlStateDir,
    targetWorkspaceRoot,
    targetStateDir,
  };
  const input: ControlBootstrapInput = {
    workspaceId: "control-workspace-id",
    controlWorkspaceRoot,
    controlStateDir,
    targetWorkspaceRoot,
    targetStateDir,
    capableContextRetry: false,
  };
  return { root, input, approvedIdentities };
}

function probe(classification: ExecutionProbe["classification"] = "CAPABLE", relayFork: ExecutionProbe["relayFork"] = "PASS"): ExecutionProbe {
  return {
    nodeChildSpawn: classification === "CAPABLE" ? "PASS" : "PASS",
    cloudflaredSpawn: "PASS",
    relayFork,
    classification,
  };
}

function runtime(workspaceId: string, workspaceRoot: string): RuntimeState {
  return {
    service: "c2c-bridge",
    version: "fixture",
    workspaceId,
    workspaceRoot,
    pid: 43210,
    port: 48765,
    adminToken: "fixture-admin-token",
    publicUrl: null,
    startedAt: new Date(0).toISOString(),
  };
}

function bridgeProbe(options: { relayFork?: "PASS" | "EPERM" } = {}): BridgeProbeObservation {
  const status = options.relayFork ?? "PASS";
  return {
    bridgeInfoHealthy: true,
    bridgeInfoStatus: 200,
    bridgeInfoErrorKind: null,
    bridgeProbe: {
      nodeChildSpawn: "PASS",
      cloudflaredSpawn: "PASS",
      relayFork: status,
      classification: status === "PASS" ? "CAPABLE" : "RESTRICTED_BRIDGE_CONTEXT",
    },
    bridgeProbeStatus: 200,
    bridgeProbeErrorKind: null,
  };
}

function healthyObservation(input: ControlBootstrapInput): BridgeObservation {
  return { state: "healthy", runtime: runtime(input.workspaceId, input.controlWorkspaceRoot) };
}

function stoppedObservation(): BridgeObservation {
  return { state: "stopped", runtime: null, reason: "runtime_missing" };
}

function adapter(input: ControlBootstrapInput, overrides: {
  writeProbe?: StateDirectoryWriteProbe;
  localProbes?: ExecutionProbe[];
  observation?: BridgeObservation;
  bridgeProbe?: BridgeProbeObservation;
  approvedIdentities?: ControlBootstrapIdentities;
} = {}) {
  let localIndex = 0;
  const localProbes = overrides.localProbes ?? [probe()];
  const value: ControlBootstrapAdapter = {
    approvedIdentities: overrides.approvedIdentities ?? {
      controlWorkspaceRoot: input.controlWorkspaceRoot,
      controlStateDir: input.controlStateDir,
      targetWorkspaceRoot: input.targetWorkspaceRoot,
      targetStateDir: input.targetStateDir,
    },
    stateDirectoryWriteProbe: vi.fn(() => overrides.writeProbe ?? probeControlStateDirectoryWrite(input.controlStateDir)),
    localProbe: vi.fn(async () => localProbes[Math.min(localIndex++, localProbes.length - 1)]),
    findBridge: vi.fn(async () => overrides.observation ?? healthyObservation(input)),
    startBridge: vi.fn(async (workspaceRoot) => ({ runtime: runtime(input.workspaceId, workspaceRoot), spawned: true })),
    bridgeProbe: vi.fn(async () => overrides.bridgeProbe ?? bridgeProbe()),
  };
  return value;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("CONTROL bootstrap capable execution handoff", () => {
  it("pins the production canonical identities to the approved CONTROL and TARGET paths", () => {
    expect(APPROVED_CONTROL_BOOTSTRAP_IDENTITIES).toEqual({
      controlWorkspaceRoot: "D:\\app_home\\codex-with-chatgpt",
      controlStateDir: "C:\\Users\\66483\\AppData\\Local\\codex-with-chatgpt\\c2c-repair-control-state",
      targetWorkspaceRoot: "D:\\workshop\\职业教育-MOZI",
      targetStateDir: "D:\\app_home\\codex-with-chatgpt-state",
    });
  });

  it("accepts canonical fixture identities and a case-only Windows spelling without creating CONTROL state", () => {
    const { input, approvedIdentities } = fixture();
    expect(validateControlBootstrapIsolation(input, approvedIdentities)).toBeNull();
    const caseOnly = {
      ...input,
      controlWorkspaceRoot: input.controlWorkspaceRoot.toUpperCase(),
      controlStateDir: input.controlStateDir.toUpperCase(),
      targetWorkspaceRoot: input.targetWorkspaceRoot.toUpperCase(),
      targetStateDir: input.targetStateDir.toUpperCase(),
    };
    expect(validateControlBootstrapIsolation(caseOnly, approvedIdentities)).toBeNull();
    expect(fs.existsSync(approvedIdentities.controlStateDir)).toBe(false);
  });

  it.each([
    "controlWorkspaceRoot",
    "controlStateDir",
    "targetWorkspaceRoot",
    "targetStateDir",
  ] as const)("rejects an overridden canonical identity (%s) before any mutation", async (key) => {
    const { input, root, approvedIdentities } = fixture();
    const changed = { ...input, [key]: path.join(root, "attacker-selected") };
    const deps = adapter(changed, { approvedIdentities });
    const result = await runControlBootstrap(changed, deps);
    expect(result).toMatchObject({ state: "CONTROL_BOOTSTRAP_BLOCKED", reason: "CONTROL_IDENTITY_MISMATCH" });
    expect(deps.stateDirectoryWriteProbe).not.toHaveBeenCalled();
    expect(deps.localProbe).not.toHaveBeenCalled();
    expect(deps.findBridge).not.toHaveBeenCalled();
    expect(deps.startBridge).not.toHaveBeenCalled();
  });

  it("rejects .. traversal aliases and a wrong CONTROL state parent without creating either path", () => {
    const { input, approvedIdentities, root } = fixture();
    const traversal = { ...input, controlWorkspaceRoot: `${root}\\extra\\..\\codex-with-chatgpt` };
    const alternateState = { ...input, controlStateDir: path.join(root, "other", "c2c-repair-control-state") };
    expect(validateControlBootstrapIsolation(traversal, approvedIdentities)).toBe("CONTROL_IDENTITY_MISMATCH");
    expect(validateControlBootstrapIsolation(alternateState, approvedIdentities)).toBe("CONTROL_IDENTITY_MISMATCH");
    expect(fs.existsSync(alternateState.controlStateDir)).toBe(false);
  });

  it.skipIf(!junctionFixtureSupported)("resolves junction aliases and rejects aliases to a different filesystem identity", () => {
    const { input, approvedIdentities, root } = fixture();
    const alias = path.join(root, "control-alias");
    const different = path.join(root, "different-workspace");
    fs.mkdirSync(different);
    fs.symlinkSync(different, alias, "junction");
    expect(validateControlBootstrapIsolation({ ...input, controlWorkspaceRoot: alias }, approvedIdentities))
      .toBe("CONTROL_IDENTITY_MISMATCH");
  });

  it("rejects simultaneous replacement of both TARGET identities before mutation", async () => {
    const { input, root, approvedIdentities } = fixture();
    const changed = {
      ...input,
      targetWorkspaceRoot: path.join(root, "substitute-target"),
      targetStateDir: path.join(root, "substitute-target-state"),
    };
    const deps = adapter(changed, { approvedIdentities });
    const result = await runControlBootstrap(changed, deps);
    expect(result).toMatchObject({ state: "CONTROL_BOOTSTRAP_BLOCKED", reason: "CONTROL_IDENTITY_MISMATCH" });
    expect(deps.stateDirectoryWriteProbe).not.toHaveBeenCalled();
    expect(deps.localProbe).not.toHaveBeenCalled();
  });

  it("probes state-directory create/read/delete without leaving a temp file", () => {
    const { input } = fixture();
    const result = probeControlStateDirectoryWrite(input.controlStateDir);
    expect(result).toEqual({ ok: true, created: true, readBack: true, deleted: true });
    expect(fs.readdirSync(input.controlStateDir)).toEqual([]);
  });

  it("rejects TARGET-overlapping paths before probing or starting any Bridge", async () => {
    const { input, approvedIdentities } = fixture();
    input.controlStateDir = input.targetStateDir;
    const deps = adapter(input, { approvedIdentities });
    const result = await runControlBootstrap(input, deps);
    expect(result).toMatchObject({ state: "CONTROL_BOOTSTRAP_BLOCKED", reason: "CONTROL_IDENTITY_MISMATCH" });
    expect(deps.stateDirectoryWriteProbe).not.toHaveBeenCalled();
    expect(deps.localProbe).not.toHaveBeenCalled();
    expect(deps.startBridge).not.toHaveBeenCalled();
  });

  it("rejects a state directory nested in the MCP-exposed CONTROL workspace", async () => {
    const { input, approvedIdentities } = fixture();
    input.controlStateDir = path.join(input.controlWorkspaceRoot, ".c2c-control-state");
    const deps = adapter(input, { approvedIdentities });
    const result = await runControlBootstrap(input, deps);
    expect(result).toMatchObject({ state: "CONTROL_BOOTSTRAP_BLOCKED", reason: "CONTROL_IDENTITY_MISMATCH" });
    expect(deps.stateDirectoryWriteProbe).not.toHaveBeenCalled();
    expect(deps.localProbe).not.toHaveBeenCalled();
  });

  it("requests one capable-context retry for restricted local relay fork", async () => {
    const { input } = fixture();
    const restricted = probe("RESTRICTED_EXECUTION_CONTEXT", "EPERM");
    const deps = adapter(input, { localProbes: [restricted] });
    const result = await runControlBootstrap(input, deps);
    expect(result).toMatchObject({
      ok: false,
      state: "CONTROL_CAPABLE_CONTEXT_REQUIRED",
      nextAction: "RETRY_CAPABLE_CONTEXT",
      capableContextAttempted: false,
      localProbe: restricted,
    });
    expect(readControlBootstrapProgress(input.controlStateDir, input.workspaceId)).toMatchObject({
      state: "CONTROL_CAPABLE_CONTEXT_REQUIRED",
      capableContextAttempted: false,
    });
    expect(deps.findBridge).not.toHaveBeenCalled();
    expect(deps.startBridge).not.toHaveBeenCalled();
  });

  it("issues exactly one retry handoff when concurrent restricted probes race", async () => {
    const { input } = fixture();
    const restricted = probe("RESTRICTED_EXECUTION_CONTEXT", "EPERM");
    const deps = adapter(input, { localProbes: [restricted, restricted] });
    const results = await Promise.all([
      runControlBootstrap(input, deps),
      runControlBootstrap(input, deps),
    ]);
    expect(results.filter((result) => result.nextAction === "RETRY_CAPABLE_CONTEXT")).toHaveLength(1);
    expect(results.filter((result) => result.state === "CONTROL_BOOTSTRAP_BLOCKED")).toHaveLength(1);
    expect(results.find((result) => result.state === "CONTROL_BOOTSTRAP_BLOCKED")?.reason)
      .toBe("CAPABLE_CONTEXT_HANDOFF_ALREADY_OFFERED");
    expect(fs.existsSync(controlBootstrapRetryMarkerFile(input.controlStateDir, "offered"))).toBe(true);
    expect(deps.startBridge).not.toHaveBeenCalled();
  });

  it("accepts capable retry evidence and reuses an already healthy Bridge without restart", async () => {
    const { input } = fixture();
    const deps = adapter(input, { localProbes: [probe("RESTRICTED_EXECUTION_CONTEXT", "EPERM"), probe()] });
    const first = await runControlBootstrap(input, deps);
    const retried = await runControlBootstrap({ ...input, capableContextRetry: true }, deps);
    expect(first.nextAction).toBe("RETRY_CAPABLE_CONTEXT");
    expect(retried).toMatchObject({ ok: true, state: "CONTROL_BRIDGE_READY", nextAction: "CONTROL_LOCAL_HEALTH_GATE", capableContextAttempted: true, bridgeStatus: "healthy" });
    expect(retried.bridgeProbe).toMatchObject({ bridgeInfoHealthy: true, bridgeProbe: { classification: "CAPABLE" } });
    expect(deps.startBridge).not.toHaveBeenCalled();
    expect(readControlBootstrapProgress(input.controlStateDir, input.workspaceId)?.state).toBe("CONTROL_BRIDGE_READY");
  });

  it("blocks after one capable retry fails and refuses a second retry", async () => {
    const { input } = fixture();
    const restricted = probe("RESTRICTED_EXECUTION_CONTEXT", "EPERM");
    const deps = adapter(input, { localProbes: [restricted, restricted, probe()] });
    expect((await runControlBootstrap(input, deps)).nextAction).toBe("RETRY_CAPABLE_CONTEXT");
    const failedRetry = await runControlBootstrap({ ...input, capableContextRetry: true }, deps);
    const secondRetry = await runControlBootstrap({ ...input, capableContextRetry: true }, deps);
    expect(failedRetry).toMatchObject({ state: "CONTROL_BOOTSTRAP_BLOCKED", reason: "BLOCKED_LOCAL_EXECUTION", capableContextAttempted: true });
    expect(secondRetry).toMatchObject({ state: "CONTROL_BOOTSTRAP_BLOCKED", reason: "BLOCKED_LOCAL_EXECUTION", capableContextAttempted: true });
    expect(deps.localProbe).toHaveBeenCalledTimes(2);
    expect(deps.startBridge).not.toHaveBeenCalled();
  });

  it("atomically consumes concurrent capable retries exactly once", async () => {
    const { input } = fixture();
    const restricted = probe("RESTRICTED_EXECUTION_CONTEXT", "EPERM");
    const deps = adapter(input, { localProbes: [restricted, probe(), probe()] });
    expect((await runControlBootstrap(input, deps)).nextAction).toBe("RETRY_CAPABLE_CONTEXT");
    const results = await Promise.all([
      runControlBootstrap({ ...input, capableContextRetry: true }, deps),
      runControlBootstrap({ ...input, capableContextRetry: true }, deps),
    ]);
    expect(results.filter((result) => result.state === "CONTROL_BRIDGE_READY")).toHaveLength(1);
    expect(results.filter((result) => result.state === "CONTROL_BOOTSTRAP_BLOCKED")).toHaveLength(1);
    expect(fs.existsSync(controlBootstrapRetryMarkerFile(input.controlStateDir, "consumed"))).toBe(true);
    expect(deps.localProbe).toHaveBeenCalledTimes(2);
    expect(deps.startBridge).not.toHaveBeenCalled();
  });

  it("fails closed after a crash leaves the consumed marker ahead of progress", async () => {
    const { input } = fixture();
    const restricted = probe("RESTRICTED_EXECUTION_CONTEXT", "EPERM");
    const deps = adapter(input, { localProbes: [restricted, probe()] });
    expect((await runControlBootstrap(input, deps)).nextAction).toBe("RETRY_CAPABLE_CONTEXT");
    expect(createControlBootstrapRetryMarker(input.controlStateDir, "consumed")).toBe("CREATED");
    const result = await runControlBootstrap({ ...input, capableContextRetry: true }, deps);
    expect(result).toMatchObject({
      state: "CONTROL_BOOTSTRAP_BLOCKED",
      reason: "CAPABLE_CONTEXT_MARKER_PROGRESS_INCONSISTENT",
      capableContextAttempted: true,
    });
    expect(fs.existsSync(controlBootstrapRetryMarkerFile(input.controlStateDir, "consumed"))).toBe(true);
    expect(deps.localProbe).toHaveBeenCalledTimes(1);
    expect(deps.startBridge).not.toHaveBeenCalled();
  });

  it("blocks an unapproved or repeated retry flag", async () => {
    const { input } = fixture();
    const deps = adapter(input);
    const result = await runControlBootstrap({ ...input, capableContextRetry: true }, deps);
    expect(result).toMatchObject({ state: "CONTROL_BOOTSTRAP_BLOCKED", reason: "CAPABLE_CONTEXT_RETRY_NOT_AUTHORIZED" });
    expect(deps.localProbe).not.toHaveBeenCalled();
    expect(deps.startBridge).not.toHaveBeenCalled();
  });

  it("blocks if effective AppData state write probe fails before process probes", async () => {
    const { input } = fixture();
    const deps = adapter(input, { writeProbe: { ok: false, created: false, readBack: false, deleted: false, failureCode: "EACCES" } });
    const result = await runControlBootstrap(input, deps);
    expect(result).toMatchObject({ state: "CONTROL_BOOTSTRAP_BLOCKED", reason: "CONTROL_STATE_NOT_WRITABLE" });
    expect(deps.localProbe).not.toHaveBeenCalled();
    expect(deps.findBridge).not.toHaveBeenCalled();
  });

  it("starts a stopped CONTROL Bridge only after local capability passes, then verifies Bridge-side probe", async () => {
    const { input } = fixture();
    const deps = adapter(input, { observation: stoppedObservation() });
    const result = await runControlBootstrap(input, deps);
    expect(result).toMatchObject({ ok: true, state: "CONTROL_BRIDGE_READY", bridgeStatus: "healthy" });
    expect(deps.startBridge).toHaveBeenCalledTimes(1);
    expect(deps.startBridge).toHaveBeenCalledWith(input.controlWorkspaceRoot);
    expect(deps.bridgeProbe).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: input.workspaceId }), input.workspaceId);
  });

  it("does not restart an existing Bridge whose own relay probe fails", async () => {
    const { input } = fixture();
    const deps = adapter(input, { bridgeProbe: bridgeProbe({ relayFork: "EPERM" }) });
    const result = await runControlBootstrap(input, deps);
    expect(result).toMatchObject({ state: "CONTROL_BOOTSTRAP_BLOCKED", reason: "CONTROL_BRIDGE_CAPABILITY_FAILED" });
    expect(deps.findBridge).toHaveBeenCalledTimes(1);
    expect(deps.startBridge).not.toHaveBeenCalled();
  });

  it("never starts a second Bridge when the current Bridge state is unknown", async () => {
    const { input } = fixture();
    const deps = adapter(input, { observation: { state: "unknown", runtime: runtime(input.workspaceId, input.controlWorkspaceRoot), reason: "probe_failed" } });
    const result = await runControlBootstrap(input, deps);
    expect(result).toMatchObject({ state: "CONTROL_BOOTSTRAP_BLOCKED", reason: "CONTROL_BRIDGE_STATE_UNKNOWN" });
    expect(deps.startBridge).not.toHaveBeenCalled();
  });
});
