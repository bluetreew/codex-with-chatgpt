import type { RecoveryFacts, RecoverySessionSnapshot } from "./harness.js";
import type { BridgeProbeObservation } from "./probe.js";

export type LegacyMigrationBlockedState = "BLOCKED_LOCAL_EXECUTION" | "BLOCKED_STATE_INCONSISTENT" | "BLOCKED_BRIDGE_UNKNOWN";

export interface LegacyMigrationProgress {
  state: string;
  capableContextAttempted: boolean;
  bridgeRestartAttempted: boolean;
  legacyMigrationAuthorized?: boolean;
  legacyMigrationAttempted?: boolean;
  sessionSnapshot?: RecoverySessionSnapshot | null;
  pairedConnectorName?: string;
  legacyMigrationResumedFrom?: "BLOCKED_BRIDGE_UNKNOWN";
  legacyMigrationEvidence?: { adminInfoStatus: 200; recoveryProbeStatus: 404; tunnelHealth: "UNHEALTHY" };
}

export type LegacyMigrationEligibility =
  | { eligible: true }
  | { eligible: false; state: LegacyMigrationBlockedState; reason: string };

function sameProtectedSession(before: RecoverySessionSnapshot, after: RecoverySessionSnapshot): boolean {
  const fields: Array<keyof RecoverySessionSnapshot> = [
    "url", "projectUrl", "workflowMode", "checkpoint", "connectorName", "taskId", "iteration", "lastState",
  ];
  return JSON.stringify(fields.map((field) => before[field])) === JSON.stringify(fields.map((field) => after[field]));
}

export function hasVerifiedLegacyBridgeEvidence(facts: RecoveryFacts): boolean {
  return facts.bridgeStatus === "healthy" &&
    facts.bridgeInfoHealthy === true &&
    facts.bridgeInfoStatus === 200 &&
    facts.bridgeInfoErrorKind === null &&
    facts.bridgeProbeStatus === 404 &&
    facts.bridgeProbeErrorKind === "ROUTE_NOT_FOUND" &&
    facts.localRecoveryRuntimeSupportsProbe === true;
}

export function resumeBlockedBridgeUnknownAsLegacy<T extends LegacyMigrationProgress>(
  progress: T,
  facts: RecoveryFacts,
): T | null {
  if (progress.state !== "BLOCKED_BRIDGE_UNKNOWN" || progress.bridgeRestartAttempted || progress.legacyMigrationAttempted === true ||
      progress.legacyMigrationAuthorized === true ||
      facts.bridgeInfoTunnelHealth !== "UNHEALTHY" || !progress.sessionSnapshot || !facts.session ||
      !sameProtectedSession(progress.sessionSnapshot, facts.session)) return null;
  if (!legacyMigrationEligibility({ ...facts, recoverySessionSnapshot: progress.sessionSnapshot }).eligible) return null;
  return {
    ...progress,
    state: "LEGACY_BRIDGE_PROBE_UNSUPPORTED",
    legacyMigrationResumedFrom: "BLOCKED_BRIDGE_UNKNOWN",
    legacyMigrationEvidence: { adminInfoStatus: 200, recoveryProbeStatus: 404, tunnelHealth: "UNHEALTHY" },
  };
}

export function legacyMigrationEligibility(facts: RecoveryFacts): LegacyMigrationEligibility {
  if (!hasVerifiedLegacyBridgeEvidence(facts)) {
    return { eligible: false, state: "BLOCKED_BRIDGE_UNKNOWN", reason: "authenticated legacy-probe evidence is incomplete" };
  }
  if (facts.localProbe?.classification !== "CAPABLE") {
    return { eligible: false, state: "BLOCKED_LOCAL_EXECUTION", reason: "legacy Bridge replacement requires confirmed local process capability" };
  }
  if (facts.bridgeInfoTunnelHealth !== "UNHEALTHY") {
    return { eligible: false, state: "BLOCKED_BRIDGE_UNKNOWN", reason: `Tunnel health is ${facts.bridgeInfoTunnelHealth ?? "UNKNOWN"}; replacement requires explicit Tunnel-down evidence` };
  }
  // The planner atomically consumes bridgeRestartAttempted when it authorizes this one migration.
  // Require the companion authorization flag until the CLI consumes legacyMigrationAttempted.
  if ((facts.bridgeRestartAttempted && facts.legacyMigrationAuthorized !== true) || facts.legacyMigrationAttempted === true) {
    return { eligible: false, state: "BLOCKED_LOCAL_EXECUTION", reason: "the one permitted legacy Bridge replacement was already attempted or is not explicitly authorized" };
  }
  if (!facts.recoverySessionSnapshot || !facts.session || !sameProtectedSession(facts.recoverySessionSnapshot, facts.session)) {
    return { eligible: false, state: "BLOCKED_STATE_INCONSISTENT", reason: "a valid unchanged protected session snapshot is required before replacement" };
  }
  return { eligible: true };
}

export interface LegacyBridgeMigrationAdapter {
  consumeReplacementAttempt(): Promise<"CONSUMED" | "ALREADY_CONSUMED" | "PROGRESS_WRITE_FAILED" | "FAILED">;
  stopCurrentBridge(): Promise<boolean>;
  startCurrentBridge(): Promise<{ pid: number } | null>;
  reprobeCurrentBridge(): Promise<{
    bridgeStatus: "healthy" | "stopped" | "unknown";
    pid?: number;
    observation: BridgeProbeObservation;
  }>;
  readSession(): Promise<RecoverySessionSnapshot | null>;
}

export interface LegacyBridgeMigrationResult {
  ok: boolean;
  state: LegacyMigrationBlockedState | "LOCAL_RECOVERY";
  reason?: string;
  bridgeStopped: boolean;
  bridgeStarted: boolean;
  reprobeSucceeded: boolean;
  sessionPreserved: boolean;
  newPid?: number;
}

function blocked(
  state: LegacyMigrationBlockedState,
  reason: string,
  flags: Pick<LegacyBridgeMigrationResult, "bridgeStopped" | "bridgeStarted" | "reprobeSucceeded" | "sessionPreserved"> = {
    bridgeStopped: false, bridgeStarted: false, reprobeSucceeded: false, sessionPreserved: true,
  }
): LegacyBridgeMigrationResult {
  return { ok: false, state, reason, ...flags };
}

export async function replaceLegacyBridgeOnce(
  facts: RecoveryFacts,
  authorization: { authorized: boolean; alreadyAttempted: boolean },
  currentPid: number,
  adapter: LegacyBridgeMigrationAdapter
): Promise<LegacyBridgeMigrationResult> {
  if (!authorization.authorized || authorization.alreadyAttempted || !facts.bridgeRestartAttempted ||
      facts.legacyMigrationAuthorized !== true || facts.legacyMigrationAttempted === true) {
    return blocked("BLOCKED_LOCAL_EXECUTION", "legacy Bridge replacement is not authorized or was already attempted");
  }
  const eligibility = legacyMigrationEligibility(facts);
  if (!eligibility.eligible) return blocked(eligibility.state, eligibility.reason);

  const before = await adapter.readSession();
  if (!before || !facts.recoverySessionSnapshot || !sameProtectedSession(facts.recoverySessionSnapshot, before)) {
    return blocked("BLOCKED_STATE_INCONSISTENT", "protected session changed before legacy Bridge replacement", { bridgeStopped: false, bridgeStarted: false, reprobeSucceeded: false, sessionPreserved: false });
  }
  let replacementAttempt: Awaited<ReturnType<LegacyBridgeMigrationAdapter["consumeReplacementAttempt"]>>;
  try {
    replacementAttempt = await adapter.consumeReplacementAttempt();
  } catch {
    replacementAttempt = "FAILED";
  }
  if (replacementAttempt !== "CONSUMED") {
    const reason = replacementAttempt === "ALREADY_CONSUMED"
      ? "the replacement marker for this recovery run was already consumed"
      : replacementAttempt === "PROGRESS_WRITE_FAILED"
        ? "replacement marker was consumed but attempt progress could not be persisted"
        : "the replacement marker could not be atomically consumed";
    return blocked("BLOCKED_LOCAL_EXECUTION", reason, { bridgeStopped: false, bridgeStarted: false, reprobeSucceeded: false, sessionPreserved: true });
  }
  if (!await adapter.stopCurrentBridge()) {
    return blocked("BLOCKED_LOCAL_EXECUTION", "the verified legacy Bridge could not be stopped", { bridgeStopped: false, bridgeStarted: false, reprobeSucceeded: false, sessionPreserved: true });
  }

  let started: { pid: number } | null;
  try {
    started = await adapter.startCurrentBridge();
  } catch (error) {
    return blocked("BLOCKED_LOCAL_EXECUTION", error instanceof Error ? error.message : "current Bridge startup failed", { bridgeStopped: true, bridgeStarted: false, reprobeSucceeded: false, sessionPreserved: true });
  }
  if (!started || started.pid === currentPid) {
    return blocked("BLOCKED_LOCAL_EXECUTION", "a distinct current Bridge process did not start", { bridgeStopped: true, bridgeStarted: Boolean(started), reprobeSucceeded: false, sessionPreserved: true });
  }

  let reprobe: Awaited<ReturnType<LegacyBridgeMigrationAdapter["reprobeCurrentBridge"]>>;
  try {
    reprobe = await adapter.reprobeCurrentBridge();
  } catch (error) {
    return blocked("BLOCKED_LOCAL_EXECUTION", error instanceof Error ? error.message : "new Bridge reprobe failed", { bridgeStopped: true, bridgeStarted: true, reprobeSucceeded: false, sessionPreserved: true });
  }
  const after = await adapter.readSession();
  const sessionPreserved = Boolean(after && sameProtectedSession(before, after));
  const probeValid = reprobe.bridgeStatus === "healthy" &&
    reprobe.pid === started.pid &&
    reprobe.observation.bridgeInfoHealthy &&
    reprobe.observation.bridgeInfoStatus === 200 &&
    reprobe.observation.bridgeInfoErrorKind === null &&
    reprobe.observation.bridgeProbeStatus === 200 &&
    reprobe.observation.bridgeProbeErrorKind === null &&
    reprobe.observation.bridgeProbe?.classification === "CAPABLE" &&
    reprobe.observation.bridgeProbe.nodeChildSpawn === "PASS" &&
    reprobe.observation.bridgeProbe.cloudflaredSpawn === "PASS" &&
    reprobe.observation.bridgeProbe.relayFork === "PASS";
  if (!sessionPreserved) {
    return blocked("BLOCKED_STATE_INCONSISTENT", "protected session changed during legacy Bridge replacement", { bridgeStopped: true, bridgeStarted: true, reprobeSucceeded: probeValid, sessionPreserved: false });
  }
  if (!probeValid) {
    return blocked("BLOCKED_LOCAL_EXECUTION", "replacement Bridge did not return a valid structured recovery probe", { bridgeStopped: true, bridgeStarted: true, reprobeSucceeded: false, sessionPreserved: true });
  }
  return { ok: true, state: "LOCAL_RECOVERY", bridgeStopped: true, bridgeStarted: true, reprobeSucceeded: true, sessionPreserved: true, newPid: started.pid };
}
