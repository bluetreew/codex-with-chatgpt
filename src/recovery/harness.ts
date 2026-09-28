import { hasVerifiedLegacyBridgeEvidence, legacyMigrationEligibility } from "./legacy-migration.js";

export type ProbeStatus = "PASS" | "EPERM" | "FAIL" | "NOT_CONFIGURED" | "UNAPPROVED_CLOUDFLARED_PATH";
export type ExecutionContext = "standard" | "capable";
export type BridgeContext = "local" | "bridge";

export interface ExecutionProbe {
  nodeChildSpawn: ProbeStatus;
  cloudflaredSpawn: ProbeStatus;
  relayFork: ProbeStatus;
  classification:
    | "CAPABLE"
    | "RESTRICTED_EXECUTION_CONTEXT"
    | "RESTRICTED_BRIDGE_CONTEXT"
    | "CLOUDFLARED_UNAVAILABLE"
    | "UNAPPROVED_CLOUDFLARED_PATH"
    | "PROBE_FAILED";
}

export type BridgeProbeErrorKind =
  | "ROUTE_NOT_FOUND"
  | "AUTH_FAILURE"
  | "SERVER_ERROR"
  | "CONNECTION_FAILURE"
  | "TIMEOUT"
  | "INVALID_JSON"
  | "SCHEMA_MISMATCH"
  | "ADMIN_INFO_UNAVAILABLE"
  | "OTHER";

export interface RecoverySessionSnapshot {
  url?: string;
  projectUrl?: string;
  workflowMode?: string;
  checkpoint?: unknown;
  connectorName?: string;
  taskId?: string;
  iteration?: number;
  lastState?: string;
}

export function snapshotRecoverySession(session: RecoverySessionSnapshot | null | undefined): RecoverySessionSnapshot {
  return {
    url: session?.url,
    projectUrl: session?.projectUrl,
    workflowMode: session?.workflowMode,
    checkpoint: session?.checkpoint,
    connectorName: session?.connectorName,
    taskId: session?.taskId,
    iteration: session?.iteration,
    lastState: session?.lastState,
  };
}

export function sessionSnapshotPreserved(
  before: RecoverySessionSnapshot | null | undefined,
  after: RecoverySessionSnapshot | null | undefined
): boolean {
  return JSON.stringify(snapshotRecoverySession(before)) === JSON.stringify(snapshotRecoverySession(after));
}

export function recoveryMetadataPreserved(
  before: RecoverySessionSnapshot | null | undefined,
  after: RecoverySessionSnapshot | null | undefined
): boolean {
  const a = snapshotRecoverySession(before);
  const b = snapshotRecoverySession(after);
  delete a.connectorName;
  delete b.connectorName;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function classifyProbe(
  context: BridgeContext,
  probe: Omit<ExecutionProbe, "classification">
): ExecutionProbe["classification"] {
  if (probe.cloudflaredSpawn === "UNAPPROVED_CLOUDFLARED_PATH") return "UNAPPROVED_CLOUDFLARED_PATH";
  if (probe.nodeChildSpawn === "EPERM") {
    return context === "bridge" ? "RESTRICTED_BRIDGE_CONTEXT" : "RESTRICTED_EXECUTION_CONTEXT";
  }
  if (probe.cloudflaredSpawn === "NOT_CONFIGURED") return "CLOUDFLARED_UNAVAILABLE";
  if (probe.cloudflaredSpawn === "EPERM" || probe.relayFork === "EPERM") {
    return context === "bridge" ? "RESTRICTED_BRIDGE_CONTEXT" : "RESTRICTED_EXECUTION_CONTEXT";
  }
  if ([probe.nodeChildSpawn, probe.cloudflaredSpawn, probe.relayFork].every((value) => value === "PASS")) {
    return "CAPABLE";
  }
  return "PROBE_FAILED";
}

export type EndpointDecision = "CONNECTOR_STILL_VALID" | "CONNECTOR_UPDATE_REQUIRED" | "STATE_INCONSISTENT";

function normalizeEndpoint(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

export function compareRecoveryEndpoint(input: {
  currentMcpUrl?: string | null;
  confirmedMcpUrl?: string | null;
  connectorName?: string | null;
  savedChatUrl?: string | null;
}): EndpointDecision {
  const current = normalizeEndpoint(input.currentMcpUrl);
  const confirmed = normalizeEndpoint(input.confirmedMcpUrl);
  if (!input.connectorName?.trim() || !input.savedChatUrl?.trim() || !current) return "STATE_INCONSISTENT";
  return confirmed === current ? "CONNECTOR_STILL_VALID" : "CONNECTOR_UPDATE_REQUIRED";
}

export function suggestConnectorName(currentName: string): string {
  const match = currentName.trim().match(/^(.*?)(?:\s*·\s*|\s+)v(\d+)$/i);
  if (match) return `${match[1].trim()} · v${Number(match[2]) + 1}`;
  return `${currentName.trim()} · recovery`;
}

export type RecoveryAction =
  | "INSPECT_LOCAL"
  | "START_BRIDGE_AND_TUNNEL"
  | "START_TUNNEL"
  | "RETRY_CAPABLE_CONTEXT"
  | "RESTART_BRIDGE_IN_CAPABLE_CONTEXT"
  | "REPLACE_LEGACY_BRIDGE_ONCE"
  | "COMPARE_ENDPOINT"
  | "HUMAN_MCP_APP_GATE"
  | "AI_GENERATE_PAIR_CODE"
  | "WAIT_PAIRING_COMPLETE"
  | "AI_CONFIRM_CONNECTOR"
  | "POST_RECOVERY_VERIFY"
  | "COMPLETE"
  | "BLOCKED_LOCAL_EXECUTION"
  | "BLOCKED_STATE_INCONSISTENT"
  | "BLOCKED_BRIDGE_UNKNOWN"
  | "LOCAL_RECOVERY_FAILED"
  | "UNAPPROVED_CLOUDFLARED_PATH"
  | "INVALID_RECOVERY_TRANSITION";

export type RecoveryState =
  | "LOCAL_DIAGNOSIS"
  | "LOCAL_RECOVERY"
  | "LEGACY_BRIDGE_PROBE_UNSUPPORTED"
  | "LOCAL_HEALTH_PASS"
  | "ENDPOINT_COMPARE"
  | "HUMAN_MCP_APP_GATE"
  | "WAIT_PAIRING_PAGE"
  | "WAIT_PAIR_CODE_GENERATION"
  | "GENERATING_PAIR_CODE"
  | "AI_GENERATE_PAIR_CODE"
  | "WAIT_PAIRING_COMPLETE"
  | "AI_CONFIRM_CONNECTOR"
  | "CONFIRMING_CONNECTOR"
  | "POST_RECOVERY_VERIFY"
  | "COMPLETE"
  | "BLOCKED_LOCAL_EXECUTION"
  | "BLOCKED_STATE_INCONSISTENT"
  | "BLOCKED_BRIDGE_UNKNOWN"
  | "LOCAL_RECOVERY_FAILED"
  | "UNAPPROVED_CLOUDFLARED_PATH"
  | "INVALID_RECOVERY_TRANSITION";

export type RecoveryEvent = "PAIRING_PAGE_OPENED" | "PAIR_CODE_GENERATION_REQUESTED" | "PAIR_CODE_GENERATED" | "PAIR_CODE_GENERATION_FAILED" | "PAIRING_COMPLETED" | "CONNECTOR_CONFIRM_REQUESTED" | "CONNECTOR_CONFIRMED" | "CONNECTOR_CONFIRMATION_FAILED" | "SESSION_PRESERVATION_FAILED";

export interface DoctorFacts {
  report?: Record<string, { ok?: boolean; detail?: string }>;
  chatgptRepair?: {
    needed?: boolean;
    reason?: string;
    connectorName?: string;
    mcpUrl?: string | null;
    previousMcpUrl?: string | null;
  };
  namedRepair?: { needed?: boolean };
}

export interface RecoveryFacts {
  phase?: "LOCAL_DIAGNOSIS" | "ENDPOINT_COMPARE" | "POST_RECOVERY_VERIFY";
  workspace?: { workspaceId?: string; name?: string };
  session?: RecoverySessionSnapshot | null;
  doctor?: DoctorFacts;
  bridgeStatus?: "healthy" | "stopped" | "unknown";
  localProbe?: ExecutionProbe;
  bridgeProbe?: ExecutionProbe;
  bridgeProbeError?: boolean;
  bridgeInfoHealthy?: boolean;
  bridgeInfoStatus?: number | null;
  bridgeInfoErrorKind?: BridgeProbeErrorKind | null;
  bridgeInfoTunnelHealth?: "HEALTHY" | "UNHEALTHY" | "UNKNOWN";
  bridgeProbeStatus?: number | null;
  bridgeProbeErrorKind?: BridgeProbeErrorKind | null;
  localRecoveryRuntimeSupportsProbe?: boolean;
  recoverySessionSnapshot?: RecoverySessionSnapshot | null;
  executionContext?: ExecutionContext;
  capableContextAttempted?: boolean;
  bridgeRestartAttempted?: boolean;
  legacyMigrationAuthorized?: boolean;
  legacyMigrationAttempted?: boolean;
  recoveryState?: RecoveryState;
  transitionEvent?: RecoveryEvent;
  requestedMcpUrl?: string;
  localActionResult?: { ok: boolean; errorCode?: string };
  actualConnectorName?: string;
  connectorConfirmed?: boolean;
  workspaceInfo?: { workspaceName?: string; workspaceId?: string };
  savedChatUrlAfter?: string;
  checkRoundTrip?: { checkId?: string; replyCheckId?: string; workspaceName?: string; workspaceId?: string };
  sessionAfter?: RecoverySessionSnapshot | null;
}

export interface RecoveryPlan {
  ok: boolean;
  state: RecoveryState;
  nextAction: RecoveryAction;
  humanActionRequired: boolean;
  facts: Record<string, unknown>;
}

function plan(
  state: RecoveryState,
  nextAction: RecoveryAction,
  ok = false,
  humanActionRequired = false,
  facts: Record<string, unknown> = {}
): RecoveryPlan {
  return { ok, state, nextAction, humanActionRequired, facts };
}

export function localHealthPass(doctor: DoctorFacts | undefined): boolean {
  const report = doctor?.report;
  const required = ["node", "sandbox", "workspace", "bridge", "mcp", "oauth", "tunnel"];
  return Boolean(
    report &&
      required.every((key) => report[key]?.ok === true) &&
      doctor?.namedRepair?.needed !== true &&
      Boolean(doctor?.chatgptRepair?.mcpUrl)
  );
}

function usableBaseFacts(facts: RecoveryFacts): boolean {
  return Boolean(facts.workspace?.workspaceId && facts.workspace.name && facts.session?.url && facts.session.connectorName);
}

export function planRecovery(facts: RecoveryFacts): RecoveryPlan {
  if (!usableBaseFacts(facts)) {
    return plan("BLOCKED_STATE_INCONSISTENT", "BLOCKED_STATE_INCONSISTENT", false, false, {
      reason: "workspace identity, saved Chat URL, or Connector name is missing",
    });
  }

  if (facts.localProbe?.classification === "UNAPPROVED_CLOUDFLARED_PATH") {
    return plan("UNAPPROVED_CLOUDFLARED_PATH", "UNAPPROVED_CLOUDFLARED_PATH", false, false, {
      reason: "configured cloudflared executable is outside the approved C2C-managed directory",
    });
  }
  if (facts.capableContextAttempted && facts.localProbe?.classification !== "CAPABLE") {
    return plan("BLOCKED_LOCAL_EXECUTION", "BLOCKED_LOCAL_EXECUTION", false, false, {
      reason: "the actual process probe did not confirm capability after the single escalation",
    });
  }

  if (facts.transitionEvent) {
    const transitions: Record<RecoveryEvent, { from: RecoveryState; to: RecoveryState; next: RecoveryAction }> = {
      PAIRING_PAGE_OPENED: { from: "HUMAN_MCP_APP_GATE", to: "WAIT_PAIR_CODE_GENERATION", next: "AI_GENERATE_PAIR_CODE" },
      PAIR_CODE_GENERATION_REQUESTED: { from: "WAIT_PAIR_CODE_GENERATION", to: "GENERATING_PAIR_CODE", next: "AI_GENERATE_PAIR_CODE" },
      PAIR_CODE_GENERATED: { from: "GENERATING_PAIR_CODE", to: "WAIT_PAIRING_COMPLETE", next: "WAIT_PAIRING_COMPLETE" },
      PAIR_CODE_GENERATION_FAILED: { from: "GENERATING_PAIR_CODE", to: "LOCAL_RECOVERY_FAILED", next: "LOCAL_RECOVERY_FAILED" },
      PAIRING_COMPLETED: { from: "WAIT_PAIRING_COMPLETE", to: "AI_CONFIRM_CONNECTOR", next: "AI_CONFIRM_CONNECTOR" },
      CONNECTOR_CONFIRM_REQUESTED: { from: "AI_CONFIRM_CONNECTOR", to: "CONFIRMING_CONNECTOR", next: "AI_CONFIRM_CONNECTOR" },
      CONNECTOR_CONFIRMED: { from: "CONFIRMING_CONNECTOR", to: "POST_RECOVERY_VERIFY", next: "POST_RECOVERY_VERIFY" },
      CONNECTOR_CONFIRMATION_FAILED: { from: "CONFIRMING_CONNECTOR", to: "LOCAL_RECOVERY_FAILED", next: "LOCAL_RECOVERY_FAILED" },
      SESSION_PRESERVATION_FAILED: { from: "LOCAL_RECOVERY", to: "BLOCKED_STATE_INCONSISTENT", next: "BLOCKED_STATE_INCONSISTENT" },
    };
    const transition = transitions[facts.transitionEvent];
    const validEndpointGate = facts.transitionEvent !== "PAIRING_PAGE_OPENED" || (
      facts.doctor?.chatgptRepair?.needed === true &&
      compareRecoveryEndpoint({
        currentMcpUrl: facts.doctor?.chatgptRepair?.mcpUrl,
        confirmedMcpUrl: facts.doctor?.chatgptRepair?.previousMcpUrl,
        connectorName: facts.session?.connectorName,
        savedChatUrl: facts.session?.url,
      }) === "CONNECTOR_UPDATE_REQUIRED"
    );
    const isTerminalFailure = facts.transitionEvent === "PAIR_CODE_GENERATION_FAILED" || facts.transitionEvent === "CONNECTOR_CONFIRMATION_FAILED" || facts.transitionEvent === "SESSION_PRESERVATION_FAILED";
    const validLocalHealth = isTerminalFailure || localHealthPass(facts.doctor);
    const validConnector = facts.transitionEvent !== "PAIRING_COMPLETED" || Boolean(facts.actualConnectorName?.trim());
    const validConfirmation = facts.transitionEvent !== "CONNECTOR_CONFIRMED" || (
      facts.connectorConfirmed === true && facts.doctor?.chatgptRepair?.needed !== true &&
      compareRecoveryEndpoint({
        currentMcpUrl: facts.doctor?.chatgptRepair?.mcpUrl,
        confirmedMcpUrl: facts.doctor?.chatgptRepair?.previousMcpUrl,
        connectorName: facts.session?.connectorName,
        savedChatUrl: facts.session?.url,
      }) === "CONNECTOR_STILL_VALID"
    );
    const validRequestedEndpoint = facts.transitionEvent !== "CONNECTOR_CONFIRM_REQUESTED" ||
      normalizeEndpoint(facts.requestedMcpUrl) === normalizeEndpoint(facts.doctor?.chatgptRepair?.mcpUrl);
    const validSourceState = facts.transitionEvent === "SESSION_PRESERVATION_FAILED"
      ? ["LOCAL_RECOVERY", "LEGACY_BRIDGE_PROBE_UNSUPPORTED", "CONFIRMING_CONNECTOR", "POST_RECOVERY_VERIFY"].includes(facts.recoveryState ?? "")
      : facts.recoveryState === transition.from;
    if (!validSourceState || !validLocalHealth || !validEndpointGate || !validConnector || !validConfirmation || !validRequestedEndpoint) {
      return plan("INVALID_RECOVERY_TRANSITION", "INVALID_RECOVERY_TRANSITION", false, false, {
        currentState: facts.recoveryState ?? null,
        event: facts.transitionEvent,
        requiredState: transition.from,
        requestedEndpointMatches: validRequestedEndpoint,
      });
    }
    return plan(transition.to, transition.next, true, false, { recoveryState: transition.to });
  }

  if (facts.localActionResult && !facts.localActionResult.ok) {
    if (facts.localActionResult.errorCode === "EPERM") {
      if (facts.capableContextAttempted || facts.localProbe?.classification === "CAPABLE") {
        return plan("BLOCKED_LOCAL_EXECUTION", "BLOCKED_LOCAL_EXECUTION", false, false, {
          reason: "the process probe or prior escalation does not permit another retry",
        });
      }
      if (facts.localProbe?.classification === "RESTRICTED_EXECUTION_CONTEXT") return plan("LOCAL_RECOVERY", "RETRY_CAPABLE_CONTEXT", false, false, {
        reason: "child-process creation was denied in the standard AI context",
        capableContextAttempted: true,
      });
      return plan("LOCAL_RECOVERY_FAILED", "LOCAL_RECOVERY_FAILED", false, false, { reason: "EPERM was not corroborated by the process probe" });
    }
    return plan("LOCAL_RECOVERY_FAILED", "LOCAL_RECOVERY_FAILED", false, false, {
      reason: facts.localActionResult.errorCode ?? "local recovery command failed",
    });
  }

  if (facts.bridgeStatus === "healthy" && facts.bridgeProbe?.classification === "RESTRICTED_BRIDGE_CONTEXT") {
    if (facts.localProbe?.classification !== "CAPABLE") {
      return facts.capableContextAttempted
        ? plan("BLOCKED_LOCAL_EXECUTION", "BLOCKED_LOCAL_EXECUTION", false, false, {
            reason: "Bridge remains restricted after the single capable-context escalation",
          })
        : plan("LOCAL_RECOVERY", "RETRY_CAPABLE_CONTEXT", false, false, {
            reason: "Bridge relay fork is restricted and local execution capability is not confirmed",
            capableContextAttempted: true,
          });
    }
    if (facts.bridgeRestartAttempted) {
      return plan("LOCAL_RECOVERY_FAILED", "LOCAL_RECOVERY_FAILED", false, false, {
        reason: "the Bridge remained restricted after its single controlled restart",
      });
    }
    return plan("LOCAL_RECOVERY", "RESTART_BRIDGE_IN_CAPABLE_CONTEXT", false, false, {
      reason: "Bridge cannot fork relay; local AI context can create child processes",
      bridgeRestartAttempted: true,
    });
  }

  if (!localHealthPass(facts.doctor)) {
    if (facts.bridgeStatus === "unknown") {
      return plan("BLOCKED_BRIDGE_UNKNOWN", "BLOCKED_BRIDGE_UNKNOWN", false, false, {
        reason: "existing Bridge status is unknown; do not start a second Bridge",
      });
    }

    if (hasVerifiedLegacyBridgeEvidence(facts)) {
      if (facts.bridgeRestartAttempted || facts.legacyMigrationAttempted) {
        return plan("BLOCKED_LOCAL_EXECUTION", "BLOCKED_LOCAL_EXECUTION", false, false, {
          reason: "the one permitted legacy Bridge replacement was already authorized or attempted",
        });
      }
      const eligibility = legacyMigrationEligibility(facts);
      if (!eligibility.eligible) {
        return plan(eligibility.state, eligibility.state, false, false, { reason: eligibility.reason });
      }
      return plan("LEGACY_BRIDGE_PROBE_UNSUPPORTED", "REPLACE_LEGACY_BRIDGE_ONCE", false, false, {
        reason: "authenticated Bridge info works but this live Bridge does not implement the current recovery-probe route",
        bridgeRestartAttempted: true,
        legacyMigrationAuthorized: true,
      });
    }

    const localClassification = facts.localProbe?.classification;
    if (localClassification === "CLOUDFLARED_UNAVAILABLE") {
      return plan("LOCAL_RECOVERY_FAILED", "LOCAL_RECOVERY_FAILED", false, false, {
        reason: "cloudflared is not configured or cannot be located",
      });
    }
    if (localClassification === "RESTRICTED_EXECUTION_CONTEXT") {
      return facts.capableContextAttempted
        ? plan("BLOCKED_LOCAL_EXECUTION", "BLOCKED_LOCAL_EXECUTION", false, false, {
            reason: "the actual process probe still denies child creation after the single escalation",
          })
        : plan("LOCAL_RECOVERY", "RETRY_CAPABLE_CONTEXT", false, false, {
            reason: "Node child creation is blocked in the standard AI context",
            capableContextAttempted: true,
          });
    }

    if (facts.bridgeStatus === "healthy" && facts.bridgeProbeError) {
      return plan("BLOCKED_BRIDGE_UNKNOWN", "BLOCKED_BRIDGE_UNKNOWN", false, false, {
        reason: "the existing Bridge did not return a structured process probe",
      });
    }

    if (facts.bridgeStatus === "stopped") {
      return plan("LOCAL_RECOVERY", "START_BRIDGE_AND_TUNNEL", false);
    }
    if (facts.bridgeStatus === "healthy" && facts.doctor?.report?.tunnel?.ok !== true) {
      return plan("LOCAL_RECOVERY", "START_TUNNEL", false);
    }
    return plan("LOCAL_DIAGNOSIS", "INSPECT_LOCAL", false);
  }

  const doctorConnectorName = facts.doctor?.chatgptRepair?.connectorName?.trim();
  const expectedConnectorName = facts.phase === "POST_RECOVERY_VERIFY"
    ? facts.actualConnectorName?.trim() || facts.sessionAfter?.connectorName?.trim()
    : facts.session?.connectorName?.trim();
  if (doctorConnectorName && doctorConnectorName !== expectedConnectorName) {
    return plan("BLOCKED_STATE_INCONSISTENT", "BLOCKED_STATE_INCONSISTENT", false, false, {
      reason: "doctor endpoint metadata and saved session Connector names differ",
    });
  }

  if (facts.phase !== "ENDPOINT_COMPARE" && facts.phase !== "POST_RECOVERY_VERIFY") {
    return plan("LOCAL_HEALTH_PASS", "COMPARE_ENDPOINT", true, false, {
      currentMcpUrl: facts.doctor?.chatgptRepair?.mcpUrl,
      confirmedMcpUrl: facts.doctor?.chatgptRepair?.previousMcpUrl,
      connectorName: facts.session?.connectorName,
      savedChatUrl: facts.session?.url,
    });
  }

  const endpoint = compareRecoveryEndpoint({
    currentMcpUrl: facts.doctor?.chatgptRepair?.mcpUrl,
    confirmedMcpUrl: facts.doctor?.chatgptRepair?.previousMcpUrl,
    connectorName: facts.session?.connectorName,
    savedChatUrl: facts.session?.url,
  });
  if (endpoint === "STATE_INCONSISTENT") {
    return plan("BLOCKED_STATE_INCONSISTENT", "BLOCKED_STATE_INCONSISTENT", false, false, {
      reason: "current MCP endpoint or saved Connector binding is missing",
    });
  }
  if (facts.doctor?.chatgptRepair?.needed === true && endpoint === "CONNECTOR_STILL_VALID") {
    return plan("BLOCKED_STATE_INCONSISTENT", "BLOCKED_STATE_INCONSISTENT", false, false, {
      reason: "doctor requires Connector repair although confirmed and current endpoint values match",
    });
  }
  if (endpoint === "CONNECTOR_UPDATE_REQUIRED") {
    return plan("HUMAN_MCP_APP_GATE", "HUMAN_MCP_APP_GATE", true, true, {
      endpointDecision: endpoint,
      endpoint: facts.doctor?.chatgptRepair?.mcpUrl,
      currentConnectorName: facts.session?.connectorName,
      suggestedConnectorName: suggestConnectorName(facts.session?.connectorName ?? "Codex with ChatGPT"),
    });
  }

  if (facts.phase !== "POST_RECOVERY_VERIFY") {
    return plan("ENDPOINT_COMPARE", "POST_RECOVERY_VERIFY", true, false, {
      endpointDecision: endpoint,
    });
  }

  if (!facts.connectorConfirmed) {
    return plan("POST_RECOVERY_VERIFY", "POST_RECOVERY_VERIFY", true);
  }

  const info = facts.workspaceInfo;
  const workspace = facts.workspace;
  const workspaceMatches = Boolean(
    workspace && info?.workspaceName === workspace.name && info?.workspaceId === workspace.workspaceId
  );
  const chatMatches = facts.savedChatUrlAfter === facts.session?.url;
  const roundTripMatches = Boolean(
    facts.checkRoundTrip &&
      facts.checkRoundTrip.checkId &&
      facts.checkRoundTrip.checkId === facts.checkRoundTrip.replyCheckId &&
      facts.checkRoundTrip.workspaceName === facts.workspace?.name &&
      facts.checkRoundTrip.workspaceId === facts.workspace?.workspaceId
  );
  const sessionMatches = recoveryMetadataPreserved(facts.session, facts.sessionAfter);
  const connectorNameMatches = facts.sessionAfter?.connectorName === (facts.actualConnectorName ?? facts.session?.connectorName);
  if (!sessionMatches) {
    return plan("BLOCKED_STATE_INCONSISTENT", "BLOCKED_STATE_INCONSISTENT", false, false, {
      reason: "protected recovery session metadata changed during post-recovery verification",
      sessionMatches,
    });
  }
  if (!workspaceMatches || !chatMatches || !roundTripMatches || !sessionMatches || !connectorNameMatches) {
    return plan("POST_RECOVERY_VERIFY", "POST_RECOVERY_VERIFY", false, false, {
      workspaceMatches,
      chatMatches,
      roundTripMatches,
      sessionMatches,
      connectorNameMatches,
    });
  }
  return plan("COMPLETE", "COMPLETE", true, false, {
    workspaceName: facts.workspace?.name,
    connectorName: facts.session?.connectorName,
  });
}
