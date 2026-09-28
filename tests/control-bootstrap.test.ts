import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  runControlBootstrap,
  validateControlBootstrapIsolation,
  type ControlBootstrapAdapter,
  type ControlBootstrapIdentities,
  type ControlBootstrapInput,
  type StateDirectoryWriteProbe,
} from "../src/control-bootstrap.js";
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

function cliWiredAdapter(
  input: ControlBootstrapInput,
  probeAdapter: ProbeAdapter,
  environment: NodeJS.ProcessEnv,
): ControlBootstrapAdapter {
  const { localProbe: _unusedMock, ...dependencies } = adapter(input);
  return createControlBootstrapCliAdapter(input.workspaceId, dependencies, { probeAdapter, environment });
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

describe("fresh-state CONTROL CLI cloudflared resolver wiring", () => {
  it("discovers the trusted managed executable with no profile and reaches the single retry gate", async () => {
    const { input } = fixture();
    const managedDirectory = path.join(path.dirname(input.controlStateDir), "cloudflared");
    fs.mkdirSync(managedDirectory, { recursive: true });
    const executable = writeFixture(managedDirectory, "cloudflared.exe", "fixture executable");
    const env = { ...process.env, C2C_CLOUDFLARED_PATH: "", PATH: managedDirectory };
    const probe = cloudflaredProbeAdapter(fs.realpathSync(executable));

    await withStateDirectory(input.controlStateDir, async () => {
      const profileFile = networkProfileFile(input.workspaceId);
      expect(fs.existsSync(profileFile)).toBe(false);
      expect(resolveControlBootstrapCloudflared(undefined, env)).toMatchObject({
        status: "PASS",
        source: "managed",
        candidate: fs.realpathSync(executable),
      });
      const deps = cliWiredAdapter(input, probe.adapter, env);
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
      const { input } = fixture();
      const untrustedDirectory = path.join(path.dirname(input.controlStateDir), "untrusted-bin");
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
        expect(resolveControlBootstrapCloudflared(undefined, env)).toMatchObject({
          status: "NOT_CONFIGURED",
          source: "none",
        });
        const deps = cliWiredAdapter(input, probe.adapter, env);
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
    const { input } = fixture();
    const managedDirectory = path.join(path.dirname(input.controlStateDir), "cloudflared");
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
      });
      expect(result).toMatchObject({ cloudflaredSpawn: "PASS", classification: "CAPABLE" });
      expect(probe.spawned).toContain(path.resolve(executable));
    });
  });

  it.skipIf(!junctionFixtureSupported)("rejects a managed-root junction escape before executing cloudflared", async () => {
    const { input } = fixture();
    const parent = path.dirname(input.controlStateDir);
    const managedDirectory = path.join(parent, "cloudflared");
    const outsideDirectory = path.join(parent, "outside-cloudflared");
    fs.mkdirSync(outsideDirectory, { recursive: true });
    const outsideExecutable = writeFixture(outsideDirectory, "cloudflared.exe", "outside fixture");

    const fileLinkManaged = path.join(parent, "cloudflared-file-link");
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
      const deps = cliWiredAdapter(input, probe.adapter, env);
      const result = await runControlBootstrap(input, deps);
      expect(result.localProbe).toMatchObject({
        cloudflaredSpawn: "UNAPPROVED_CLOUDFLARED_PATH",
        classification: "UNAPPROVED_CLOUDFLARED_PATH",
      });
      expect(probe.spawned).toEqual([path.resolve(process.execPath)]);
      expect(deps.startBridge).not.toHaveBeenCalled();
    });
  });
});
