import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const fixturePath = process.env.C2C_TEST_RECOVERY_FIXTURE;
if (!fixturePath) process.exit(90);
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const args = process.argv.slice(2);
fixture.calls.push(args);
const persist = () => fs.writeFileSync(fixturePath, JSON.stringify(fixture));
const emit = (value) => process.stdout.write(JSON.stringify(value));
const command = args[0];

if (command === "control-target" && args[1] === "resolve") {
  const targetWorkspaceRoot = fs.realpathSync(path.resolve(process.env.C2C_PROFILE_RESOLVE_WORKSPACE));
  const normalizedRoot = process.platform === "win32" || process.platform === "darwin" ? targetWorkspaceRoot.toLowerCase() : targetWorkspaceRoot;
  emit({
    ok: true,
    profile: {
      profileId: args[args.indexOf("--profile") + 1],
      targetWorkspaceRoot,
      targetStateDir: process.env.C2C_PROFILE_RESOLVE_STATE || process.env.C2C_STATE_DIR,
      workspaceId: createHash("sha256").update(normalizedRoot).digest("hex").slice(0, 12),
    },
  });
}
else if (command === "session" && args[1] !== "set") emit({ session: fixture.session });
else if (command === "workspace") emit({ workspaceId: process.env.C2C_RECOVERY_WORKSPACE_ID || "fixture-workspace", name: "Fixture Workspace" });
else if (command === "status") emit({ ok: true, running: true });
else if (command === "doctor") emit(fixture.doctor);
else if (command === "recovery-probe") emit(fixture.probe);
else if (command === "recovery-replace-legacy-bridge") {
  fixture.migrationCalls = ["stop", "start", "reprobe"];
  if (fixture.mutateFieldOnMigration) fixture.session[fixture.mutateFieldOnMigration] = fixture.mutatedValue;
  if (fixture.probeAfterMigration) fixture.probe = fixture.probeAfterMigration;
  if (fixture.progressPath && fs.existsSync(fixture.progressPath)) {
    const progress = JSON.parse(fs.readFileSync(fixture.progressPath, "utf8"));
    progress.state = "LOCAL_RECOVERY";
    progress.legacyMigrationAuthorized = false;
    progress.legacyMigrationAttempted = true;
    fs.writeFileSync(fixture.progressPath, JSON.stringify(progress));
  }
  persist();
  emit({ ok: true, state: "LOCAL_RECOVERY", bridgeStopped: true, bridgeStarted: true, reprobeSucceeded: true, sessionPreserved: true });
}
else if (command === "recovery-plan") {
  if (fixture.useRealPlanner) {
    persist();
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const planner = spawnSync(process.execPath, ["--import", "tsx", path.join(repoRoot, "src", "cli", "index.ts"), ...args], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true, env: process.env,
    });
    if (planner.stdout) fs.writeSync(1, planner.stdout);
    if (planner.stderr) fs.writeSync(2, planner.stderr);
    process.exit(planner.status ?? 1);
  }
  const encoded = args[args.indexOf("--facts-base64") + 1];
  const facts = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  const transitions = {
    PAIRING_PAGE_OPENED: ["HUMAN_MCP_APP_GATE", "WAIT_PAIR_CODE_GENERATION", "AI_GENERATE_PAIR_CODE"],
    PAIR_CODE_GENERATION_REQUESTED: ["WAIT_PAIR_CODE_GENERATION", "GENERATING_PAIR_CODE", "AI_GENERATE_PAIR_CODE"],
    PAIR_CODE_GENERATED: ["GENERATING_PAIR_CODE", "WAIT_PAIRING_COMPLETE", "WAIT_PAIRING_COMPLETE"],
    PAIR_CODE_GENERATION_FAILED: ["GENERATING_PAIR_CODE", "LOCAL_RECOVERY_FAILED", "LOCAL_RECOVERY_FAILED"],
    PAIRING_COMPLETED: ["WAIT_PAIRING_COMPLETE", "AI_CONFIRM_CONNECTOR", "AI_CONFIRM_CONNECTOR"],
    CONNECTOR_CONFIRM_REQUESTED: ["AI_CONFIRM_CONNECTOR", "CONFIRMING_CONNECTOR", "AI_CONFIRM_CONNECTOR"],
    CONNECTOR_CONFIRMED: ["CONFIRMING_CONNECTOR", "POST_RECOVERY_VERIFY", "POST_RECOVERY_VERIFY"],
    CONNECTOR_CONFIRMATION_FAILED: ["CONFIRMING_CONNECTOR", "LOCAL_RECOVERY_FAILED", "LOCAL_RECOVERY_FAILED"],
  };
  if (facts.transitionEvent) {
    const transition = transitions[facts.transitionEvent];
    const wrongEndpoint = facts.transitionEvent === "CONNECTOR_CONFIRM_REQUESTED" && facts.requestedMcpUrl !== facts.doctor?.chatgptRepair?.mcpUrl;
    if (!transition || wrongEndpoint || facts.recoveryState !== transition[0] || fixture.currentRecoveryState !== transition[0]) {
      emit({ ok: false, state: "INVALID_RECOVERY_TRANSITION", nextAction: "INVALID_RECOVERY_TRANSITION", facts: {} });
    } else {
      fixture.currentRecoveryState = transition[1];
      persist();
      emit({ ok: true, state: transition[1], nextAction: transition[2], facts: {} });
    }
  } else if (facts.phase === "POST_RECOVERY_VERIFY") {
    const complete = facts.connectorConfirmed === true &&
      facts.workspaceInfo?.workspaceName === facts.workspace?.name &&
      facts.workspaceInfo?.workspaceId === facts.workspace?.workspaceId &&
      facts.savedChatUrlAfter === facts.session?.url &&
      facts.checkRoundTrip?.checkId === facts.checkRoundTrip?.replyCheckId &&
      facts.checkRoundTrip?.workspaceName === facts.workspace?.name &&
      facts.checkRoundTrip?.workspaceId === facts.workspace?.workspaceId &&
      facts.sessionAfter?.url === facts.session?.url;
    emit({ ok: complete, state: complete ? "COMPLETE" : "POST_RECOVERY_VERIFY", nextAction: complete ? "COMPLETE" : "POST_RECOVERY_VERIFY", facts: {} });
  } else if (facts.localActionResult?.errorCode === "EPERM") {
    emit({ ok: false, state: "BLOCKED_LOCAL_EXECUTION", nextAction: "BLOCKED_LOCAL_EXECUTION", facts: {} });
  } else {
    const nextAction = fixture.restartInvoked ? "COMPARE_ENDPOINT" : fixture.planAction;
    emit({ ok: nextAction === "COMPARE_ENDPOINT", state: nextAction, nextAction, humanActionRequired: false, facts: {} });
  }
}
else if (command === "restart" || command === "start") {
  fixture.restartInvoked = true;
  persist();
  if (fixture.restartFailure) {
    process.stderr.write("EPERM fixture restart failure");
    process.exit(1);
  }
  if (fixture.mutateField) fixture.session[fixture.mutateField] = fixture.mutatedValue;
  persist();
  emit({ ok: true, mcpUrl: "https://fixture.invalid/mcp" });
}
else if (command === "pair") emit(fixture.pairFailure
  ? { ok: false, pairingCode: null, expiresAt: null }
  : { ok: true, pairingCode: "fixture-code", expiresAt: Date.now() + 60_000 });
else if (command === "session" && args[1] === "set") {
  const index = args.indexOf("--connector-name");
  if (index >= 0) fixture.session.connectorName = args[index + 1];
  if (fixture.mutateFieldOnSessionSet) fixture.session[fixture.mutateFieldOnSessionSet] = fixture.mutatedValue;
  persist();
  emit({ ok: true });
}
else if (command === "connector-confirm") {
  fixture.doctor.chatgptRepair.needed = false;
  fixture.doctor.chatgptRepair.previousMcpUrl = fixture.doctor.chatgptRepair.mcpUrl;
  fixture.doctor.chatgptRepair.connectorName = fixture.session.connectorName;
  persist();
  emit({ ok: true, mcpUrl: "https://fixture.invalid/mcp" });
}
else {
  process.stderr.write(`unexpected fixture command: ${command}`);
  process.exit(91);
}
persist();
