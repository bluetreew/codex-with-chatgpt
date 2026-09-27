import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startBridge } from "../src/bridge/server.js";
import {
  classifyProbe,
  compareRecoveryEndpoint,
  planRecovery,
  sessionSnapshotPreserved,
  suggestConnectorName,
  type DoctorFacts,
  type ExecutionProbe,
  type RecoveryFacts,
  type RecoverySessionSnapshot,
} from "../src/recovery/harness.js";
import { probeExecutionContext, resolveApprovedCloudflaredPath, type ProbeAdapter } from "../src/recovery/probe.js";
import { readRecoveryProgress, recoveryProgressFile, writeRecoveryProgress } from "../src/recovery/state.js";
import type { TunnelProvider } from "../src/tunnel/provider.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(repoRoot, "src", "cli", "index.ts");
const skillRoot = path.join(repoRoot, "skill", "c2c-emergency-recovery");
const tempDirs: string[] = [];

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    env,
  });
}

afterEach(() => {
  while (tempDirs.length) cleanup(tempDirs.pop()!);
  delete process.env.C2C_STATE_DIR;
});

const session: RecoverySessionSnapshot = {
  url: "https://chatgpt.com/g/g-p-demo-chat/c/chat-123",
  projectUrl: "https://chatgpt.com/g/g-p-demo/project",
  workflowMode: "design-first",
  checkpoint: { taskId: "older-task", protocolState: "DONE", waitingFor: "none" },
  connectorName: "Codex with ChatGPT · MOZI · v3",
  taskId: "older-task",
  iteration: 2,
  lastState: "DONE",
};

const localProbe: ExecutionProbe = {
  nodeChildSpawn: "PASS",
  cloudflaredSpawn: "PASS",
  relayFork: "PASS",
  classification: "CAPABLE",
};

const healthyDoctor: DoctorFacts = {
  report: Object.fromEntries(["node", "sandbox", "workspace", "bridge", "mcp", "oauth", "tunnel"].map((key) => [key, { ok: true }])),
  chatgptRepair: {
    needed: false,
    connectorName: session.connectorName,
    mcpUrl: "https://fresh.trycloudflare.com/mcp",
    previousMcpUrl: "https://fresh.trycloudflare.com/mcp",
  },
  namedRepair: { needed: false },
};

function facts(overrides: Partial<RecoveryFacts> = {}): RecoveryFacts {
  return {
    workspace: { workspaceId: "workspace-123", name: "MOZI" },
    session,
    bridgeStatus: "healthy",
    localProbe,
    doctor: healthyDoctor,
    ...overrides,
  };
}

describe("recovery helper argument forwarding", () => {
  function runRestartFixture(overrides: Record<string, unknown> = {}) {
    if (process.platform !== "win32") return null;
    const root = makeTmpDir("recovery-restart-fixture");
    tempDirs.push(root);
    const workspace = path.join(root, "职业教育 工作区 with spaces");
    fs.mkdirSync(workspace, { recursive: true });
    const persistPlanner = overrides.persistPlanner === true;
    const stateDir = persistPlanner ? isolateStateDir() : path.join(root, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    if (persistPlanner) tempDirs.push(stateDir);
    const sessionFixture: RecoverySessionSnapshot = {
      url: "https://chatgpt.com/g/g-p-demo/c/chat-123",
      projectUrl: "https://chatgpt.com/g/g-p-demo/project",
      workflowMode: "design-first",
      checkpoint: { taskId: "task-old", waitingFor: "none" },
      connectorName: "MOZI v3",
      taskId: "task-old",
      iteration: 4,
      lastState: "DONE",
    };
    const probe = {
      bridgeStatus: "healthy",
      localProbe,
      bridgeProbe: { ...localProbe, classification: "RESTRICTED_BRIDGE_CONTEXT" },
      bridgeProbeError: false,
    };
    const doctor = {
      report: Object.fromEntries(["node", "sandbox", "workspace", "bridge", "mcp", "oauth", "tunnel"].map((key) => [key, { ok: true }])),
      chatgptRepair: { needed: false, connectorName: "MOZI v3", mcpUrl: "https://fixture.invalid/mcp", previousMcpUrl: "https://fixture.invalid/mcp" },
      namedRepair: { needed: false },
    };
    const fixtureFile = path.join(root, "scenario.json");
    fs.writeFileSync(fixtureFile, JSON.stringify({
      calls: [], session: sessionFixture, probe, doctor, workspacePath: workspace,
      planAction: "RESTART_BRIDGE_IN_CAPABLE_CONTEXT",
      useRealPlanner: persistPlanner,
      ...overrides,
    }));
    if (persistPlanner) {
      writeRecoveryProgress(new Workspace(workspace).id, { state: "LOCAL_RECOVERY", capableContextAttempted: false, bridgeRestartAttempted: false });
    }
    const script = path.join(skillRoot, "scripts", "c2c-start-tunnel.ps1");
    const fakeCli = path.join(repoRoot, "tests", "fixtures", "fake-recovery-cli.mjs");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
      "-WorkspacePath", workspace, "-StateDir", stateDir, "-C2cJs", fakeCli, "-Action", "restart"], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, C2C_TEST_RECOVERY_FIXTURE: fixtureFile },
    });
    return { result, state: JSON.parse(fs.readFileSync(fixtureFile, "utf8")) as Record<string, any> };
  }

  it("does not restart a healthy Bridge and runs isolated restart orchestration only for restricted Bridge evidence", () => {
    const healthy = runRestartFixture({
      planAction: "COMPARE_ENDPOINT",
      probe: { bridgeStatus: "healthy", localProbe, bridgeProbe: localProbe, bridgeProbeError: false },
    });
    if (!healthy) return;
    expect(healthy.state.restartInvoked).not.toBe(true);
    expect(healthy.state.calls.some((args: string[]) => args[0] === "restart")).toBe(false);

    const restricted = runRestartFixture();
    if (!restricted) return;
    expect(restricted.state.calls.some((args: string[]) => args[0] === "restart")).toBe(true);
    const recovered = JSON.parse(restricted.result.stdout.trim());
    expect(recovered.state).toBe("COMPARE_ENDPOINT");
    expect(recovered.session).toEqual(restricted.state.session);
  });

  it.each(["url", "projectUrl", "workflowMode", "checkpoint", "connectorName", "taskId", "iteration", "lastState"])(
    "blocks restart when protected session field %s changes",
    (field) => {
      const run = runRestartFixture({ mutateField: field, mutatedValue: "changed", persistPlanner: true });
      if (!run) return;
      const workspace = new Workspace(run.state.workspacePath ?? "");
      const response = JSON.parse(run.result.stdout.trim());
      expect(response.state).toBe("BLOCKED_STATE_INCONSISTENT");
      expect(readRecoveryProgress(workspace.id)?.state).toBe("BLOCKED_STATE_INCONSISTENT");
      const laterPlanFacts = facts({ phase: "LOCAL_DIAGNOSIS" });
      const later = runCli(["recovery-plan", "--workspace", workspace.root, "--facts-base64", Buffer.from(JSON.stringify(laterPlanFacts), "utf8").toString("base64"), "--json"]);
      expect(JSON.parse(later.stdout.trim()).nextAction).toBe("BLOCKED_STATE_INCONSISTENT");
    },
  );

  it("returns a terminal blocked result when fixture restart fails", () => {
    const run = runRestartFixture({ restartFailure: true, persistPlanner: true });
    if (!run) return;
    const response = JSON.parse(run.result.stdout.trim());
    expect(response.nextAction).toBe("BLOCKED_LOCAL_EXECUTION");
    expect(run.state.calls.filter((args: string[]) => args[0] === "restart")).toHaveLength(1);
    const workspace = new Workspace(run.state.workspacePath);
    expect(readRecoveryProgress(workspace.id)?.state).toBe("BLOCKED_LOCAL_EXECUTION");
    const later = runCli(["recovery-plan", "--workspace", workspace.root, "--facts-base64", Buffer.from(JSON.stringify(facts()), "utf8").toString("base64"), "--json"]);
    expect(JSON.parse(later.stdout.trim()).nextAction).toBe("BLOCKED_LOCAL_EXECUTION");
  });

  it.each([
    { scriptName: "c2c-pair.ps1", cliArgs: ["-RecoveryState", "WAIT_PAIR_CODE_GENERATION"], currentState: "HUMAN_MCP_APP_GATE", forbiddenCommand: "pair" },
    { scriptName: "c2c-confirm.ps1", cliArgs: ["-RecoveryState", "AI_CONFIRM_CONNECTOR", "-ConnectorName", "MOZI v4", "-McpUrl", "https://fixture.invalid/mcp"], currentState: "HUMAN_MCP_APP_GATE", forbiddenCommand: "session set" },
  ])("rejects an out-of-order $scriptName call before any side effect", ({ scriptName, cliArgs, currentState, forbiddenCommand }) => {
    if (process.platform !== "win32") return;
    const root = makeTmpDir("recovery-pairing-order");
    tempDirs.push(root);
    const workspace = path.join(root, "MOZI workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const stateDir = path.join(root, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const fixturePath = path.join(root, "scenario.json");
    fs.writeFileSync(fixturePath, JSON.stringify({
      calls: [], currentRecoveryState: currentState,
      session: { url: "https://chatgpt.com/c/saved", projectUrl: "https://chatgpt.com/project", workflowMode: "design-first", checkpoint: null, connectorName: "MOZI v3", taskId: "t1", iteration: 1, lastState: "DONE" },
      probe: { bridgeStatus: "healthy", localProbe, bridgeProbe: localProbe, bridgeProbeError: false },
      doctor: { report: Object.fromEntries(["node", "sandbox", "workspace", "bridge", "mcp", "oauth", "tunnel"].map((key) => [key, { ok: true }])), chatgptRepair: { needed: true, connectorName: "MOZI v3", mcpUrl: "https://fixture.invalid/mcp", previousMcpUrl: "https://old.invalid/mcp" }, namedRepair: { needed: false } },
    }));
    const script = path.join(skillRoot, "scripts", scriptName);
    const fakeCli = path.join(repoRoot, "tests", "fixtures", "fake-recovery-cli.mjs");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
      ...cliArgs, "-WorkspacePath", workspace, "-StateDir", stateDir, "-C2cJs", fakeCli], {
      encoding: "utf8", windowsHide: true,
      env: { ...process.env, C2C_TEST_RECOVERY_FIXTURE: fixturePath },
    });
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    expect(JSON.parse(result.stdout.trim()).state).toBe("INVALID_RECOVERY_TRANSITION");
    expect(fixture.calls.some((args: string[]) => args.join(" ").startsWith(forbiddenCommand))).toBe(false);
  });

  it("rejects a wrong Connector URL before changing the session name", () => {
    if (process.platform !== "win32") return;
    const root = makeTmpDir("recovery-confirm-url-guard");
    tempDirs.push(root);
    const workspace = path.join(root, "MOZI workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const stateDir = path.join(root, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const fixturePath = path.join(root, "scenario.json");
    const doctor = { report: Object.fromEntries(["node", "sandbox", "workspace", "bridge", "mcp", "oauth", "tunnel"].map((key) => [key, { ok: true }])), chatgptRepair: { needed: true, connectorName: "MOZI v3", mcpUrl: "https://fixture.invalid/mcp", previousMcpUrl: "https://old.invalid/mcp" }, namedRepair: { needed: false } };
    fs.writeFileSync(fixturePath, JSON.stringify({
      calls: [], currentRecoveryState: "AI_CONFIRM_CONNECTOR", useRealPlanner: true,
      session: { url: "https://chatgpt.com/c/saved", projectUrl: "https://chatgpt.com/project", workflowMode: "design-first", checkpoint: null, connectorName: "MOZI v3", taskId: "t1", iteration: 1, lastState: "DONE" },
      probe: { bridgeStatus: "healthy", localProbe, bridgeProbe: localProbe, bridgeProbeError: false },
      doctor,
    }));
    const plannerEnv = { ...process.env, C2C_STATE_DIR: stateDir };
    const plannerFacts = facts({
      doctor,
      session: {
        url: "https://chatgpt.com/c/saved", projectUrl: "https://chatgpt.com/project", workflowMode: "design-first",
        checkpoint: null, connectorName: "MOZI v3", taskId: "t1", iteration: 1, lastState: "DONE",
      },
    });
    const encoded = (value: RecoveryFacts) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
    const plan = (value: RecoveryFacts, newRun = false) => runCli([
      "recovery-plan", "--workspace", workspace, ...(newRun ? ["--new-run"] : []), "--facts-base64", encoded(value), "--json",
    ], plannerEnv);
    const initialPlan = plan({ ...plannerFacts, phase: "ENDPOINT_COMPARE" }, true);
    expect(JSON.parse(initialPlan.stdout).state, initialPlan.stdout).toBe("HUMAN_MCP_APP_GATE");
    let state = "HUMAN_MCP_APP_GATE";
    for (const [event, extra] of [
      ["PAIRING_PAGE_OPENED", {}],
      ["PAIR_CODE_GENERATION_REQUESTED", {}],
      ["PAIR_CODE_GENERATED", {}],
      ["PAIRING_COMPLETED", { actualConnectorName: "MOZI v4" }],
    ] as Array<[RecoveryEvent, Partial<RecoveryFacts>]>) {
      const transition = JSON.parse(plan({ ...plannerFacts, recoveryState: state as RecoveryState, transitionEvent: event, ...extra }).stdout);
      state = transition.state;
    }
    expect(state).toBe("AI_CONFIRM_CONNECTOR");
    const fakeCli = path.join(repoRoot, "tests", "fixtures", "fake-recovery-cli.mjs");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(skillRoot, "scripts", "c2c-confirm.ps1"),
      "-RecoveryState", "AI_CONFIRM_CONNECTOR", "-ConnectorName", "MOZI v4", "-McpUrl", "https://wrong.invalid/mcp",
      "-WorkspacePath", workspace, "-StateDir", stateDir, "-C2cJs", fakeCli], {
      encoding: "utf8", windowsHide: true,
      env: { ...process.env, C2C_TEST_RECOVERY_FIXTURE: fixturePath },
    });
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    expect(JSON.parse(result.stdout.trim()).state).toBe("INVALID_RECOVERY_TRANSITION");
    expect(fixture.calls.some((args: string[]) => args.join(" ").startsWith("session set"))).toBe(false);
    expect(fixture.calls.some((args: string[]) => args[0] === "connector-confirm")).toBe(false);
    const progressPath = path.join(stateDir, "recovery-progress", `${encodeURIComponent(new Workspace(workspace).id).replaceAll("%", "_")}.json`);
    expect(JSON.parse(fs.readFileSync(progressPath, "utf8")).state).toBe("AI_CONFIRM_CONNECTOR");

    const wrongIdentity = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(skillRoot, "scripts", "c2c-confirm.ps1"),
      "-RecoveryState", "AI_CONFIRM_CONNECTOR", "-ConnectorName", "MOZI v5", "-McpUrl", "https://fixture.invalid/mcp",
      "-WorkspacePath", workspace, "-StateDir", stateDir, "-C2cJs", fakeCli], {
      encoding: "utf8", windowsHide: true,
      env: { ...process.env, C2C_STATE_DIR: stateDir, C2C_TEST_RECOVERY_FIXTURE: fixturePath },
    });
    const callsAfterWrongIdentity = JSON.parse(fs.readFileSync(fixturePath, "utf8")).calls as string[][];
    expect(JSON.parse(wrongIdentity.stdout.trim()).state).toBe("INVALID_RECOVERY_TRANSITION");
    expect(callsAfterWrongIdentity.some((args) => args.join(" ").startsWith("session set"))).toBe(false);
    expect(callsAfterWrongIdentity.some((args) => args[0] === "connector-confirm")).toBe(false);
    expect(JSON.parse(fs.readFileSync(progressPath, "utf8")).pairedConnectorName).toBe("MOZI v4");
  });

  it.each(["url", "projectUrl", "workflowMode", "checkpoint", "taskId", "iteration", "lastState"])(
    "persists a terminal block when Connector confirmation changes protected session field %s",
    (field) => {
      if (process.platform !== "win32") return;
      const root = makeTmpDir("recovery-confirm-session-mismatch");
      tempDirs.push(root);
      const workspace = path.join(root, "MOZI workspace");
      fs.mkdirSync(workspace, { recursive: true });
      const stateDir = isolateStateDir();
      tempDirs.push(stateDir);
      const sessionFixture = { url: "https://chatgpt.com/c/saved", projectUrl: "https://chatgpt.com/project", workflowMode: "design-first", checkpoint: null, connectorName: "MOZI v3", taskId: "task-1", iteration: 1, lastState: "DONE" };
      const fixturePath = path.join(root, "scenario.json");
      fs.writeFileSync(fixturePath, JSON.stringify({
        calls: [], useRealPlanner: true, session: sessionFixture,
        mutateFieldOnSessionSet: field, mutatedValue: "changed",
        probe: { bridgeStatus: "healthy", localProbe, bridgeProbe: localProbe, bridgeProbeError: false },
        doctor: { report: Object.fromEntries(["node", "sandbox", "workspace", "bridge", "mcp", "oauth", "tunnel"].map((key) => [key, { ok: true }])), chatgptRepair: { needed: true, connectorName: "MOZI v3", mcpUrl: "https://fixture.invalid/mcp", previousMcpUrl: "https://old.invalid/mcp" }, namedRepair: { needed: false } },
      }));
      const workspaceId = new Workspace(workspace).id;
      writeRecoveryProgress(workspaceId, { state: "AI_CONFIRM_CONNECTOR", capableContextAttempted: false, bridgeRestartAttempted: false, sessionSnapshot: sessionFixture, pairedConnectorName: "MOZI v4" });
      const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(skillRoot, "scripts", "c2c-confirm.ps1"),
        "-RecoveryState", "AI_CONFIRM_CONNECTOR", "-ConnectorName", "MOZI v4", "-McpUrl", "https://fixture.invalid/mcp",
        "-WorkspacePath", workspace, "-StateDir", stateDir, "-C2cJs", path.join(repoRoot, "tests", "fixtures", "fake-recovery-cli.mjs")], {
        encoding: "utf8", windowsHide: true,
        env: { ...process.env, C2C_STATE_DIR: stateDir, C2C_TEST_RECOVERY_FIXTURE: fixturePath },
      });
      expect(JSON.parse(result.stdout.trim()).state, result.stdout + result.stderr).toBe("BLOCKED_STATE_INCONSISTENT");
      expect(readRecoveryProgress(workspaceId)?.state).toBe("BLOCKED_STATE_INCONSISTENT");
      const later = runCli(["recovery-plan", "--workspace", workspace, "--facts-base64", Buffer.from(JSON.stringify(facts()), "utf8").toString("base64"), "--json"], { ...process.env, C2C_STATE_DIR: stateDir });
      expect(JSON.parse(later.stdout.trim()).nextAction).toBe("BLOCKED_STATE_INCONSISTENT");
    },
  );

  it("records pair-code generation failure as terminal state instead of leaving a retry loop", () => {
    if (process.platform !== "win32") return;
    const root = makeTmpDir("recovery-pair-failure");
    tempDirs.push(root);
    const workspace = path.join(root, "MOZI workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const stateDir = path.join(root, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const fixturePath = path.join(root, "scenario.json");
    fs.writeFileSync(fixturePath, JSON.stringify({
      calls: [], currentRecoveryState: "HUMAN_MCP_APP_GATE", useRealPlanner: true, pairFailure: true,
      session: { url: "https://chatgpt.com/c/saved", projectUrl: "https://chatgpt.com/project", workflowMode: "design-first", checkpoint: null, connectorName: "MOZI v3", taskId: "t1", iteration: 1, lastState: "DONE" },
      probe: { bridgeStatus: "healthy", localProbe, bridgeProbe: localProbe, bridgeProbeError: false },
      doctor: { report: Object.fromEntries(["node", "sandbox", "workspace", "bridge", "mcp", "oauth", "tunnel"].map((key) => [key, { ok: true }])), chatgptRepair: { needed: true, connectorName: "MOZI v3", mcpUrl: "https://fixture.invalid/mcp", previousMcpUrl: "https://old.invalid/mcp" }, namedRepair: { needed: false } },
    }));
    const fakeCli = path.join(repoRoot, "tests", "fixtures", "fake-recovery-cli.mjs");
    const run = (scriptName: string, args: string[]) => spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(skillRoot, "scripts", scriptName), ...args,
      "-WorkspacePath", workspace, "-StateDir", stateDir, "-C2cJs", fakeCli], {
      encoding: "utf8", windowsHide: true,
      env: { ...process.env, C2C_TEST_RECOVERY_FIXTURE: fixturePath },
    });
    const status = (args: string[]) => JSON.parse(run("c2c-status.ps1", args).stdout.trim());
    expect(status(["-StartNewRecovery"]).state).toBe("HUMAN_MCP_APP_GATE");
    expect(status(["-RecoveryState", "HUMAN_MCP_APP_GATE", "-TransitionEvent", "PAIRING_PAGE_OPENED"]).state).toBe("WAIT_PAIR_CODE_GENERATION");
    const result = JSON.parse(run("c2c-pair.ps1", ["-RecoveryState", "WAIT_PAIR_CODE_GENERATION"]).stdout.trim());
    expect(result.state).toBe("LOCAL_RECOVERY_FAILED");
    const calls = JSON.parse(fs.readFileSync(fixturePath, "utf8")).calls as string[][];
    expect(calls.filter((args) => args[0] === "pair")).toHaveLength(1);
    const progressPath = path.join(stateDir, "recovery-progress", `${encodeURIComponent(new Workspace(workspace).id).replaceAll("%", "_")}.json`);
    expect(JSON.parse(fs.readFileSync(progressPath, "utf8")).state).toBe("LOCAL_RECOVERY_FAILED");
  });

  it("runs pairing wrappers through post-pair verification with fixture Connector and workspace facts", () => {
    if (process.platform !== "win32") return;
    const root = makeTmpDir("recovery-pairing-full-flow");
    tempDirs.push(root);
    const workspace = path.join(root, "MOZI workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const stateDir = path.join(root, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const fixturePath = path.join(root, "scenario.json");
    const savedUrl = "https://chatgpt.com/g/g-p-demo/c/saved-chat";
    fs.writeFileSync(fixturePath, JSON.stringify({
      calls: [], currentRecoveryState: "HUMAN_MCP_APP_GATE", useRealPlanner: true,
      session: { url: savedUrl, projectUrl: "https://chatgpt.com/g/g-p-demo/project", workflowMode: "design-first", checkpoint: { taskId: "t1", waitingFor: "none" }, connectorName: "MOZI v3", taskId: "t1", iteration: 1, lastState: "DONE" },
      probe: { bridgeStatus: "healthy", localProbe, bridgeProbe: localProbe, bridgeProbeError: false },
      doctor: { report: Object.fromEntries(["node", "sandbox", "workspace", "bridge", "mcp", "oauth", "tunnel"].map((key) => [key, { ok: true }])), chatgptRepair: { needed: true, connectorName: "MOZI v3", mcpUrl: "https://fixture.invalid/mcp", previousMcpUrl: "https://old.invalid/mcp" }, namedRepair: { needed: false } },
    }));
    const fakeCli = path.join(repoRoot, "tests", "fixtures", "fake-recovery-cli.mjs");
    const run = (scriptName: string, args: string[]) => spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(skillRoot, "scripts", scriptName), ...args,
      "-WorkspacePath", workspace, "-StateDir", stateDir, "-C2cJs", fakeCli], {
      encoding: "utf8", windowsHide: true,
      env: { ...process.env, C2C_TEST_RECOVERY_FIXTURE: fixturePath },
    });
    const status = (args: string[]) => JSON.parse(run("c2c-status.ps1", args).stdout.trim());

    expect(status(["-StartNewRecovery"]).state).toBe("HUMAN_MCP_APP_GATE");
    expect(status(["-RecoveryState", "HUMAN_MCP_APP_GATE", "-TransitionEvent", "PAIRING_PAGE_OPENED"]).state).toBe("WAIT_PAIR_CODE_GENERATION");
    const pairing = JSON.parse(run("c2c-pair.ps1", ["-RecoveryState", "WAIT_PAIR_CODE_GENERATION"]).stdout.trim());
    expect(pairing.state).toBe("WAIT_PAIRING_COMPLETE");
    expect(status(["-RecoveryState", "WAIT_PAIRING_COMPLETE", "-TransitionEvent", "PAIRING_COMPLETED", "-ActualConnectorName", "MOZI v4"]).state).toBe("AI_CONFIRM_CONNECTOR");
    const confirmation = JSON.parse(run("c2c-confirm.ps1", ["-RecoveryState", "AI_CONFIRM_CONNECTOR", "-ConnectorName", "MOZI v4", "-McpUrl", "https://fixture.invalid/mcp"]).stdout.trim());
    expect(confirmation.recoveryState).toBe("POST_RECOVERY_VERIFY");
    const complete = status([
      "-RecoveryState", "POST_RECOVERY_VERIFY", "-Phase", "POST_RECOVERY_VERIFY", "-ConnectorConfirmed",
      "-WorkspaceInfoName", "Fixture Workspace", "-WorkspaceInfoId", "fixture-workspace", "-SavedChatUrlAfter", savedUrl,
      "-CheckId", "check-1", "-ReplyCheckId", "check-1",
    ]);
    expect(complete.state, JSON.stringify(complete)).toBe("COMPLETE");
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    expect(fixture.calls.some((args: string[]) => args[0] === "pair")).toBe(true);
    expect(fixture.calls.some((args: string[]) => args[0] === "session" && args[1] === "set")).toBe(true);
    expect(fixture.calls.some((args: string[]) => args[0] === "connector-confirm")).toBe(true);
    const progressPath = path.join(stateDir, "recovery-progress", `${encodeURIComponent(new Workspace(workspace).id).replaceAll("%", "_")}.json`);
    expect(JSON.parse(fs.readFileSync(progressPath, "utf8")).state).toBe("COMPLETE");
  });

  it("preserves --workspace and a Chinese path containing spaces without common-parameter binding", () => {
    if (process.platform !== "win32") return;
    const powershell = spawnSync("powershell.exe", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (powershell.error || powershell.status !== 0) return;

    const root = makeTmpDir("recovery-wrapper");
    tempDirs.push(root);
    const workspace = path.join(root, "职业教育 工作区 with spaces");
    fs.mkdirSync(workspace, { recursive: true });
    const stateDir = path.join(root, "state dir");
    fs.mkdirSync(stateDir, { recursive: true });
    const fakeCli = write(root, "fake c2c.js", "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const smokeScript = path.join(repoRoot, "tests", "fixtures", "recovery-wrapper-smoke.ps1");
    const common = path.join(skillRoot, "scripts", "_common.ps1");
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", smokeScript,
        "-CommonScript", common, "-FakeC2cJs", fakeCli, "-WorkspacePath", workspace, "-StateDir", stateDir],
      { encoding: "utf8", windowsHide: true }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toMatch(/WarningAction|ambiguous parameter/i);
    expect(JSON.parse(result.stdout.trim())).toEqual(["status", "--workspace", workspace, "--json"]);
  });

  it("uses explicit --workspace arrays in every installed recovery wrapper", () => {
    const scriptsRoot = path.join(skillRoot, "scripts");
    const scripts = fs.readdirSync(scriptsRoot).filter((name) => name.endsWith(".ps1"));
    expect(scripts.length).toBeGreaterThan(0);
    for (const name of scripts) {
      const source = fs.readFileSync(path.join(scriptsRoot, name), "utf8");
      expect(source, name).not.toMatch(/Invoke-C2C(?:Json)?\s+[^\r\n]*\s-w\s/);
      if (name !== "_common.ps1") expect(source, name).toContain("--workspace");
    }
  });

  it("parses every recovery wrapper without shell execution", () => {
    if (process.platform !== "win32") return;
    const parseFixture = path.join(repoRoot, "tests", "fixtures", "recovery-script-parse.ps1");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", parseFixture, "-ScriptsRoot", path.join(skillRoot, "scripts")], {
      encoding: "utf8",
      windowsHide: true,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim()).ok).toBe(true);
  });
});

describe("safe process probe and recovery planning", () => {
  it("allows only the canonical C2C-managed cloudflared executable", () => {
    const root = makeTmpDir("cloudflared-allowlist");
    tempDirs.push(root);
    const managed = path.join(root, "cloudflared");
    fs.mkdirSync(managed, { recursive: true });
    const approved = write(managed, "cloudflared.exe", "fixture");
    const other = write(root, "other.exe", "fixture");
    const sameNameOutside = write(root, "cloudflared.exe", "fixture");
    const nested = path.join(managed, "alternate");
    fs.mkdirSync(nested, { recursive: true });
    const sameNameInsideManagedSubdirectory = write(nested, "cloudflared.exe", "fixture");
    expect(resolveApprovedCloudflaredPath(approved, managed).status).toBe("PASS");
    expect(resolveApprovedCloudflaredPath(approved, managed)).toEqual({ status: "PASS", path: fs.realpathSync(approved) });
    expect(resolveApprovedCloudflaredPath(other, managed).status).toBe("UNAPPROVED_CLOUDFLARED_PATH");
    expect(resolveApprovedCloudflaredPath(sameNameOutside, managed).status).toBe("UNAPPROVED_CLOUDFLARED_PATH");
    expect(resolveApprovedCloudflaredPath(sameNameInsideManagedSubdirectory, managed).status).toBe("UNAPPROVED_CLOUDFLARED_PATH");
    expect(resolveApprovedCloudflaredPath("relative/cloudflared.exe", managed).status).toBe("UNAPPROVED_CLOUDFLARED_PATH");
    expect(resolveApprovedCloudflaredPath("\0bad", managed).status).toBe("UNAPPROVED_CLOUDFLARED_PATH");
  });

  it("probes the default C2C-managed cloudflared path when no network-profile path is supplied", async () => {
    const stateDir = isolateStateDir();
    tempDirs.push(stateDir);
    const managed = path.join(path.dirname(stateDir), "cloudflared");
    fs.mkdirSync(managed, { recursive: true });
    const approved = write(managed, "cloudflared.exe", "fixture");
    const probed: string[] = [];
    const adapter: ProbeAdapter = {
      spawnVersion: (executable) => { probed.push(executable); return "PASS"; },
      forkRelay: async () => "PASS",
    };
    const result = await probeExecutionContext({ context: "local", adapter });
    expect(result.cloudflaredSpawn).toBe("PASS");
    expect(probed).toContain(fs.realpathSync(approved));
  });

  it("increments a versioned Connector name without changing its workspace label", () => {
    expect(suggestConnectorName("Codex with ChatGPT · 职业教育-MOZI · v3")).toBe("Codex with ChatGPT · 职业教育-MOZI · v4");
    expect(suggestConnectorName("Codex with ChatGPT · MOZI")).toBe("Codex with ChatGPT · MOZI · recovery");
  });

  it("exposes the planner as structured JSON for Skill helpers", () => {
    const stateDir = isolateStateDir();
    tempDirs.push(stateDir);
    const root = makeTmpDir("recovery-plan-structured");
    tempDirs.push(root);
    write(root, "README.md", "fixture workspace\n");
    const input = {
      workspace: { workspaceId: "workspace-123", name: "MOZI" },
      session,
      bridgeStatus: "healthy",
      localProbe,
      doctor: healthyDoctor,
    };
    const encoded = Buffer.from(JSON.stringify(input), "utf8").toString("base64");
    const result = runCli(["recovery-plan", "--workspace", root, "--new-run", "--facts-base64", encoded, "--json"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      state: "LOCAL_HEALTH_PASS",
      nextAction: "COMPARE_ENDPOINT",
      humanActionRequired: false,
    });
  });

  it("requires workspace-scoped persisted state for planning and transitions", () => {
    const deniedProbe: ExecutionProbe = { nodeChildSpawn: "EPERM", cloudflaredSpawn: "EPERM", relayFork: "EPERM", classification: "RESTRICTED_EXECUTION_CONTEXT" };
    const encoded = Buffer.from(JSON.stringify(facts({ bridgeStatus: "stopped", doctor: undefined, localProbe: deniedProbe })), "utf8").toString("base64");
    const escalation = runCli(["recovery-plan", "--facts-base64", encoded, "--json"]);
    expect(escalation.status).not.toBe(0);
    expect(escalation.stderr).toContain("--workspace");

    const pairingFacts = facts({
      phase: "WAIT_PAIR_CODE_GENERATION",
      recoveryState: "WAIT_PAIR_CODE_GENERATION",
      transitionEvent: "PAIRING_COMPLETED",
    });
    const pairing = runCli(["recovery-plan", "--facts-base64", Buffer.from(JSON.stringify(pairingFacts), "utf8").toString("base64"), "--json"]);
    expect(pairing.status).not.toBe(0);
    expect(pairing.stderr).toContain("--workspace");

    const pairingEncoded = Buffer.from(JSON.stringify(pairingFacts), "utf8").toString("base64");
    for (const workspace of ["", "   "]) {
      const unscopedEscalation = runCli(["recovery-plan", "--workspace", workspace, "--facts-base64", encoded, "--json"]);
      expect(unscopedEscalation.status).not.toBe(0);
      expect(unscopedEscalation.stdout + unscopedEscalation.stderr).toMatch(/non-empty path|workspace argument|requires an argument/i);
      const unscopedPairing = runCli(["recovery-plan", "--workspace", workspace, "--facts-base64", pairingEncoded, "--json"]);
      expect(unscopedPairing.status).not.toBe(0);
      expect(unscopedPairing.stdout + unscopedPairing.stderr).toMatch(/non-empty path|workspace argument|requires an argument/i);
    }
  });

  it("rejects a transition event combined with --new-run without mutating progress", () => {
    const stateDir = isolateStateDir();
    tempDirs.push(stateDir);
    const root = makeTmpDir("recovery-new-run-transition");
    tempDirs.push(root);
    write(root, "README.md", "fixture workspace\n");
    const workspaceId = new Workspace(root).id;
    writeRecoveryProgress(workspaceId, { state: "LOCAL_DIAGNOSIS", capableContextAttempted: false, bridgeRestartAttempted: false });
    const input = facts({
      phase: "ENDPOINT_COMPARE",
      recoveryState: "HUMAN_MCP_APP_GATE",
      transitionEvent: "PAIRING_PAGE_OPENED",
      doctor: { ...healthyDoctor, chatgptRepair: { needed: true, connectorName: session.connectorName, mcpUrl: "https://new.invalid/mcp", previousMcpUrl: "https://old.invalid/mcp" } },
    });
    const result = runCli(["recovery-plan", "--workspace", root, "--new-run", "--facts-base64", Buffer.from(JSON.stringify(input), "utf8").toString("base64"), "--json"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("cannot be combined");
    expect(readRecoveryProgress(workspaceId)?.state).toBe("LOCAL_DIAGNOSIS");
  });

  it.each(["COMPLETE", "BLOCKED_STATE_INCONSISTENT"] as const)("rejects a transition event after terminal state %s without changing progress", (state) => {
    const stateDir = isolateStateDir();
    tempDirs.push(stateDir);
    const root = makeTmpDir("recovery-terminal-transition");
    tempDirs.push(root);
    write(root, "README.md", "fixture workspace\n");
    const workspaceId = new Workspace(root).id;
    writeRecoveryProgress(workspaceId, { state, capableContextAttempted: false, bridgeRestartAttempted: false });
    const input = facts({ recoveryState: state, transitionEvent: "PAIRING_PAGE_OPENED" });
    const result = runCli(["recovery-plan", "--workspace", root, "--facts-base64", Buffer.from(JSON.stringify(input), "utf8").toString("base64"), "--json"]);
    expect(JSON.parse(result.stdout).state).toBe("INVALID_RECOVERY_TRANSITION");
    expect(readRecoveryProgress(workspaceId)?.state).toBe(state);
  });

  it.each(["url", "projectUrl", "workflowMode", "checkpoint", "taskId", "iteration", "lastState"])(
    "persists a terminal block for post-verification session mismatch in %s",
    (field) => {
      const stateDir = isolateStateDir();
      tempDirs.push(stateDir);
      const root = makeTmpDir("recovery-post-verify-session-mismatch");
      tempDirs.push(root);
      write(root, "README.md", "fixture workspace\n");
      const workspaceId = new Workspace(root).id;
      writeRecoveryProgress(workspaceId, { state: "POST_RECOVERY_VERIFY", capableContextAttempted: false, bridgeRestartAttempted: false, sessionSnapshot: session, pairedConnectorName: session.connectorName });
      const changedValue = field === "checkpoint" ? { taskId: "changed" } : field === "iteration" ? 99 : "changed";
      const sessionAfter = { ...session, [field]: changedValue } as RecoverySessionSnapshot;
      const input = facts({
        phase: "POST_RECOVERY_VERIFY",
        connectorConfirmed: true,
        actualConnectorName: session.connectorName,
        savedChatUrlAfter: session.url,
        workspaceInfo: { workspaceName: "MOZI", workspaceId: "workspace-123" },
        checkRoundTrip: { checkId: "check-1", replyCheckId: "check-1", workspaceName: "MOZI", workspaceId: "workspace-123" },
        sessionAfter,
      });
      const result = runCli(["recovery-plan", "--workspace", root, "--facts-base64", Buffer.from(JSON.stringify(input), "utf8").toString("base64"), "--json"]);
      expect(JSON.parse(result.stdout.trim()).state).toBe("BLOCKED_STATE_INCONSISTENT");
      expect(readRecoveryProgress(workspaceId)?.state).toBe("BLOCKED_STATE_INCONSISTENT");
    },
  );

  it("persists recovery state and rejects a caller state that does not match it", () => {
    const stateDir = isolateStateDir();
    tempDirs.push(stateDir);
    const root = makeTmpDir("recovery-progress-cli");
    tempDirs.push(root);
    write(root, "README.md", "fixture workspace\n");
    const gateDoctor = { ...healthyDoctor, chatgptRepair: { ...healthyDoctor.chatgptRepair, needed: true, mcpUrl: "https://new.trycloudflare.com/mcp", previousMcpUrl: "https://old.trycloudflare.com/mcp" } };
    const initialFacts = facts({ phase: "ENDPOINT_COMPARE", doctor: gateDoctor });
    const encode = (value: RecoveryFacts) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
    const uninitialized = runCli(["recovery-plan", "--workspace", root, "--facts-base64", encode(initialFacts), "--json"]);
    expect(JSON.parse(uninitialized.stdout).state).toBe("BLOCKED_STATE_INCONSISTENT");
    const initial = runCli(["recovery-plan", "--workspace", root, "--new-run", "--facts-base64", encode(initialFacts), "--json"]);
    expect(JSON.parse(initial.stdout).state).toBe("HUMAN_MCP_APP_GATE");

    const staleEvent = runCli(["recovery-plan", "--workspace", root, "--facts-base64", encode({
      ...initialFacts, recoveryState: "WAIT_PAIR_CODE_GENERATION", transitionEvent: "PAIRING_PAGE_OPENED",
    }), "--json"]);
    expect(JSON.parse(staleEvent.stdout).state).toBe("INVALID_RECOVERY_TRANSITION");

    const validEvent = runCli(["recovery-plan", "--workspace", root, "--facts-base64", encode({
      ...initialFacts, recoveryState: "HUMAN_MCP_APP_GATE", transitionEvent: "PAIRING_PAGE_OPENED",
    }), "--json"]);
    expect(JSON.parse(validEvent.stdout).state).toBe("WAIT_PAIR_CODE_GENERATION");
  });

  it("blocks and persists Connector identity drift after pairing before final verification", () => {
    const stateDir = isolateStateDir();
    tempDirs.push(stateDir);
    const root = makeTmpDir("recovery-post-verify-connector-drift");
    tempDirs.push(root);
    write(root, "README.md", "fixture workspace\n");
    const workspaceId = new Workspace(root).id;
    writeRecoveryProgress(workspaceId, { state: "POST_RECOVERY_VERIFY", capableContextAttempted: false, bridgeRestartAttempted: false, sessionSnapshot: session, pairedConnectorName: "MOZI v4" });
    const input = facts({
      phase: "POST_RECOVERY_VERIFY",
      connectorConfirmed: true,
      actualConnectorName: "MOZI v5",
      savedChatUrlAfter: session.url,
      workspaceInfo: { workspaceName: "MOZI", workspaceId: "workspace-123" },
      checkRoundTrip: { checkId: "check-1", replyCheckId: "check-1", workspaceName: "MOZI", workspaceId: "workspace-123" },
      sessionAfter: { ...session, connectorName: "MOZI v5" },
      doctor: { ...healthyDoctor, chatgptRepair: { ...healthyDoctor.chatgptRepair, connectorName: "MOZI v5" } },
    });
    const result = runCli(["recovery-plan", "--workspace", root, "--facts-base64", Buffer.from(JSON.stringify(input), "utf8").toString("base64"), "--json"]);
    expect(JSON.parse(result.stdout.trim()).state).toBe("BLOCKED_STATE_INCONSISTENT");
    expect(readRecoveryProgress(workspaceId)?.state).toBe("BLOCKED_STATE_INCONSISTENT");
  });

  it("persists the one-escalation decision and follows actual probe evidence over RunContext", () => {
    const stateDir = isolateStateDir();
    tempDirs.push(stateDir);
    const root = makeTmpDir("recovery-escalation-cli");
    const workspace = path.join(root, "blocked");
    const capableWorkspace = path.join(root, "capable");
    tempDirs.push(root);
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(capableWorkspace, { recursive: true });
    const deniedProbe: ExecutionProbe = { nodeChildSpawn: "EPERM", cloudflaredSpawn: "EPERM", relayFork: "EPERM", classification: "RESTRICTED_EXECUTION_CONTEXT" };
    const encode = (value: RecoveryFacts) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
    const standardFacts = facts({ bridgeStatus: "stopped", doctor: undefined, localProbe: deniedProbe, executionContext: "standard" });
    const first = runCli(["recovery-plan", "--workspace", workspace, "--new-run", "--facts-base64", encode(standardFacts), "--json"]);
    expect(JSON.parse(first.stdout).nextAction).toBe("RETRY_CAPABLE_CONTEXT");
    expect(JSON.parse(first.stdout).facts.capableContextAttempted).toBe(true);
    const failedCapableProbe = runCli(["recovery-plan", "--workspace", workspace, "--facts-base64", encode({ ...standardFacts, executionContext: "capable" }), "--json"]);
    expect(JSON.parse(failedCapableProbe.stdout).state).toBe("BLOCKED_LOCAL_EXECUTION");
    expect(JSON.parse(failedCapableProbe.stdout).nextAction).not.toBe("RETRY_CAPABLE_CONTEXT");

    const actualPassFacts = facts({ bridgeStatus: "stopped", doctor: undefined, localProbe, executionContext: "standard" });
    const actualPass = runCli(["recovery-plan", "--workspace", capableWorkspace, "--new-run", "--facts-base64", encode(actualPassFacts), "--json"]);
    expect(JSON.parse(actualPass.stdout).nextAction).toBe("START_BRIDGE_AND_TUNNEL");
  });

  it("persists the authorized Bridge restart and rejects a second restart plan", () => {
    const stateDir = isolateStateDir();
    tempDirs.push(stateDir);
    const root = makeTmpDir("recovery-bridge-restart-guard");
    tempDirs.push(root);
    write(root, "README.md", "fixture workspace\n");
    const restrictedBridge: ExecutionProbe = { ...localProbe, relayFork: "EPERM", classification: "RESTRICTED_BRIDGE_CONTEXT" };
    const input = facts({ bridgeProbe: restrictedBridge, localProbe });
    const encoded = Buffer.from(JSON.stringify(input), "utf8").toString("base64");
    const initial = runCli(["recovery-plan", "--workspace", root, "--new-run", "--facts-base64", encoded, "--json"]);
    expect(JSON.parse(initial.stdout).nextAction).toBe("RESTART_BRIDGE_IN_CAPABLE_CONTEXT");
    const authorized = runCli(["recovery-plan", "--workspace", root, "--authorize-restart", "--facts-base64", encoded, "--json"]);
    expect(JSON.parse(authorized.stdout).nextAction).toBe("RESTART_BRIDGE_IN_CAPABLE_CONTEXT");
    const recordPath = path.join(stateDir, "recovery-progress", `${encodeURIComponent(new Workspace(root).id).replaceAll("%", "_")}.json`);
    expect(JSON.parse(fs.readFileSync(recordPath, "utf8")).bridgeRestartAttempted).toBe(true);
    const repeated = runCli(["recovery-plan", "--workspace", root, "--facts-base64", encoded, "--json"]);
    expect(JSON.parse(repeated.stdout).state).toBe("LOCAL_RECOVERY_FAILED");
    expect(JSON.parse(repeated.stdout).nextAction).not.toBe("RESTART_BRIDGE_IN_CAPABLE_CONTEXT");
  });

  it("classifies standard and Bridge EPERM separately", () => {
    const denied = { nodeChildSpawn: "EPERM", cloudflaredSpawn: "PASS", relayFork: "EPERM" } as const;
    expect(classifyProbe("local", denied)).toBe("RESTRICTED_EXECUTION_CONTEXT");
    expect(classifyProbe("bridge", { ...denied, nodeChildSpawn: "PASS" })).toBe("RESTRICTED_BRIDGE_CONTEXT");
  });

  it("uses injected safe probes without launching real children", async () => {
    const adapter: ProbeAdapter = {
      spawnVersion: () => "PASS",
      forkRelay: async () => "EPERM",
    };
    const root = makeTmpDir("approved-probe");
    tempDirs.push(root);
    const managed = path.join(root, "cloudflared");
    fs.mkdirSync(managed, { recursive: true });
    const approved = write(managed, "cloudflared.exe", "fixture");
    const result = await probeExecutionContext({ context: "bridge", cloudflaredPath: approved, managedCloudflaredDirectory: managed, adapter });
    expect(result).toEqual({
      nodeChildSpawn: "PASS",
      cloudflaredSpawn: "PASS",
      relayFork: "EPERM",
      classification: "RESTRICTED_BRIDGE_CONTEXT",
    });
  });

  it("does not invoke an unapproved executable while probing", async () => {
    const calls: string[] = [];
    const adapter: ProbeAdapter = {
      spawnVersion: (executable) => { calls.push(executable); return "PASS"; },
      forkRelay: async () => "PASS",
    };
    const result = await probeExecutionContext({ context: "local", cloudflaredPath: process.execPath, adapter });
    expect(result).toEqual({
      nodeChildSpawn: "PASS",
      cloudflaredSpawn: "UNAPPROVED_CLOUDFLARED_PATH",
      relayFork: "PASS",
      classification: "UNAPPROVED_CLOUDFLARED_PATH",
    });
    expect(calls).toEqual([process.execPath]);
  });

  it("restarts a restricted Bridge only after local child capability passes and preserves session metadata", () => {
    const restricted: ExecutionProbe = { ...localProbe, relayFork: "EPERM", classification: "RESTRICTED_BRIDGE_CONTEXT" };
    const decision = planRecovery(facts({ bridgeProbe: restricted }));
    expect(decision.nextAction).toBe("RESTART_BRIDGE_IN_CAPABLE_CONTEXT");
    expect(decision.facts.bridgeRestartAttempted).toBe(true);
    expect(planRecovery(facts({ bridgeProbe: restricted, bridgeRestartAttempted: true })).state).toBe("LOCAL_RECOVERY_FAILED");
    expect(sessionSnapshotPreserved(session, { ...session })).toBe(true);
  });

  it("uses actual probe evidence and permits only one capable-context escalation", () => {
    const deniedProbe: ExecutionProbe = {
      nodeChildSpawn: "EPERM",
      cloudflaredSpawn: "EPERM",
      relayFork: "EPERM",
      classification: "RESTRICTED_EXECUTION_CONTEXT",
    };
    const initial = planRecovery(facts({ bridgeStatus: "stopped", doctor: undefined, localProbe: deniedProbe, executionContext: "capable" }));
    expect(initial.nextAction).toBe("RETRY_CAPABLE_CONTEXT");
    expect(initial.facts.capableContextAttempted).toBe(true);
    const retry = planRecovery(facts({
      bridgeStatus: "stopped",
      doctor: undefined,
      localProbe: deniedProbe,
      executionContext: "standard",
      capableContextAttempted: true,
      localActionResult: { ok: false, errorCode: "EPERM" },
    }));
    expect(retry.state).toBe("BLOCKED_LOCAL_EXECUTION");
    expect(retry.nextAction).not.toBe("RETRY_CAPABLE_CONTEXT");
    expect(JSON.stringify(retry)).not.toMatch(/USER_SHELL_HANDOFF|ask the user to run/i);
    expect(planRecovery(facts({ localProbe, capableContextAttempted: true })).nextAction).toBe("COMPARE_ENDPOINT");
    expect(planRecovery(facts({ localProbe, executionContext: "standard" })).nextAction).toBe("COMPARE_ENDPOINT");
    const restrictedBridge: ExecutionProbe = { ...localProbe, relayFork: "EPERM", classification: "RESTRICTED_BRIDGE_CONTEXT" };
    expect(planRecovery(facts({ bridgeProbe: restrictedBridge, localProbe: deniedProbe })).nextAction).toBe("RETRY_CAPABLE_CONTEXT");
    expect(planRecovery(facts({ bridgeProbe: restrictedBridge, localProbe: deniedProbe, capableContextAttempted: true })).state).toBe("BLOCKED_LOCAL_EXECUTION");
  });

  it("compares unchanged and changed Connector endpoints deterministically", () => {
    const same = compareRecoveryEndpoint({
      currentMcpUrl: "https://a.trycloudflare.com/mcp/",
      confirmedMcpUrl: "https://A.trycloudflare.com/mcp",
      connectorName: "connector",
      savedChatUrl: session.url,
    });
    expect(same).toBe("CONNECTOR_STILL_VALID");
    expect(planRecovery(facts({ phase: "ENDPOINT_COMPARE" })).nextAction).toBe("POST_RECOVERY_VERIFY");

    const changed = planRecovery(facts({
      phase: "ENDPOINT_COMPARE",
      doctor: { ...healthyDoctor, chatgptRepair: { ...healthyDoctor.chatgptRepair, needed: true, mcpUrl: "https://new.trycloudflare.com/mcp", previousMcpUrl: "https://old.trycloudflare.com/mcp" } },
    }));
    expect(changed.state).toBe("HUMAN_MCP_APP_GATE");
    expect(changed.humanActionRequired).toBe(true);
  });

  it("blocks endpoint state when doctor and saved-session Connector names disagree", () => {
    const mismatched = {
      ...healthyDoctor,
      chatgptRepair: { ...healthyDoctor.chatgptRepair, connectorName: "different Connector" },
    };
    const result = planRecovery(facts({ doctor: mismatched, phase: "ENDPOINT_COMPARE" }));
    expect(result.state).toBe("BLOCKED_STATE_INCONSISTENT");
    expect(result.humanActionRequired).toBe(false);
  });

  it("opens the human gate only after the local endpoint is healthy", () => {
    const failedDoctor = { ...healthyDoctor, report: { ...healthyDoctor.report, tunnel: { ok: false } }, chatgptRepair: { ...healthyDoctor.chatgptRepair, needed: true, mcpUrl: "https://new.trycloudflare.com/mcp", previousMcpUrl: "https://old.trycloudflare.com/mcp" } };
    const result = planRecovery(facts({ doctor: failedDoctor, bridgeStatus: "healthy" }));
    expect(result.nextAction).toBe("START_TUNNEL");
    expect(result.humanActionRequired).toBe(false);
  });

  it("enforces the complete pairing transition sequence", () => {
    const gateDoctor = { ...healthyDoctor, chatgptRepair: { ...healthyDoctor.chatgptRepair, needed: true, mcpUrl: "https://new.trycloudflare.com/mcp", previousMcpUrl: "https://old.trycloudflare.com/mcp" } };
    const health = planRecovery(facts({ doctor: gateDoctor }));
    expect(health.state).toBe("LOCAL_HEALTH_PASS");
    expect(health.nextAction).toBe("COMPARE_ENDPOINT");
    const gate = planRecovery(facts({ phase: "ENDPOINT_COMPARE", doctor: gateDoctor }));
    expect(gate.state).toBe("HUMAN_MCP_APP_GATE");
    const pageOpened = planRecovery(facts({ doctor: gateDoctor, recoveryState: gate.state, transitionEvent: "PAIRING_PAGE_OPENED" }));
    expect(pageOpened.state).toBe("WAIT_PAIR_CODE_GENERATION");
    const generation = planRecovery(facts({ doctor: gateDoctor, recoveryState: pageOpened.state, transitionEvent: "PAIR_CODE_GENERATION_REQUESTED" }));
    expect(generation.state).toBe("GENERATING_PAIR_CODE");
    const codeGenerated = planRecovery(facts({ doctor: gateDoctor, recoveryState: generation.state, transitionEvent: "PAIR_CODE_GENERATED" }));
    expect(codeGenerated.state).toBe("WAIT_PAIRING_COMPLETE");
    const pairingCompleted = planRecovery(facts({ doctor: gateDoctor, recoveryState: codeGenerated.state, transitionEvent: "PAIRING_COMPLETED", actualConnectorName: "MOZI v4" }));
    expect(pairingCompleted.state).toBe("AI_CONFIRM_CONNECTOR");
    expect(planRecovery(facts({ doctor: gateDoctor, recoveryState: "LOCAL_HEALTH_PASS", transitionEvent: "PAIRING_COMPLETED", actualConnectorName: "MOZI v4" })).state).toBe("INVALID_RECOVERY_TRANSITION");
    expect(planRecovery(facts({ doctor: gateDoctor, recoveryState: gate.state, transitionEvent: "PAIR_CODE_GENERATED" })).state).toBe("INVALID_RECOVERY_TRANSITION");
    expect(planRecovery(facts({ doctor: gateDoctor, recoveryState: pageOpened.state, transitionEvent: "PAIRING_PAGE_OPENED" })).state).toBe("INVALID_RECOVERY_TRANSITION");
    expect(planRecovery(facts({ doctor: gateDoctor, recoveryState: "WAIT_PAIRING_COMPLETE", transitionEvent: "PAIR_CODE_GENERATED" })).state).toBe("INVALID_RECOVERY_TRANSITION");
    const confirmedDoctor = { ...healthyDoctor, chatgptRepair: { needed: false, mcpUrl: "https://fresh.trycloudflare.com/mcp", previousMcpUrl: "https://fresh.trycloudflare.com/mcp" } };
    const confirmRequested = planRecovery(facts({ doctor: gateDoctor, recoveryState: pairingCompleted.state, transitionEvent: "CONNECTOR_CONFIRM_REQUESTED", requestedMcpUrl: "https://new.trycloudflare.com/mcp" }));
    expect(confirmRequested.state).toBe("CONFIRMING_CONNECTOR");
    expect(planRecovery(facts({ doctor: gateDoctor, recoveryState: pairingCompleted.state, transitionEvent: "CONNECTOR_CONFIRM_REQUESTED", requestedMcpUrl: "https://wrong.trycloudflare.com/mcp" })).state).toBe("INVALID_RECOVERY_TRANSITION");
    const confirmed = planRecovery(facts({ doctor: confirmedDoctor, recoveryState: confirmRequested.state, transitionEvent: "CONNECTOR_CONFIRMED", connectorConfirmed: true }));
    expect(confirmed.state).toBe("POST_RECOVERY_VERIFY");
    expect(planRecovery(facts({ recoveryState: "LOCAL_RECOVERY", transitionEvent: "SESSION_PRESERVATION_FAILED" })).state).toBe("BLOCKED_STATE_INCONSISTENT");

    const afterPair = { ...session, connectorName: "MOZI v4" };
    const completeDoctor = { ...healthyDoctor, chatgptRepair: { needed: false, mcpUrl: "https://fresh.trycloudflare.com/mcp", previousMcpUrl: "https://fresh.trycloudflare.com/mcp" } };
    const completed = planRecovery(facts({
      phase: "POST_RECOVERY_VERIFY",
      recoveryState: confirmed.state,
      sessionAfter: afterPair,
      actualConnectorName: "MOZI v4",
      connectorConfirmed: true,
      workspaceInfo: { workspaceName: "MOZI", workspaceId: "workspace-123" },
      savedChatUrlAfter: session.url,
      checkRoundTrip: { checkId: "c1", replyCheckId: "c1", workspaceName: "MOZI", workspaceId: "workspace-123" },
      doctor: completeDoctor,
    }));
    expect(completed.nextAction).toBe("COMPLETE");
  });

  it("stores recovery progress separately from C2C session metadata", () => {
    const stateDir = isolateStateDir();
    tempDirs.push(stateDir);
    writeRecoveryProgress("workspace-123", { state: "WAIT_PAIR_CODE_GENERATION", capableContextAttempted: true, bridgeRestartAttempted: false });
    expect(readRecoveryProgress("workspace-123")).toEqual({ state: "WAIT_PAIR_CODE_GENERATION", capableContextAttempted: true, bridgeRestartAttempted: false });
    expect(recoveryProgressFile("workspace-123")).toContain("recovery-progress");
  });

  it("handles reboot recovery without replacing preserved session metadata", () => {
    const boot = planRecovery(facts({ bridgeStatus: "stopped", doctor: undefined, localProbe }));
    expect(boot.nextAction).toBe("START_BRIDGE_AND_TUNNEL");
    const blockedInStandard = planRecovery(facts({
      bridgeStatus: "stopped",
      doctor: undefined,
      localProbe: {
        nodeChildSpawn: "EPERM",
        cloudflaredSpawn: "EPERM",
        relayFork: "EPERM",
        classification: "RESTRICTED_EXECUTION_CONTEXT",
      },
      localActionResult: { ok: false, errorCode: "EPERM" },
    }));
    expect(blockedInStandard.nextAction).toBe("RETRY_CAPABLE_CONTEXT");
    const endpointChanged = planRecovery(facts({
      phase: "ENDPOINT_COMPARE",
      doctor: { ...healthyDoctor, chatgptRepair: { ...healthyDoctor.chatgptRepair, needed: true, mcpUrl: "https://fresh.trycloudflare.com/mcp", previousMcpUrl: "https://old.trycloudflare.com/mcp" } },
    }));
    expect(endpointChanged.state).toBe("HUMAN_MCP_APP_GATE");
    expect(sessionSnapshotPreserved(session, { ...session })).toBe(true);
  });
});

describe("Bridge-local recovery probe", () => {
  it("returns fixture capability facts only through the authenticated loopback admin route", async () => {
    const stateDir = isolateStateDir();
    tempDirs.push(stateDir);
    const root = makeTmpDir("recovery-probe-bridge");
    tempDirs.push(root);
    write(root, "README.md", "fixture workspace\n");
    const authFile = path.join(root, "auth", "store.json");
    const expected: ExecutionProbe = {
      nodeChildSpawn: "PASS",
      cloudflaredSpawn: "PASS",
      relayFork: "EPERM",
      classification: "RESTRICTED_BRIDGE_CONTEXT",
    };
    const tunnel: TunnelProvider = {
      name: "fixture",
      async start() { return "https://fixture.invalid"; },
      async stop() {},
      async restart() { return "https://fixture.invalid"; },
      status() { return { running: false, url: null, provider: "fixture" }; },
      getPublicUrl() { return null; },
      async doctor() { return { provider: "fixture", binaryFound: true, binaryPath: "fixture-cloudflared", running: false, url: null, problems: [] }; },
    };
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      authStoreFile: authFile,
      tunnelProvider: tunnel,
      recoveryProbe: async () => expected,
    });
    try {
      const response = await fetch(`${bridge.localBaseUrl()}/admin/recovery-probe`, {
        headers: { authorization: `Bearer ${bridge.adminToken}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, context: "bridge", probe: expected });
    } finally {
      await bridge.close();
    }
  });
});

describe("no user-shell fallback policy", () => {
  it("contains no imperative recovery request for a person to run local commands", () => {
    const files = [path.join(skillRoot, "SKILL.md"), ...fs.readdirSync(path.join(skillRoot, "scripts")).map((name) => path.join(skillRoot, "scripts", name))];
    const forbidden = /(?:请|please)\s*(?:打开|在|运行|执行|复制|open|run)\s*.{0,40}(?:CMD|PowerShell|shell|terminal|命令|command)/i;
    for (const file of files) expect(fs.readFileSync(file, "utf8"), path.basename(file)).not.toMatch(forbidden);
  });
});
