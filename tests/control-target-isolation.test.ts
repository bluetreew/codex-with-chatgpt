import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStore } from "../src/auth/store.js";
import { planRecovery } from "../src/recovery/harness.js";
import * as runtimeModule from "../src/bridge/runtime.js";
import { findBridgeObservation, readRuntimeState, runtimeFile, writeRuntimeState, SERVICE_NAME, VERSION } from "../src/bridge/runtime.js";
import { stopBridge } from "../src/process/daemon.js";
import { resolveControlTargetProfile } from "../src/config/control-target-registry.js";
import { connectorAction, readLastEndpoint, writeLastEndpoint } from "../src/config/endpoint.js";
import { readNetworkProfile, writeNetworkProfile } from "../src/config/network-profile.js";
import { readSession, writeSession } from "../src/session/state.js";
import { readTunnelState, writeTunnelState } from "../src/tunnel/state.js";
import { matchRecoveryTargetBinding, recoveryTargetBindingFromProfile } from "../src/recovery/target-binding.js";
import { readRecoveryProgress, writeRecoveryProgress } from "../src/recovery/state.js";
import { Workspace } from "../src/workspace/manager.js";
import { MOZI_CONTROL_TARGET_PROFILE, type ControlTargetProfile } from "../src/control-target-profile.js";
import { fileURLToPath } from "node:url";

const roots: string[] = [];
const servers: http.Server[] = [];
const originalStateDir = process.env.C2C_STATE_DIR;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const recoverySkill = path.join(repoRoot, "skill", "c2c-emergency-recovery");

afterEach(async () => {
  if (originalStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = originalStateDir;
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-two-targets-"));
  roots.push(root);
  const targetA = path.join(root, "workspace-a");
  const targetB = path.join(root, "workspace-b");
  const stateA = path.join(root, "state-a");
  const stateB = path.join(root, "state-b");
  const controlState = path.join(root, "control-state");
  for (const directory of [targetA, targetB, stateA, stateB, controlState]) fs.mkdirSync(directory, { recursive: true });
  const workspaceA = new Workspace(targetA);
  const workspaceB = new Workspace(targetB);
  const profiles: ControlTargetProfile[] = [
    { schemaVersion: 1, profileId: "project-a", targetWorkspaceRoot: fs.realpathSync.native(targetA), targetStateDir: fs.realpathSync.native(stateA), expectedWorkspaceId: workspaceA.id },
    { schemaVersion: 1, profileId: "project-b", targetWorkspaceRoot: fs.realpathSync.native(targetB), targetStateDir: fs.realpathSync.native(stateB), expectedWorkspaceId: workspaceB.id },
  ];
  const registryFile = path.join(root, "targets.json");
  fs.writeFileSync(registryFile, JSON.stringify({ schemaVersion: 1, profiles }));
  const options = { registryFile, controlWorkspaceRoot: repoRoot, controlStateDir: controlState };
  const resolvedA = resolveControlTargetProfile("project-a", options);
  const resolvedB = resolveControlTargetProfile("project-b", options);
  return { root, targetA, targetB, stateA, stateB, profiles, registryFile, options, resolvedA, resolvedB, workspaceA, workspaceB };
}

function withStateDir<T>(stateDir: string, action: () => T): T {
  const previous = process.env.C2C_STATE_DIR;
  process.env.C2C_STATE_DIR = stateDir;
  try { return action(); }
  finally {
    if (previous === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previous;
  }
}

function runtimeFor(profile: ReturnType<typeof resolveControlTargetProfile>, port: number) {
  return {
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId: profile.workspaceId,
    workspaceRoot: profile.targetWorkspaceRoot,
    pid: process.pid,
    port,
    adminToken: `token-${profile.profileId}`,
    publicUrl: null,
    startedAt: new Date().toISOString(),
  };
}

describe("two disposable recovery targets stay isolated", () => {
  it("keeps the unbound-progress migration exception exclusive to the built-in MOZI profile", () => {
    const value = fixture();
    expect(matchRecoveryTargetBinding(undefined, recoveryTargetBindingFromProfile(value.resolvedA))).toBe("MISMATCH");
    expect(matchRecoveryTargetBinding(undefined, {
      profileId: MOZI_CONTROL_TARGET_PROFILE.profileId,
      workspaceId: MOZI_CONTROL_TARGET_PROFILE.expectedWorkspaceId,
      workspaceRoot: MOZI_CONTROL_TARGET_PROFILE.targetWorkspaceRoot,
      stateDir: MOZI_CONTROL_TARGET_PROFILE.targetStateDir,
    })).toBe("LEGACY_MOZI_UNBOUND");
  });

  it("keeps session, endpoint, connector auth, tunnel, network, recovery, and runtime state in each profile root", () => {
    const value = fixture();
    const profileA = value.resolvedA;
    const profileB = value.resolvedB;
    const bindingA = recoveryTargetBindingFromProfile(profileA);
    const bindingB = recoveryTargetBindingFromProfile(profileB);

    withStateDir(profileA.targetStateDir, () => {
      writeSession(profileA.workspaceId, { url: "https://chatgpt.com/c/a", savedAt: "2026-09-30T00:00:00.000Z", connectorName: "Connector A" });
      writeLastEndpoint({ workspaceId: profileA.workspaceId, port: 41001, publicUrl: "https://a.trycloudflare.com", mcpUrl: "https://a.trycloudflare.com/mcp", connectorName: "Connector A" });
      new AuthStore(profileA.workspaceId).registerClient({ clientName: "Client A", redirectUris: ["https://chatgpt.com/callback/a"] });
      writeTunnelState({ workspaceId: profileA.workspaceId, preference: "quick", askedAt: "2026-09-30T00:00:00.000Z", provider: "cloudflare-quick" });
      writeNetworkProfile(profileA.workspaceId, { proxyUrl: "http://127.0.0.1:8317", tunnelProtocol: "http2", quickServiceRelay: true, noProxy: "localhost", cloudflaredPath: process.execPath });
      writeRecoveryProgress(profileA.workspaceId, { state: "LOCAL_DIAGNOSIS", capableContextAttempted: false, bridgeRestartAttempted: false, targetBinding: bindingA });
      writeRuntimeState(runtimeFor(profileA, 41001));
    });
    withStateDir(profileB.targetStateDir, () => {
      writeSession(profileB.workspaceId, { url: "https://chatgpt.com/c/b", savedAt: "2026-09-30T00:00:00.000Z", connectorName: "Connector B" });
      writeLastEndpoint({ workspaceId: profileB.workspaceId, port: 41002, publicUrl: "https://b.trycloudflare.com", mcpUrl: "https://b.trycloudflare.com/mcp", connectorName: "Connector B" });
      new AuthStore(profileB.workspaceId).registerClient({ clientName: "Client B", redirectUris: ["https://chatgpt.com/callback/b"] });
      writeTunnelState({ workspaceId: profileB.workspaceId, preference: "named", askedAt: "2026-09-30T00:00:00.000Z", provider: "cloudflare-named", tunnelName: "workspace-b", hostname: "b.example.test" });
      writeNetworkProfile(profileB.workspaceId, { proxyUrl: "http://127.0.0.1:8318", tunnelProtocol: "quic", quickServiceRelay: false, noProxy: "localhost,127.0.0.1", cloudflaredPath: process.execPath });
      writeRecoveryProgress(profileB.workspaceId, { state: "ENDPOINT_COMPARE", capableContextAttempted: true, bridgeRestartAttempted: false, targetBinding: bindingB });
      writeRuntimeState(runtimeFor(profileB, 41002));
    });

    const clientA = withStateDir(profileA.targetStateDir, () => new AuthStore(profileA.workspaceId).registerClient({ clientName: "Updated A", redirectUris: ["https://chatgpt.com/callback/a2"] }));
    withStateDir(profileA.targetStateDir, () => {
      writeSession(profileA.workspaceId, { url: "https://chatgpt.com/c/a-updated", savedAt: "2026-09-30T00:01:00.000Z", connectorName: "Connector A" });
      writeLastEndpoint({ workspaceId: profileA.workspaceId, port: 42001, publicUrl: "https://a2.trycloudflare.com", mcpUrl: "https://a2.trycloudflare.com/mcp", connectorName: "Connector A" });
      writeTunnelState({ workspaceId: profileA.workspaceId, preference: "quick", askedAt: "2026-09-30T00:00:00.000Z", provider: "cloudflare-quick", fallbackReason: "A only" });
      writeNetworkProfile(profileA.workspaceId, { proxyUrl: "http://127.0.0.1:8319", tunnelProtocol: "auto", quickServiceRelay: true, noProxy: "localhost", cloudflaredPath: process.execPath });
      writeRecoveryProgress(profileA.workspaceId, { state: "LOCAL_HEALTH_PASS", capableContextAttempted: false, bridgeRestartAttempted: false, targetBinding: bindingA });
    });

    const endpointA = withStateDir(profileA.targetStateDir, () => readLastEndpoint(profileA.workspaceId)!);
    const endpointB = withStateDir(profileB.targetStateDir, () => readLastEndpoint(profileB.workspaceId)!);
    expect(connectorAction("https://a.trycloudflare.com/mcp", endpointA.mcpUrl)).toBe("update");
    expect(connectorAction(endpointB.mcpUrl, endpointB.mcpUrl)).toBe("none");
    expect(withStateDir(profileB.targetStateDir, () => readSession(profileB.workspaceId)?.url)).toBe("https://chatgpt.com/c/b");
    expect(withStateDir(profileB.targetStateDir, () => new AuthStore(profileB.workspaceId).getClient(clientA.clientId))).toBeUndefined();
    expect(withStateDir(profileB.targetStateDir, () => readTunnelState(profileB.workspaceId))).toMatchObject({ preference: "named", tunnelName: "workspace-b" });
    expect(withStateDir(profileB.targetStateDir, () => readNetworkProfile(profileB.workspaceId))).toMatchObject({ proxyUrl: "http://127.0.0.1:8318", tunnelProtocol: "quic" });
    expect(withStateDir(profileB.targetStateDir, () => readRecoveryProgress(profileB.workspaceId))).toMatchObject({ state: "ENDPOINT_COMPARE", targetBinding: bindingB });
    expect(withStateDir(profileB.targetStateDir, () => readRuntimeState(profileB.workspaceId))).toMatchObject({ workspaceId: profileB.workspaceId, port: 41002 });
    expect(withStateDir(profileA.targetStateDir, () => readRecoveryProgress(profileA.workspaceId)?.targetBinding)).toEqual(bindingA);
  });

  it("classifies A's runtime pointing at B's port as unknown and preserves B", async () => {
    const value = fixture();
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ service: SERVICE_NAME, version: VERSION, workspaceId: value.resolvedB.workspaceId, status: "ok" }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
    const port = address.port;
    withStateDir(value.resolvedA.targetStateDir, () => writeRuntimeState(runtimeFor(value.resolvedA, port)));
    withStateDir(value.resolvedB.targetStateDir, () => writeRuntimeState(runtimeFor(value.resolvedB, port)));
    const bRuntimePath = withStateDir(value.resolvedB.targetStateDir, () => runtimeFile(value.resolvedB.workspaceId));
    const bRuntimeBefore = fs.readFileSync(bRuntimePath, "utf8");
    const kill = vi.spyOn(process, "kill");

    const aObservation = await withStateDir(value.resolvedA.targetStateDir, () => findBridgeObservation(value.resolvedA.workspaceId));
    expect(aObservation).toMatchObject({ state: "unknown", reason: "workspace_mismatch", runtime: { workspaceId: value.resolvedA.workspaceId, port } });
    const stopped = await withStateDir(value.resolvedA.targetStateDir, () => stopBridge(value.resolvedA.targetWorkspaceRoot));
    expect(stopped).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(server.listening).toBe(true);
    const blockedPlan = planRecovery({
      workspace: { workspaceId: value.resolvedA.workspaceId, name: "Project A" },
      session: { url: "https://chatgpt.com/c/project-a", connectorName: "Connector A" },
      bridgeStatus: aObservation.state,
      localProbe: { nodeChildSpawn: "PASS", cloudflaredSpawn: "PASS", relayFork: "PASS", classification: "CAPABLE" },
      doctor: {
        report: Object.fromEntries(["node", "sandbox", "workspace", "bridge", "mcp", "oauth", "tunnel"].map((key) => [key, { ok: key !== "bridge" }])),
        chatgptRepair: { needed: false, mcpUrl: "https://a.trycloudflare.com/mcp", previousMcpUrl: "https://a.trycloudflare.com/mcp" },
        namedRepair: { needed: false },
      },
    });
    expect(blockedPlan).toMatchObject({ state: "BLOCKED_BRIDGE_UNKNOWN", nextAction: "BLOCKED_BRIDGE_UNKNOWN" });

    const bObservation = await withStateDir(value.resolvedB.targetStateDir, () => findBridgeObservation(value.resolvedB.workspaceId));
    expect(bObservation).toMatchObject({ state: "healthy", runtime: { workspaceId: value.resolvedB.workspaceId, port } });
    expect(fs.readFileSync(bRuntimePath, "utf8")).toBe(bRuntimeBefore);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("refuses stale-PID fallback when OS process creation time differs from the runtime record", async () => {
    const value = fixture();
    const probeServer = http.createServer();
    await new Promise<void>((resolve) => probeServer.listen(0, "127.0.0.1", resolve));
    const address = probeServer.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
    const port = address.port;
    await new Promise<void>((resolve, reject) => probeServer.close((error) => error ? reject(error) : resolve()));
    withStateDir(value.resolvedA.targetStateDir, () => writeRuntimeState({
      ...runtimeFor(value.resolvedA, port),
      processCreatedAt: "2019-01-01T00:00:00.000Z",
    }));
    vi.spyOn(runtimeModule, "queryProcessCreatedAt").mockReturnValue("2026-09-30T00:00:00.000Z");
    const kill = vi.spyOn(process, "kill");

    const stopped = await withStateDir(value.resolvedA.targetStateDir, () => stopBridge(value.resolvedA.targetWorkspaceRoot));

    expect(stopped).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("passes each TargetProfile's workspace and state root through the PowerShell recovery wrapper", () => {
    if (process.platform !== "win32") return;
    const value = fixture();
    const profilesFile = path.join(value.root, "wrapper-profiles.json");
    const callsFile = path.join(value.root, "wrapper-calls.jsonl");
    fs.writeFileSync(profilesFile, JSON.stringify({ profiles: [value.resolvedA, value.resolvedB] }));
    const fakeCli = path.join(value.root, "profile-aware-c2c.mjs");
    fs.writeFileSync(fakeCli, `
import fs from 'node:fs';
import path from 'node:path';
const args=process.argv.slice(2);
const config=JSON.parse(fs.readFileSync(process.env.C2C_TEST_PROFILES,'utf8'));
const profiles=config.profiles;
const record={args,stateDir:process.env.C2C_STATE_DIR};
fs.appendFileSync(process.env.C2C_TEST_CALLS,JSON.stringify(record)+'\\n');
const emit=(value)=>process.stdout.write(JSON.stringify(value));
const profileId=args[args.indexOf('--profile')+1];
const workspaceIndex=args.indexOf('--workspace');
const workspaceArg=workspaceIndex<0?null:path.resolve(args[workspaceIndex+1]);
const profileById=profiles.find((item)=>item.profileId===profileId);
const command=args[0];
if(command==='control-target'&&args[1]==='resolve')emit({ok:true,profile:profileById});
else if(command==='session')emit({session:{savedAt:'2026-09-30T00:00:00.000Z',connectorName:'fixture'}});
else if(command==='workspace') { const p=profiles.find((item)=>path.resolve(item.targetWorkspaceRoot)===workspaceArg); emit({workspaceId:p.expectedWorkspaceId,name:p.profileId}); }
else if(command==='status')emit({ok:true,running:false});
else if(command==='doctor')emit({report:Object.fromEntries(['node','sandbox','workspace','bridge','mcp','oauth','tunnel'].map((key)=>[key,{ok:true}])),chatgptRepair:{needed:false,connectorName:'fixture',mcpUrl:'https://fixture.invalid/mcp',previousMcpUrl:'https://fixture.invalid/mcp'},namedRepair:{needed:false}});
else if(command==='recovery-probe')emit({bridgeStatus:'stopped',localProbe:{nodeChildSpawn:'PASS',cloudflaredSpawn:'PASS',relayFork:'PASS',classification:'CAPABLE'},bridgeProbe:null,bridgeProbeError:false});
else if(command==='recovery-plan') { const p=profiles.find((item)=>item.profileId===args[args.indexOf('--target-profile')+1]); emit({ok:true,state:'LOCAL_HEALTH_PASS',nextAction:'COMPARE_ENDPOINT',humanActionRequired:false,facts:{targetBinding:{profileId:p.profileId,workspaceId:p.expectedWorkspaceId,workspaceRoot:p.targetWorkspaceRoot,stateDir:p.targetStateDir}}}); }
else { process.stderr.write('unexpected fixture command: '+args.join(' ')); process.exit(2); }
`);
    const statusScript = path.join(recoverySkill, "scripts", "c2c-status.ps1");
    const run = (profileId: string) => spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", statusScript,
      "-TargetProfile", profileId, "-C2cJs", fakeCli], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, C2C_TEST_PROFILES: profilesFile, C2C_TEST_CALLS: callsFile },
    });

    const resultA = run("project-a");
    const resultB = run("project-b");
    expect(resultA.status, resultA.stderr + resultA.stdout).toBe(0);
    expect(resultB.status, resultB.stderr + resultB.stdout).toBe(0);
    const calls = fs.readFileSync(callsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; stateDir: string });
    for (const [profile, result] of [[value.resolvedA, JSON.parse(resultA.stdout.trim())], [value.resolvedB, JSON.parse(resultB.stdout.trim())]] as const) {
      const ownCalls = calls.filter((call) => call.args[0] !== "control-target" && call.stateDir === profile.targetStateDir);
      expect(ownCalls.length).toBeGreaterThan(0);
      expect(ownCalls.every((call) => call.stateDir === profile.targetStateDir)).toBe(true);
      expect(result.workspace).toMatchObject({ workspaceId: profile.workspaceId, name: profile.profileId });
      expect(result.targetBinding).toMatchObject({ profileId: profile.profileId, workspaceId: profile.workspaceId, workspaceRoot: profile.targetWorkspaceRoot, stateDir: profile.targetStateDir });
      for (const call of ownCalls) {
        const workspaceIndex = call.args.indexOf("--workspace");
        if (workspaceIndex >= 0) expect(path.resolve(call.args[workspaceIndex + 1])).toBe(profile.targetWorkspaceRoot);
      }
    }
  });
});
