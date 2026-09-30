import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findBinary } from "../src/tunnel/detect.js";
import type { BridgeObservation, RuntimeState } from "../src/bridge/runtime.js";
import { networkProfileFile } from "../src/config/network-profile.js";
import {
  APPROVED_CONTROL_BOOTSTRAP_IDENTITIES,
  createControlBootstrapCliAdapter,
  controlBootstrapRetryMarkerFile,
  createControlBootstrapRetryMarker,
  probeControlStateDirectoryWrite,
  probeControlBootstrapLocalExecution,
  resolveControlBootstrapCloudflared,
  readControlBootstrapProgress,
  resolveTunnelPrecheckCloudflared,
  runControlBootstrap,
  validateControlBootstrapIsolation,
  type ControlBootstrapAdapter,
  type ControlBootstrapIdentities,
  type ControlBootstrapInput,
  type StateDirectoryWriteProbe,
} from "../src/control-bootstrap.js";
import { canonicalCodexDirectory, canonicalControlStateDirectory, managedCloudflaredDirectory } from "../src/config/paths.js";
import {
  inspectLegacyControlRuntime,
  parseLegacyProcessProbeResult,
  retireExactLegacyControlRuntime,
} from "../src/bridge/legacy-control-runtime.js";
import type { ExecutionProbe } from "../src/recovery/harness.js";
import { resolveApprovedCloudflaredPath, type BridgeProbeObservation, type ProbeAdapter } from "../src/recovery/probe.js";

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
  const homeDirectory = path.join(root, "home");
  fs.mkdirSync(controlWorkspaceRoot, { recursive: true });
  fs.mkdirSync(targetWorkspaceRoot, { recursive: true });
  fs.mkdirSync(targetStateDir, { recursive: true });
  fs.mkdirSync(homeDirectory, { recursive: true });
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
  return { root, input, approvedIdentities, homeDirectory, managedDirectory: path.join(homeDirectory, ".codex", "cloudflared") };
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

function writeFixture(directory: string, name: string, contents: string): string {
  const file = path.join(directory, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function adapter(input: ControlBootstrapInput, overrides: {
  writeProbe?: StateDirectoryWriteProbe;
  localProbes?: ExecutionProbe[];
  observation?: BridgeObservation;
  bridgeProbe?: BridgeProbeObservation;
  approvedIdentities?: ControlBootstrapIdentities;
  legacyRuntime?:
    | { disposition: "NONE" | "STALE" | "RETIRED" }
    | { disposition: "CONFLICT"; reason: "CONTROL_RUNTIME_IDENTITY_CONFLICT" | "LEGACY_RUNTIME_CREATION_PROVENANCE_MISSING" }
    | { disposition: "BLOCKED"; reason: "LEGACY_CONTROL_RUNTIME_RETIREMENT_INCOMPLETE" };
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
    reconcileLegacyRuntime: vi.fn(async () => overrides.legacyRuntime ?? ({ disposition: "NONE" as const })),
  };
  return value;
}

function cliWiredAdapter(
  input: ControlBootstrapInput,
  probeAdapter: ProbeAdapter,
  environment: NodeJS.ProcessEnv,
  managedDirectory?: string,
): ControlBootstrapAdapter {
  const { localProbe: _unusedMock, ...dependencies } = adapter(input);
  return createControlBootstrapCliAdapter(input.workspaceId, dependencies, { probeAdapter, environment, managedCloudflaredDirectory: managedDirectory });
}

async function withStateDirectory<T>(stateDir: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.C2C_STATE_DIR;
  process.env.C2C_STATE_DIR = stateDir;
  try { return await run(); }
  finally {
    if (previous === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previous;
  }
}

function cloudflaredProbeAdapter(approvedPath?: string, relayFork: "PASS" | "EPERM" = "EPERM") {
  const spawned: string[] = [];
  const adapter: ProbeAdapter = {
    spawnVersion(executable) {
      const resolved = path.resolve(executable);
      spawned.push(resolved);
      const allowed = [process.execPath, ...(approvedPath ? [approvedPath] : [])]
        .map((value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value));
      return allowed.includes(process.platform === "win32" ? resolved.toLowerCase() : resolved) ? "PASS" : "FAIL";
    },
    async forkRelay() { return relayFork; },
  };
  return { adapter, spawned };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("CONTROL bootstrap capable execution handoff", () => {
  it("pins the production canonical identities to the approved CONTROL and TARGET paths", () => {
    expect(APPROVED_CONTROL_BOOTSTRAP_IDENTITIES).toEqual({
      controlWorkspaceRoot: "D:\\app_home\\codex-with-chatgpt",
      controlStateDir: canonicalControlStateDirectory(),
      targetWorkspaceRoot: "D:\\workshop\\职业教育-MOZI",
      targetStateDir: "D:\\app_home\\codex-with-chatgpt-state",
    });
  });

  it("derives the canonical CONTROL state only from the canonical home .codex root", () => {
    const { root, homeDirectory } = fixture();
    const secondHome = path.join(root, "different-home");
    fs.mkdirSync(secondHome, { recursive: true });
    const firstRealHome = fs.realpathSync.native(homeDirectory);
    const secondRealHome = fs.realpathSync.native(secondHome);
    expect(canonicalControlStateDirectory(homeDirectory)).toBe(path.join(firstRealHome, ".codex", "c2c-repair-control-state"));
    expect(canonicalControlStateDirectory(secondHome)).toBe(path.join(secondRealHome, ".codex", "c2c-repair-control-state"));
    expect(canonicalControlStateDirectory()).toBe(path.join(fs.realpathSync.native(os.homedir()), ".codex", "c2c-repair-control-state"));
    expect(APPROVED_CONTROL_BOOTSTRAP_IDENTITIES.controlStateDir).toBe(canonicalControlStateDirectory());
    expect(fs.existsSync(canonicalControlStateDirectory())).toBe(false);
  });

  it("rejects the deprecated AppData path and package LocalCache as canonical CONTROL state", () => {
    const production = APPROVED_CONTROL_BOOTSTRAP_IDENTITIES;
    const userHome = fs.realpathSync.native(os.homedir());
    const appData = {
      ...production,
      controlStateDir: path.join(userHome, "AppData", "Local", "codex-with-chatgpt", "c2c-repair-control-state"),
    };
    const packageCache = {
      ...production,
      controlStateDir: path.join(userHome, "AppData", "Local", "Packages", "OpenAI.Codex_test", "LocalCache", "Local", "codex-with-chatgpt", "c2c-repair-control-state"),
    };
    expect(validateControlBootstrapIsolation(appData)).toBe("CONTROL_IDENTITY_MISMATCH");
    expect(validateControlBootstrapIsolation(packageCache)).toBe("CONTROL_IDENTITY_MISMATCH");
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

  it.skipIf(!junctionFixtureSupported)("rejects a CONTROL state root whose .codex parent is redirected", () => {
    const { input, approvedIdentities, root } = fixture();
    const redirected = path.join(root, "redirected-codex");
    const target = path.join(root, "outside-codex");
    fs.mkdirSync(target);
    fs.symlinkSync(target, redirected, "junction");
    const escapedState = path.join(redirected, "c2c-repair-control-state");
    const identities = { ...approvedIdentities, controlStateDir: escapedState };
    expect(validateControlBootstrapIsolation({ ...input, controlStateDir: escapedState }, identities))
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

  it.each(["EPERM", "EACCES"] as const)("offers exactly one capable handoff for a state write %s", async (failureCode) => {
    const { input } = fixture();
    const deps = adapter(input, {
      writeProbe: { ok: false, created: false, readBack: false, deleted: false, failureCode },
    });
    const [first, duplicate] = await Promise.all([
      runControlBootstrap(input, deps),
      runControlBootstrap(input, deps),
    ]);

    expect([first, duplicate].filter((result) => result.nextAction === "RETRY_CAPABLE_CONTEXT")).toHaveLength(1);
    expect([first, duplicate].find((result) => result.nextAction === "RETRY_CAPABLE_CONTEXT")).toMatchObject({
      state: "CONTROL_CAPABLE_CONTEXT_REQUIRED",
      capableContextAttempted: false,
      reason: "CONTROL_STATE_WRITE_PERMISSION_DENIED",
    });
    expect([first, duplicate].find((result) => result.nextAction === "CONTROL_BOOTSTRAP_BLOCKED")?.reason)
      .toBe("CAPABLE_CONTEXT_HANDOFF_ALREADY_OFFERED");
    expect(deps.localProbe).not.toHaveBeenCalled();
    expect(deps.findBridge).not.toHaveBeenCalled();
    expect(deps.startBridge).not.toHaveBeenCalled();
  });

  it("continues bootstrap when the capable-context retry passes the same state write probe", async () => {
    const { input } = fixture();
    const deps = adapter(input);
    deps.stateDirectoryWriteProbe = vi.fn()
      .mockReturnValueOnce({ ok: false, created: false, readBack: false, deleted: false, failureCode: "EPERM" })
      .mockImplementation(() => probeControlStateDirectoryWrite(input.controlStateDir));

    const ordinary = await runControlBootstrap(input, deps);
    const capableRetry = await runControlBootstrap({ ...input, capableContextRetry: true }, deps);

    expect(ordinary.nextAction).toBe("RETRY_CAPABLE_CONTEXT");
    expect(capableRetry).toMatchObject({
      ok: true,
      state: "CONTROL_BRIDGE_READY",
      nextAction: "CONTROL_LOCAL_HEALTH_GATE",
      capableContextAttempted: true,
      stateDirectoryWriteProbe: { ok: true, created: true, readBack: true, deleted: true },
    });
    expect(deps.stateDirectoryWriteProbe).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(input.controlStateDir)).toBe(true);
    expect(deps.startBridge).not.toHaveBeenCalled();

    const secondRetry = await runControlBootstrap({ ...input, capableContextRetry: true }, deps);
    expect(secondRetry).toMatchObject({ state: "CONTROL_BOOTSTRAP_BLOCKED", reason: "CAPABLE_CONTEXT_RETRY_NOT_AUTHORIZED" });
    expect(deps.stateDirectoryWriteProbe).toHaveBeenCalledTimes(3);
  });

  it("fails closed when capable-context state write retry still returns EPERM or EACCES", async () => {
    for (const failureCode of ["EPERM", "EACCES"] as const) {
      const { input } = fixture();
      const deps = adapter(input, {
        writeProbe: { ok: false, created: false, readBack: false, deleted: false, failureCode },
      });

      const ordinary = await runControlBootstrap(input, deps);
      const capableRetry = await runControlBootstrap({ ...input, capableContextRetry: true }, deps);

      expect(ordinary.nextAction).toBe("RETRY_CAPABLE_CONTEXT");
      expect(capableRetry).toMatchObject({
        state: "CONTROL_BOOTSTRAP_BLOCKED",
        nextAction: "CONTROL_BOOTSTRAP_BLOCKED",
        capableContextAttempted: true,
        reason: "CAPABLE_CONTEXT_STATE_WRITE_FAILED",
      });
      expect(deps.localProbe).not.toHaveBeenCalled();
      expect(deps.findBridge).not.toHaveBeenCalled();
      expect(deps.startBridge).not.toHaveBeenCalled();
    }
  });

  it("keeps non-permission state write errors blocked", async () => {
    const { input } = fixture();
    const deps = adapter(input, {
      writeProbe: { ok: false, created: false, readBack: false, deleted: false, failureCode: "ENOSPC" },
    });
    const result = await runControlBootstrap(input, deps);
    expect(result).toMatchObject({ state: "CONTROL_BOOTSTRAP_BLOCKED", reason: "CONTROL_STATE_NOT_WRITABLE" });
    expect(result.nextAction).toBe("CONTROL_BOOTSTRAP_BLOCKED");
    expect(deps.localProbe).not.toHaveBeenCalled();
    expect(deps.findBridge).not.toHaveBeenCalled();
    expect(deps.startBridge).not.toHaveBeenCalled();
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

  it("revalidates all canonical identities after legacy reconciliation and before start", async () => {
    const { input, approvedIdentities } = fixture();
    const deps = adapter(input, { observation: stoppedObservation(), approvedIdentities });
    deps.reconcileLegacyRuntime = vi.fn(async () => {
      fs.rmSync(input.controlWorkspaceRoot, { recursive: true, force: true });
      return { disposition: "NONE" as const };
    });
    const result = await runControlBootstrap(input, deps);
    expect(result).toMatchObject({ state: "CONTROL_BOOTSTRAP_BLOCKED", reason: "CONTROL_IDENTITY_MISMATCH" });
    expect(deps.startBridge).not.toHaveBeenCalled();
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

  it.each([
    [{ disposition: "CONFLICT" as const, reason: "CONTROL_RUNTIME_IDENTITY_CONFLICT" as const }, "CONTROL_RUNTIME_IDENTITY_CONFLICT"],
    [{ disposition: "CONFLICT" as const, reason: "LEGACY_RUNTIME_CREATION_PROVENANCE_MISSING" as const }, "LEGACY_RUNTIME_CREATION_PROVENANCE_MISSING"],
    [{ disposition: "BLOCKED" as const, reason: "LEGACY_CONTROL_RUNTIME_RETIREMENT_INCOMPLETE" as const }, "LEGACY_CONTROL_RUNTIME_RETIREMENT_INCOMPLETE"],
  ])("does not start a duplicate Bridge when legacy reconciliation blocks", async (legacyRuntime, reason) => {
    const { input } = fixture();
    const deps = adapter(input, { observation: stoppedObservation(), legacyRuntime });
    const result = await runControlBootstrap(input, deps);
    expect(result).toMatchObject({ state: "CONTROL_BOOTSTRAP_BLOCKED", reason });
    expect(deps.reconcileLegacyRuntime).toHaveBeenCalledOnce();
    expect(deps.startBridge).not.toHaveBeenCalled();
  });

  it("carries listener ETIMEDOUT through reconciliation and bootstrap with zero stop/start side effects", async () => {
    const { input } = fixture();
    const legacyStateDirectory = path.join(input.controlStateDir, "isolated-legacy-fixture");
    const runtimeDirectory = path.join(legacyStateDirectory, "runtime");
    fs.mkdirSync(runtimeDirectory, { recursive: true });
    const legacyRuntime: RuntimeState = {
      service: "c2c-bridge",
      version: "fixture",
      workspaceId: input.workspaceId,
      workspaceRoot: input.controlWorkspaceRoot,
      pid: 43_210,
      port: 48_765,
      adminToken: "fixture-admin-token-never-log",
      publicUrl: null,
      startedAt: "2025-01-01T00:00:03.000Z",
      processCreatedAt: "2025-01-01T00:00:00.000Z",
    };
    fs.writeFileSync(path.join(runtimeDirectory, `${input.workspaceId}.json`), JSON.stringify(legacyRuntime), { flag: "wx" });
    const timeoutEvidence = parseLegacyProcessProbeResult({
      status: null,
      stdout: "",
      error: { code: "ETIMEDOUT", message: "listener query timed out" },
    });
    let stopCount = 0;
    let startBridgeCount = 0;
    const deps = adapter(input, { observation: stoppedObservation() });
    deps.startBridge = vi.fn(async (workspaceRoot) => {
      startBridgeCount += 1;
      return { runtime: runtime(input.workspaceId, workspaceRoot), spawned: true };
    });
    deps.reconcileLegacyRuntime = vi.fn(async () => {
      const inspected = await inspectLegacyControlRuntime(input.workspaceId, input.controlWorkspaceRoot, {
        legacyStateDirectory,
        processEvidence: () => timeoutEvidence,
        requestShutdown: async () => { stopCount += 1; return true; },
      });
      if (inspected.disposition === "CONFLICT") {
        return { disposition: "CONFLICT" as const, reason: "CONTROL_RUNTIME_IDENTITY_CONFLICT" as const };
      }
      if (inspected.disposition === "EXACT") {
        const retired = await retireExactLegacyControlRuntime(input.controlStateDir, inspected.runtime, {
          requestShutdown: async () => { stopCount += 1; return true; },
        });
        return retired === "RETIRED"
          ? { disposition: "RETIRED" as const }
          : { disposition: "BLOCKED" as const, reason: "LEGACY_CONTROL_RUNTIME_RETIREMENT_INCOMPLETE" as const };
      }
      return inspected.disposition === "NONE" ? { disposition: "NONE" as const } : { disposition: "STALE" as const };
    });

    const result = await runControlBootstrap(input, deps);

    expect(timeoutEvidence.listenerQuery).toMatchObject({ status: "error", reason: expect.stringContaining("ETIMEDOUT") });
    expect(deps.reconcileLegacyRuntime).toHaveBeenCalledOnce();
    expect(result.reason).toBe("CONTROL_RUNTIME_IDENTITY_CONFLICT");
    expect(stopCount).toBe(0);
    expect(startBridgeCount).toBe(0);
    expect(deps.startBridge).not.toHaveBeenCalled();
  });

  it("records stale legacy state before starting the canonical Bridge", async () => {
    const { input } = fixture();
    const deps = adapter(input, { observation: stoppedObservation(), legacyRuntime: { disposition: "STALE" } });
    const result = await runControlBootstrap(input, deps);
    expect(result).toMatchObject({ ok: true, legacyRuntimeDisposition: "STALE" });
    expect(deps.startBridge).toHaveBeenCalledOnce();
    expect(readControlBootstrapProgress(input.controlStateDir, input.workspaceId)).toMatchObject({ legacyRuntimeDisposition: "STALE" });
  });

  it("continues to canonical Bridge start only after graceful retirement succeeds", async () => {
    const { input } = fixture();
    const deps = adapter(input, { observation: stoppedObservation(), legacyRuntime: { disposition: "RETIRED" } });
    const result = await runControlBootstrap(input, deps);
    expect(result).toMatchObject({ ok: true, legacyRuntimeDisposition: "RETIRED" });
    expect(deps.reconcileLegacyRuntime).toHaveBeenCalledOnce();
    expect(deps.startBridge).toHaveBeenCalledOnce();
  });

  it("serializes concurrent same-run bootstrap through one real retirement marker before one start", async () => {
    const { input } = fixture();
    const legacy: RuntimeState = {
      service: "c2c-bridge", version: "fixture", workspaceId: input.workspaceId,
      workspaceRoot: input.controlWorkspaceRoot, pid: 43210, port: 48765,
      adminToken: "fixture-admin-token-never-log", publicUrl: null, startedAt: new Date(3_000).toISOString(),
      processCreatedAt: new Date(0).toISOString(),
    };
    let releaseStop!: () => void;
    let enteredStop!: () => void;
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    const stopEntered = new Promise<void>((resolve) => { enteredStop = resolve; });
    let stopCount = 0;
    let startCount = 0;
    const deps = adapter(input, { observation: stoppedObservation() });
    deps.startBridge = vi.fn(async (workspaceRoot) => {
      startCount += 1;
      return { runtime: runtime(input.workspaceId, workspaceRoot), spawned: true };
    });
    deps.reconcileLegacyRuntime = vi.fn(async () => {
      const retired = await retireExactLegacyControlRuntime(input.controlStateDir, legacy, {
        requestShutdown: async () => { stopCount += 1; enteredStop(); await stopGate; return true; },
        waitForRetirement: async () => true,
      });
      return retired === "RETIRED"
        ? { disposition: "RETIRED" as const }
        : { disposition: "BLOCKED" as const, reason: "LEGACY_CONTROL_RUNTIME_RETIREMENT_INCOMPLETE" as const };
    });
    const first = runControlBootstrap(input, deps);
    await stopEntered;
    const second = await runControlBootstrap(input, deps);
    releaseStop();
    const firstResult = await first;
    expect(firstResult).toMatchObject({ ok: true, legacyRuntimeDisposition: "RETIRED" });
    expect(second).toMatchObject({ ok: false, reason: "LEGACY_CONTROL_RUNTIME_RETIREMENT_INCOMPLETE" });
    expect(stopCount).toBe(1);
    expect(startCount).toBe(1);
  });
});

describe("fresh-state CONTROL CLI cloudflared resolver wiring", () => {
  it("realpaths a disposable state-root sibling under the actual user-home .codex without creating production state", () => {
    const codexRoot = canonicalCodexDirectory();
    const canonicalCodexRoot = fs.realpathSync.native(codexRoot);
    const productionState = canonicalControlStateDirectory();
    const productionStateExistedBefore = fs.existsSync(productionState);
    expect(canonicalCodexRoot.toLowerCase()).toBe(path.resolve(codexRoot).toLowerCase());

    const fixtureDirectory = fs.mkdtempSync(path.join(canonicalCodexRoot, "c2c-control-state-fixture-"));
    try {
      const child = path.join(fixtureDirectory, "fixture-child");
      fs.writeFileSync(child, "fixture", { flag: "wx" });
      const canonicalFixture = fs.realpathSync.native(fixtureDirectory);
      const canonicalChild = fs.realpathSync.native(child);
      expect(canonicalFixture.startsWith(`${canonicalCodexRoot}${path.sep}`)).toBe(true);
      expect(canonicalChild.startsWith(`${canonicalCodexRoot}${path.sep}`)).toBe(true);
      expect(canonicalChild.toLowerCase()).not.toContain("\\appdata\\local\\packages\\");
    } finally {
      fs.rmSync(fixtureDirectory, { recursive: true, force: true });
    }
    expect(fs.existsSync(productionState)).toBe(productionStateExistedBefore);
  });

  it("derives the sole managed root from the canonical user home", () => {
    const { homeDirectory, managedDirectory } = fixture();
    expect(managedCloudflaredDirectory(homeDirectory)).toBe(managedDirectory);
    expect(managedCloudflaredDirectory()).toBe(path.join(fs.realpathSync.native(os.homedir()), ".codex", "cloudflared"));
  });

  it("writes and realpaths a disposable sibling under the actual canonical user-home .codex directory", () => {
    const canonicalHome = fs.realpathSync.native(os.homedir());
    const codexRoot = path.join(canonicalHome, ".codex");
    const canonicalCodexRoot = fs.realpathSync.native(codexRoot);
    const productionManagedRoot = path.join(canonicalCodexRoot, "cloudflared");
    const productionRootExistedBefore = fs.existsSync(productionManagedRoot);
    expect(canonicalCodexRoot.toLowerCase()).toBe(path.resolve(codexRoot).toLowerCase());

    const fixtureDirectory = fs.mkdtempSync(path.join(canonicalCodexRoot, "c2c-stable-root-fixture-"));
    try {
      const child = path.join(fixtureDirectory, "fixture-child");
      fs.writeFileSync(child, "fixture", { flag: "wx" });
      const canonicalFixture = fs.realpathSync.native(fixtureDirectory);
      const canonicalChild = fs.realpathSync.native(child);
      expect(canonicalFixture.startsWith(`${canonicalCodexRoot}${path.sep}`)).toBe(true);
      expect(canonicalChild.startsWith(`${canonicalCodexRoot}${path.sep}`)).toBe(true);
      expect(canonicalChild.toLowerCase()).not.toContain("\\appdata\\local\\packages\\");
    } finally {
      fs.rmSync(fixtureDirectory, { recursive: true, force: true });
    }
    expect(fs.existsSync(productionManagedRoot)).toBe(productionRootExistedBefore);
  });

  it("discovers the trusted managed executable with no profile and reaches the single retry gate", async () => {
    const { input, managedDirectory } = fixture();
    fs.mkdirSync(managedDirectory, { recursive: true });
    const executable = writeFixture(managedDirectory, "cloudflared.exe", "fixture executable");
    const env = { ...process.env, C2C_CLOUDFLARED_PATH: "", PATH: managedDirectory };
    const probe = cloudflaredProbeAdapter(fs.realpathSync(executable));

    await withStateDirectory(input.controlStateDir, async () => {
      const profileFile = networkProfileFile(input.workspaceId);
      expect(fs.existsSync(profileFile)).toBe(false);
      expect(resolveControlBootstrapCloudflared(undefined, env, managedDirectory)).toMatchObject({
        status: "PASS",
        source: "managed",
        candidate: fs.realpathSync(executable),
      });
      const deps = cliWiredAdapter(input, probe.adapter, env, managedDirectory);
      const result = await runControlBootstrap(input, deps);
      expect(result).toMatchObject({
        state: "CONTROL_CAPABLE_CONTEXT_REQUIRED",
        nextAction: "RETRY_CAPABLE_CONTEXT",
        localProbe: {
          nodeChildSpawn: "PASS",
          cloudflaredSpawn: "PASS",
          relayFork: "EPERM",
          classification: "RESTRICTED_EXECUTION_CONTEXT",
        },
      });
      expect(probe.spawned).toContain(path.resolve(executable));
      expect(fs.existsSync(profileFile)).toBe(false);
      expect(deps.startBridge).not.toHaveBeenCalled();
    });
  });

  it.each(["PATH", "C2C_CLOUDFLARED_PATH"] as const)(
    "rejects an untrusted %s candidate without executing it or opening the retry gate",
    async (source) => {
      const { input, root, managedDirectory } = fixture();
      const untrustedDirectory = path.join(root, "untrusted-bin");
      fs.mkdirSync(untrustedDirectory, { recursive: true });
      const untrustedExecutable = writeFixture(untrustedDirectory, "cloudflared.exe", "untrusted fixture");
      const env = {
        ...process.env,
        C2C_CLOUDFLARED_PATH: source === "C2C_CLOUDFLARED_PATH" ? untrustedExecutable : "",
        PATH: source === "PATH" ? untrustedDirectory : "",
      };
      const probe = cloudflaredProbeAdapter();

      await withStateDirectory(input.controlStateDir, async () => {
        expect(fs.existsSync(networkProfileFile(input.workspaceId))).toBe(false);
        expect(resolveControlBootstrapCloudflared(undefined, env, managedDirectory)).toMatchObject({
          status: "NOT_CONFIGURED",
          source: "none",
        });
        const deps = cliWiredAdapter(input, probe.adapter, env, managedDirectory);
        const result = await runControlBootstrap(input, deps);
        expect(result).toMatchObject({
          state: "CONTROL_BOOTSTRAP_BLOCKED",
          nextAction: "CONTROL_BOOTSTRAP_BLOCKED",
          localProbe: {
            cloudflaredSpawn: "NOT_CONFIGURED",
            relayFork: "EPERM",
            classification: "CLOUDFLARED_UNAVAILABLE",
          },
        });
        expect(probe.spawned).toEqual([path.resolve(process.execPath)]);
        expect(probe.spawned).not.toContain(path.resolve(untrustedExecutable));
        expect(deps.startBridge).not.toHaveBeenCalled();
      });
    },
  );

  it("uses a trusted profile candidate through the same approved validator", async () => {
    const { input, managedDirectory } = fixture();
    fs.mkdirSync(managedDirectory, { recursive: true });
    const executable = writeFixture(managedDirectory, "cloudflared.exe", "fixture executable");
    const env = { ...process.env, C2C_CLOUDFLARED_PATH: "", PATH: "" };
    const probe = cloudflaredProbeAdapter(fs.realpathSync(executable), "PASS");

    await withStateDirectory(input.controlStateDir, async () => {
      const profileFile = networkProfileFile(input.workspaceId);
      fs.mkdirSync(path.dirname(profileFile), { recursive: true });
      fs.writeFileSync(profileFile, JSON.stringify({ cloudflaredPath: executable }));
      const result = await probeControlBootstrapLocalExecution(input.workspaceId, {
        environment: env,
        probeAdapter: probe.adapter,
        managedCloudflaredDirectory: managedDirectory,
      });
      expect(result).toMatchObject({ cloudflaredSpawn: "PASS", classification: "CAPABLE" });
      expect(probe.spawned).toContain(path.resolve(executable));
    });
  });

  it.skipIf(!junctionFixtureSupported)("rejects a managed-root junction escape before executing cloudflared", async () => {
    const { input, root, managedDirectory } = fixture();
    const parent = path.dirname(managedDirectory);
    fs.mkdirSync(parent, { recursive: true });
    const outsideDirectory = path.join(root, "outside-cloudflared");
    fs.mkdirSync(outsideDirectory, { recursive: true });
    const outsideExecutable = writeFixture(outsideDirectory, "cloudflared.exe", "outside fixture");

    const fileLinkManaged = path.join(root, "cloudflared-file-link");
    fs.mkdirSync(fileLinkManaged, { recursive: true });
    let fileSymlinkSupported = false;
    try {
      fs.symlinkSync(outsideExecutable, path.join(fileLinkManaged, "cloudflared.exe"), "file");
      fileSymlinkSupported = true;
    } catch {
      // Directory junction coverage below remains mandatory on Windows without file-symlink privilege.
    }
    if (fileSymlinkSupported) {
      expect(resolveApprovedCloudflaredPath(undefined, fileLinkManaged).status).toBe("UNAPPROVED_CLOUDFLARED_PATH");
    }

    fs.symlinkSync(outsideDirectory, managedDirectory, "junction");
    const env = { ...process.env, C2C_CLOUDFLARED_PATH: "", PATH: managedDirectory };
    const probe = cloudflaredProbeAdapter();

    await withStateDirectory(input.controlStateDir, async () => {
      expect(resolveApprovedCloudflaredPath(undefined, managedDirectory).status).toBe("UNAPPROVED_CLOUDFLARED_PATH");
      const deps = cliWiredAdapter(input, probe.adapter, env, managedDirectory);
      const result = await runControlBootstrap(input, deps);
      expect(result.localProbe).toMatchObject({
        cloudflaredSpawn: "UNAPPROVED_CLOUDFLARED_PATH",
        classification: "UNAPPROVED_CLOUDFLARED_PATH",
      });
      expect(probe.spawned).toEqual([path.resolve(process.execPath)]);
      expect(deps.startBridge).not.toHaveBeenCalled();
    });
  });

  it.skipIf(!junctionFixtureSupported)("rejects a .codex parent junction escape", () => {
    const { homeDirectory, managedDirectory, root } = fixture();
    const outside = path.join(root, "external-codex-directory");
    fs.mkdirSync(path.join(outside, "cloudflared"), { recursive: true });
    writeFixture(path.join(outside, "cloudflared"), "cloudflared.exe", "untrusted fixture");
    fs.symlinkSync(outside, path.join(homeDirectory, ".codex"), "junction");
    expect(resolveApprovedCloudflaredPath(undefined, managedDirectory).status).toBe("UNAPPROVED_CLOUDFLARED_PATH");
  });
});

describe("CONTROL start and doctor cloudflared prechecks", () => {
  it.each(["start --tunnel", "doctor --fix"])("does not execute a PATH-only candidate during %s precheck", (consumer) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-precheck-untrusted-path-"));
    roots.push(directory);
    const candidateName = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
    const candidate = path.join(directory, candidateName);
    const marker = path.join(directory, "candidate-executed.txt");
    const preload = path.join(directory, "count-execution.cjs");
    fs.copyFileSync(process.execPath, candidate);
    if (process.platform !== "win32") fs.chmodSync(candidate, 0o755);
    fs.writeFileSync(preload, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'executed\\n')`);

    const previousPath = process.env.PATH;
    const previousCloudflared = process.env.C2C_CLOUDFLARED_PATH;
    const previousNodeOptions = process.env.NODE_OPTIONS;
    process.env.PATH = directory;
    process.env.C2C_CLOUDFLARED_PATH = "";
    process.env.NODE_OPTIONS = `--require=${preload}`;
    try {
      const genericDiscovery = vi.fn(() => findBinary("cloudflared"));
      const result = resolveTunnelPrecheckCloudflared({
        workspaceRoot: APPROVED_CONTROL_BOOTSTRAP_IDENTITIES.controlWorkspaceRoot,
        profileCandidate: undefined,
        managedCloudflaredDirectory: path.join(directory, "approved", "cloudflared"),
        environment: process.env,
        discoverGeneric: genericDiscovery,
      });
      expect(result).toBeNull();
      expect(genericDiscovery).not.toHaveBeenCalled();
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousCloudflared === undefined) delete process.env.C2C_CLOUDFLARED_PATH;
      else process.env.C2C_CLOUDFLARED_PATH = previousCloudflared;
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousNodeOptions;
    }
  });

  it("uses the exact approved managed-root executable without invoking generic discovery", () => {
    const { managedDirectory } = fixture();
    fs.mkdirSync(managedDirectory, { recursive: true });
    const approved = path.join(managedDirectory, "cloudflared.exe");
    fs.writeFileSync(approved, "managed fixture");
    const genericDiscovery = vi.fn(() => null);

    const result = resolveTunnelPrecheckCloudflared({
      workspaceRoot: APPROVED_CONTROL_BOOTSTRAP_IDENTITIES.controlWorkspaceRoot,
      profileCandidate: undefined,
      managedCloudflaredDirectory: managedDirectory,
      environment: { ...process.env, C2C_CLOUDFLARED_PATH: "", PATH: "" },
      discoverGeneric: genericDiscovery,
    });

    expect(result).toBe(fs.realpathSync(approved));
    expect(genericDiscovery).not.toHaveBeenCalled();
  });

  it("rejects an untrusted environment candidate without falling back to generic discovery", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-precheck-untrusted-env-"));
    roots.push(directory);
    const candidate = path.join(directory, "cloudflared.exe");
    fs.writeFileSync(candidate, "untrusted fixture");
    const genericDiscovery = vi.fn(() => candidate);

    const result = resolveTunnelPrecheckCloudflared({
      workspaceRoot: APPROVED_CONTROL_BOOTSTRAP_IDENTITIES.controlWorkspaceRoot,
      profileCandidate: undefined,
      managedCloudflaredDirectory: path.join(directory, "approved", "cloudflared"),
      environment: { ...process.env, C2C_CLOUDFLARED_PATH: candidate, PATH: "" },
      discoverGeneric: genericDiscovery,
    });

    expect(result).toBeNull();
    expect(genericDiscovery).not.toHaveBeenCalled();
  });

  it("preserves generic discovery for non-CONTROL workspaces", () => {
    const { input } = fixture();
    const genericDiscovery = vi.fn(() => "C:\\tools\\cloudflared.exe");
    expect(resolveTunnelPrecheckCloudflared({
      workspaceRoot: input.targetWorkspaceRoot,
      profileCandidate: undefined,
      discoverGeneric: genericDiscovery,
    })).toBe("C:\\tools\\cloudflared.exe");
    expect(genericDiscovery).toHaveBeenCalledOnce();
  });
});
