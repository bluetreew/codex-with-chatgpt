import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getStateDir, writeSecureJson } from "../config/paths.js";
import type { RecoveryState } from "./harness.js";
import type { RecoverySessionSnapshot } from "./harness.js";

const knownStates: readonly RecoveryState[] = [
  "LOCAL_DIAGNOSIS", "LOCAL_RECOVERY", "LEGACY_BRIDGE_PROBE_UNSUPPORTED", "LOCAL_HEALTH_PASS", "ENDPOINT_COMPARE",
  "HUMAN_MCP_APP_GATE", "WAIT_PAIRING_PAGE", "WAIT_PAIR_CODE_GENERATION", "GENERATING_PAIR_CODE",
  "AI_GENERATE_PAIR_CODE", "WAIT_PAIRING_COMPLETE", "AI_CONFIRM_CONNECTOR", "CONFIRMING_CONNECTOR",
  "POST_RECOVERY_VERIFY", "COMPLETE", "BLOCKED_LOCAL_EXECUTION", "BLOCKED_STATE_INCONSISTENT",
  "BLOCKED_BRIDGE_UNKNOWN", "LOCAL_RECOVERY_FAILED", "UNAPPROVED_CLOUDFLARED_PATH", "INVALID_RECOVERY_TRANSITION",
];

export interface RecoveryProgress {
  runId?: string;
  state: RecoveryState;
  capableContextAttempted: boolean;
  bridgeRestartAttempted: boolean;
  legacyMigrationAuthorized?: boolean;
  legacyMigrationAttempted?: boolean;
  legacyMigrationResumedFrom?: "BLOCKED_BRIDGE_UNKNOWN";
  legacyMigrationEvidence?: { adminInfoStatus: 200; recoveryProbeStatus: 404; tunnelHealth: "UNHEALTHY" };
  sessionSnapshot?: RecoverySessionSnapshot | null;
  pairedConnectorName?: string;
}

export type LegacyBridgeReplacementMarkerResult = "CONSUMED" | "ALREADY_CONSUMED" | "FAILED";

const safeRunId = /^[A-Za-z0-9_-]{1,128}$/;

export function createRecoveryRunId(): string {
  return crypto.randomUUID();
}

export function recoveryProgressFile(workspaceId: string): string {
  const safeId = encodeURIComponent(workspaceId).replaceAll("%", "_");
  return path.join(getStateDir(), "recovery-progress", `${safeId}.json`);
}

export function readRecoveryProgress(workspaceId: string): RecoveryProgress | null {
  const file = recoveryProgressFile(workspaceId);
  let raw: string;
  let value: Partial<RecoveryProgress>;
  try {
    raw = fs.readFileSync(file, "utf8");
    value = JSON.parse(raw) as Partial<RecoveryProgress>;
  } catch {
    return null;
  }
  if (!value || !knownStates.includes(value.state as RecoveryState) || typeof value.capableContextAttempted !== "boolean") return null;
  if (value.runId !== undefined && (typeof value.runId !== "string" || !safeRunId.test(value.runId))) return null;
  const runId = value.runId ?? `legacy-${crypto.createHash("sha256").update(`${workspaceId}\0${raw}`).digest("hex")}`;
  return {
    runId,
    state: value.state as RecoveryState,
    capableContextAttempted: value.capableContextAttempted,
    bridgeRestartAttempted: value.bridgeRestartAttempted === true,
    ...(typeof value.legacyMigrationAuthorized === "boolean" ? { legacyMigrationAuthorized: value.legacyMigrationAuthorized } : {}),
    ...(typeof value.legacyMigrationAttempted === "boolean" ? { legacyMigrationAttempted: value.legacyMigrationAttempted } : {}),
    ...(value.legacyMigrationResumedFrom === "BLOCKED_BRIDGE_UNKNOWN" ? { legacyMigrationResumedFrom: value.legacyMigrationResumedFrom } : {}),
    ...(value.legacyMigrationEvidence?.adminInfoStatus === 200 && value.legacyMigrationEvidence.recoveryProbeStatus === 404 && value.legacyMigrationEvidence.tunnelHealth === "UNHEALTHY"
      ? { legacyMigrationEvidence: value.legacyMigrationEvidence }
      : {}),
    ...(value.sessionSnapshot && typeof value.sessionSnapshot === "object" ? { sessionSnapshot: value.sessionSnapshot as RecoverySessionSnapshot } : {}),
    ...(typeof value.pairedConnectorName === "string" ? { pairedConnectorName: value.pairedConnectorName } : {}),
  };
}

export function writeRecoveryProgress(workspaceId: string, progress: RecoveryProgress): void {
  const runId = progress.runId ?? createRecoveryRunId();
  if (!safeRunId.test(runId)) throw new Error("RECOVERY_RUN_ID_INVALID");
  writeSecureJson(recoveryProgressFile(workspaceId), { ...progress, runId });
}

function legacyBridgeReplacementMarkerPath(workspaceId: string, progress: RecoveryProgress): string {
  if (!progress.runId || !safeRunId.test(progress.runId)) throw new Error("RECOVERY_RUN_ID_INVALID");
  const stateDir = path.resolve(getStateDir());
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const canonicalStateDir = fs.realpathSync(stateDir);
  const safeWorkspaceId = encodeURIComponent(workspaceId).replaceAll("%", "_");
  return path.join(canonicalStateDir, "recovery-progress", safeWorkspaceId, "runs", progress.runId, "legacy-bridge-replacement-consumed");
}

export function legacyBridgeReplacementMarkerConsumed(workspaceId: string, progress: RecoveryProgress): boolean {
  const marker = legacyBridgeReplacementMarkerPath(workspaceId, progress);
  try {
    fs.accessSync(marker);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Atomically consume the sole replacement entitlement for this persisted recovery run. */
export function consumeLegacyBridgeReplacementMarker(
  workspaceId: string,
  progress: RecoveryProgress,
): LegacyBridgeReplacementMarkerResult {
  let descriptor: number;
  let marker: string;
  try {
    marker = legacyBridgeReplacementMarkerPath(workspaceId, progress);
    fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
    descriptor = fs.openSync(marker, "wx", 0o600);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EEXIST" ? "ALREADY_CONSUMED" : "FAILED";
  }
  try {
    fs.writeSync(descriptor, JSON.stringify({ schemaVersion: 1, workspaceId, runId: progress.runId }));
    fs.fsyncSync(descriptor);
    return "CONSUMED";
  } catch {
    // The exclusive-create file remains authoritative even if recording its contents fails.
    return "FAILED";
  } finally {
    try { fs.closeSync(descriptor); } catch { /* retain the one-way marker */ }
  }
}
