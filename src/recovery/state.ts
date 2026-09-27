import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import type { RecoveryState } from "./harness.js";
import type { RecoverySessionSnapshot } from "./harness.js";

const knownStates: readonly RecoveryState[] = [
  "LOCAL_DIAGNOSIS", "LOCAL_RECOVERY", "LOCAL_HEALTH_PASS", "ENDPOINT_COMPARE",
  "HUMAN_MCP_APP_GATE", "WAIT_PAIRING_PAGE", "WAIT_PAIR_CODE_GENERATION", "GENERATING_PAIR_CODE",
  "AI_GENERATE_PAIR_CODE", "WAIT_PAIRING_COMPLETE", "AI_CONFIRM_CONNECTOR", "CONFIRMING_CONNECTOR",
  "POST_RECOVERY_VERIFY", "COMPLETE", "BLOCKED_LOCAL_EXECUTION", "BLOCKED_STATE_INCONSISTENT",
  "BLOCKED_BRIDGE_UNKNOWN", "LOCAL_RECOVERY_FAILED", "UNAPPROVED_CLOUDFLARED_PATH", "INVALID_RECOVERY_TRANSITION",
];

export interface RecoveryProgress {
  state: RecoveryState;
  capableContextAttempted: boolean;
  bridgeRestartAttempted: boolean;
  sessionSnapshot?: RecoverySessionSnapshot | null;
  pairedConnectorName?: string;
}

export function recoveryProgressFile(workspaceId: string): string {
  const safeId = encodeURIComponent(workspaceId).replaceAll("%", "_");
  return path.join(getStateDir(), "recovery-progress", `${safeId}.json`);
}

export function readRecoveryProgress(workspaceId: string): RecoveryProgress | null {
  const value = readJsonIfExists<Partial<RecoveryProgress>>(recoveryProgressFile(workspaceId));
  if (!value || !knownStates.includes(value.state as RecoveryState) || typeof value.capableContextAttempted !== "boolean") return null;
  return {
    state: value.state as RecoveryState,
    capableContextAttempted: value.capableContextAttempted,
    bridgeRestartAttempted: value.bridgeRestartAttempted === true,
    ...(value.sessionSnapshot && typeof value.sessionSnapshot === "object" ? { sessionSnapshot: value.sessionSnapshot as RecoverySessionSnapshot } : {}),
    ...(typeof value.pairedConnectorName === "string" ? { pairedConnectorName: value.pairedConnectorName } : {}),
  };
}

export function writeRecoveryProgress(workspaceId: string, progress: RecoveryProgress): void {
  writeSecureJson(recoveryProgressFile(workspaceId), progress);
}
