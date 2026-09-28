import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "./config/paths.js";
import { networkProfileFile } from "./config/network-profile.js";
import type { BridgeObservation, RuntimeState } from "./bridge/runtime.js";
import { classifyProbe, type ExecutionProbe } from "./recovery/harness.js";
import { probeExecutionContext, resolveApprovedCloudflaredPath, type BridgeProbeObservation, type ProbeAdapter } from "./recovery/probe.js";
import { discoverBinaryCandidates } from "./tunnel/detect.js";

export type ControlBootstrapState =
  | "CONTROL_CAPABLE_CONTEXT_REQUIRED"
  | "CONTROL_CAPABLE_RETRY_IN_PROGRESS"
  | "CONTROL_BRIDGE_READY"
  | "CONTROL_BOOTSTRAP_BLOCKED";

export interface StateDirectoryWriteProbe {
  ok: boolean;
  created: boolean;
  readBack: boolean;
  deleted: boolean;
  failureCode?: string;
}

export interface ControlBootstrapProgress {
  schemaVersion: 1;
  workspaceId: string;
  controlWorkspaceRoot: string;
  controlStateDir: string;
  state: ControlBootstrapState;
  capableContextAttempted: boolean;
  updatedAt: string;
  reason?: string;
}

export interface ControlBootstrapResult {
  ok: boolean;
  state: ControlBootstrapState;
  nextAction: "RETRY_CAPABLE_CONTEXT" | "CONTROL_LOCAL_HEALTH_GATE" | "CONTROL_BOOTSTRAP_BLOCKED";
  capableContextAttempted: boolean;
  stateDirectoryWriteProbe: StateDirectoryWriteProbe;
  localProbe?: ExecutionProbe;
  bridgeStatus?: BridgeObservation["state"];
  bridgeProbe?: BridgeProbeObservation;
  reason?: string;
}

export interface ControlBootstrapInput {
  workspaceId: string;
  controlWorkspaceRoot: string;
  controlStateDir: string;
  targetWorkspaceRoot: string;
  targetStateDir: string;
  capableContextRetry: boolean;
}

export interface ControlBootstrapIdentities {
  controlWorkspaceRoot: string;
  controlStateDir: string;
  targetWorkspaceRoot: string;
  targetStateDir: string;
}

export const APPROVED_CONTROL_BOOTSTRAP_IDENTITIES: Readonly<ControlBootstrapIdentities> = Object.freeze({
  controlWorkspaceRoot: "D:\\app_home\\codex-with-chatgpt",
  controlStateDir: "C:\\Users\\66483\\AppData\\Local\\codex-with-chatgpt\\c2c-repair-control-state",
  targetWorkspaceRoot: "D:\\workshop\\职业教育-MOZI",
  targetStateDir: "D:\\app_home\\codex-with-chatgpt-state",
});

export interface ControlBootstrapAdapter {
  approvedIdentities: Readonly<ControlBootstrapIdentities>;
  stateDirectoryWriteProbe(stateDir: string): StateDirectoryWriteProbe;
  localProbe(): Promise<ExecutionProbe>;
  findBridge(workspaceId: string): Promise<BridgeObservation>;
  startBridge(workspaceRoot: string): Promise<{ runtime: RuntimeState; spawned: boolean }>;
  bridgeProbe(runtime: RuntimeState, workspaceId: string): Promise<BridgeProbeObservation>;
}

export interface ControlBootstrapCloudflaredResolution {
  candidate?: string;
  managedDirectory: string;
  status: "PASS" | "NOT_CONFIGURED" | "UNAPPROVED_CLOUDFLARED_PATH";
  source: "profile" | "managed" | "discovery" | "none";
}

export interface ControlBootstrapProbeOptions {
  environment?: NodeJS.ProcessEnv;
  probeAdapter?: ProbeAdapter;
}

/** Discover candidates without executing them; only the existing managed-root validator can approve one. */
export function resolveControlBootstrapCloudflared(
  profileCandidate: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): ControlBootstrapCloudflaredResolution {
  const managedDirectory = path.join(path.dirname(getStateDir()), "cloudflared");
  if (profileCandidate !== undefined && profileCandidate !== null && profileCandidate !== "") {
    const approved = resolveApprovedCloudflaredPath(profileCandidate, managedDirectory);
    return {
      ...(approved.status === "PASS" ? { candidate: approved.path } : {}),
      managedDirectory,
      status: approved.status,
      source: "profile",
    };
  }

  const managed = resolveApprovedCloudflaredPath(undefined, managedDirectory);
  if (managed.status === "PASS") {
    return { candidate: managed.path, managedDirectory, status: "PASS", source: "managed" };
  }
  if (managed.status === "UNAPPROVED_CLOUDFLARED_PATH") {
    return { managedDirectory, status: managed.status, source: "managed" };
  }

  for (const discovered of discoverBinaryCandidates("cloudflared", environment)) {
    let isFile = false;
    try { isFile = fs.statSync(discovered).isFile(); }
    catch { /* An absent discovery candidate is not an installation. */ }
    if (!isFile) continue;
    const approved = resolveApprovedCloudflaredPath(discovered, managedDirectory);
    if (approved.status === "PASS") {
      return { candidate: approved.path, managedDirectory, status: "PASS", source: "discovery" };
    }
  }

  // Untrusted PATH/environment candidates are intentionally not returned to the probe.
  return { managedDirectory, status: "NOT_CONFIGURED", source: "none" };
}

/** Production CLI probe wiring: profile read → safe discovery → trust validation → execution probe. */
export async function probeControlBootstrapLocalExecution(
  workspaceId: string,
  options: ControlBootstrapProbeOptions = {},
): Promise<ExecutionProbe> {
  const profile = readJsonIfExists<{ cloudflaredPath?: unknown }>(networkProfileFile(workspaceId));
  const resolved = resolveControlBootstrapCloudflared(profile?.cloudflaredPath, options.environment ?? process.env);
  const base = await probeExecutionContext({
    context: "local",
    cloudflaredPath: resolved.candidate,
    managedCloudflaredDirectory: resolved.managedDirectory,
    adapter: options.probeAdapter,
  });
  if (resolved.status !== "UNAPPROVED_CLOUDFLARED_PATH") return base;
  const facts = { ...base, cloudflaredSpawn: "UNAPPROVED_CLOUDFLARED_PATH" as const };
  return { ...facts, classification: classifyProbe("local", facts) };
}

/** Build the adapter used by both production CLI and fresh-state wiring tests. */
export function createControlBootstrapCliAdapter(
  workspaceId: string,
  dependencies: Omit<ControlBootstrapAdapter, "localProbe">,
  options: ControlBootstrapProbeOptions = {},
): ControlBootstrapAdapter {
  return {
    ...dependencies,
    localProbe: () => probeControlBootstrapLocalExecution(workspaceId, options),
  };
}

const states: readonly ControlBootstrapState[] = [
  "CONTROL_CAPABLE_CONTEXT_REQUIRED",
  "CONTROL_CAPABLE_RETRY_IN_PROGRESS",
  "CONTROL_BRIDGE_READY",
  "CONTROL_BOOTSTRAP_BLOCKED",
];

function hasDotSegments(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment === "." || segment === "..");
}

function normalizeWindowsPath(value: string): string {
  const withoutExtendedPrefix = value.startsWith("\\\\?\\") ? value.slice(4) : value;
  return path.win32.normalize(withoutExtendedPrefix);
}

function canonicalExistingPath(value: string): string | null {
  if (!path.win32.isAbsolute(value) || hasDotSegments(value)) return null;
  try {
    return normalizeWindowsPath(fs.realpathSync.native(value));
  } catch {
    return null;
  }
}

/** Resolve CONTROL state without creating its production directory during validation. */
function canonicalControlStatePath(value: string): string | null {
  if (!path.win32.isAbsolute(value) || hasDotSegments(value) ||
      path.win32.basename(value).toLowerCase() !== "c2c-repair-control-state") return null;
  try {
    const parent = normalizeWindowsPath(fs.realpathSync.native(path.win32.dirname(value)));
    const canonicalChild = path.win32.join(parent, "c2c-repair-control-state");
    if (fs.existsSync(value) && !sameCanonical(normalizeWindowsPath(fs.realpathSync.native(value)), canonicalChild)) return null;
    return path.win32.normalize(canonicalChild);
  } catch {
    return null;
  }
}

function sameCanonical(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && left.toLowerCase() === right.toLowerCase();
}

/** Validate all four identities without creating state or opening TARGET files. */
export function validateControlBootstrapIsolation(
  input: Pick<ControlBootstrapInput, keyof ControlBootstrapIdentities>,
  approved: Readonly<ControlBootstrapIdentities> = APPROVED_CONTROL_BOOTSTRAP_IDENTITIES,
): string | null {
  const candidates = [
    [input.controlWorkspaceRoot, approved.controlWorkspaceRoot, canonicalExistingPath],
    [input.controlStateDir, approved.controlStateDir, canonicalControlStatePath],
    [input.targetWorkspaceRoot, approved.targetWorkspaceRoot, canonicalExistingPath],
    [input.targetStateDir, approved.targetStateDir, canonicalExistingPath],
  ] as const;
  for (const [candidate, expected, resolvePath] of candidates) {
    if (!sameCanonical(resolvePath(candidate), resolvePath(expected))) return "CONTROL_IDENTITY_MISMATCH";
  }
  return null;
}

export function controlBootstrapProgressFile(stateDir: string, workspaceId: string): string {
  const safeId = encodeURIComponent(workspaceId).replaceAll("%", "_");
  return path.join(stateDir, "control-bootstrap", `${safeId}.json`);
}

export function controlBootstrapRetryMarkerFile(stateDir: string, marker: "offered" | "consumed"): string {
  return path.join(stateDir, marker === "offered" ? "capable-retry-offered" : "capable-retry-consumed");
}

export type RetryMarkerResult = "CREATED" | "ALREADY_EXISTS" | "FAILED";

/** Atomic create-if-absent. Markers are persistent one-way gates and are never removed here. */
export function createControlBootstrapRetryMarker(stateDir: string, marker: "offered" | "consumed"): RetryMarkerResult {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(controlBootstrapRetryMarkerFile(stateDir, marker), "wx", 0o600);
    fs.writeSync(descriptor, `${marker}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    return "CREATED";
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* keep the fail-closed marker */ }
    }
    return (error as NodeJS.ErrnoException).code === "EEXIST" ? "ALREADY_EXISTS" : "FAILED";
  }
}

function retryMarkerExists(stateDir: string, marker: "offered" | "consumed"): boolean {
  try {
    fs.accessSync(controlBootstrapRetryMarkerFile(stateDir, marker));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function readControlBootstrapProgress(stateDir: string, workspaceId: string): ControlBootstrapProgress | null {
  const file = controlBootstrapProgressFile(stateDir, workspaceId);
  if (!fs.existsSync(file)) return null;
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("CONTROL_BOOTSTRAP_PROGRESS_INVALID"); }
  if (!value || typeof value !== "object") throw new Error("CONTROL_BOOTSTRAP_PROGRESS_INVALID");
  const progress = value as Partial<ControlBootstrapProgress>;
  if (progress.schemaVersion !== 1 || progress.workspaceId !== workspaceId ||
      typeof progress.controlWorkspaceRoot !== "string" || typeof progress.controlStateDir !== "string" ||
      !states.includes(progress.state as ControlBootstrapState) ||
      typeof progress.capableContextAttempted !== "boolean" || typeof progress.updatedAt !== "string") {
    throw new Error("CONTROL_BOOTSTRAP_PROGRESS_INVALID");
  }
  return progress as ControlBootstrapProgress;
}

export function writeControlBootstrapProgress(stateDir: string, progress: ControlBootstrapProgress): void {
  writeSecureJson(controlBootstrapProgressFile(stateDir, progress.workspaceId), progress);
}

/** Probe effective state access without consulting or changing config.toml. */
export function probeControlStateDirectoryWrite(stateDir: string): StateDirectoryWriteProbe {
  let created = false;
  let readBack = false;
  let deleted = false;
  let file: string | null = null;
  let failureCode: string | undefined;
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const nonce = crypto.randomBytes(16).toString("hex");
    file = path.join(stateDir, `.c2c-control-write-probe-${nonce}.tmp`);
    fs.writeFileSync(file, nonce, { flag: "wx", mode: 0o600 });
    created = true;
    readBack = fs.readFileSync(file, "utf8") === nonce;
  } catch (error) {
    failureCode = (error as NodeJS.ErrnoException).code ?? "STATE_WRITE_PROBE_FAILED";
  } finally {
    if (file && fs.existsSync(file)) {
      try { fs.unlinkSync(file); deleted = true; }
      catch { deleted = false; }
    }
  }
  if (!failureCode && !deleted) failureCode = "TEMP_FILE_CLEANUP_FAILED";
  return { ok: created && readBack && deleted, created, readBack, deleted, ...(failureCode ? { failureCode } : {}) };
}

function capable(probe: ExecutionProbe): boolean {
  return probe.classification === "CAPABLE" &&
    probe.nodeChildSpawn === "PASS" && probe.cloudflaredSpawn === "PASS" && probe.relayFork === "PASS";
}

function bridgeCapable(probe: BridgeProbeObservation): boolean {
  const value = probe.bridgeProbe;
  return probe.bridgeInfoHealthy && probe.bridgeInfoStatus === 200 &&
    probe.bridgeProbeStatus === 200 && probe.bridgeProbeErrorKind === null &&
    value?.classification === "CAPABLE" && value.nodeChildSpawn === "PASS" &&
    value.cloudflaredSpawn === "PASS" && value.relayFork === "PASS";
}

function resultBlocked(
  stateDirectoryWriteProbe: StateDirectoryWriteProbe,
  capableContextAttempted: boolean,
  reason: string,
  localProbe?: ExecutionProbe,
  bridgeStatus?: BridgeObservation["state"],
  bridgeProbe?: BridgeProbeObservation,
): ControlBootstrapResult {
  return {
    ok: false,
    state: "CONTROL_BOOTSTRAP_BLOCKED",
    nextAction: "CONTROL_BOOTSTRAP_BLOCKED",
    capableContextAttempted,
    stateDirectoryWriteProbe,
    ...(localProbe ? { localProbe } : {}),
    ...(bridgeStatus ? { bridgeStatus } : {}),
    ...(bridgeProbe ? { bridgeProbe } : {}),
    reason,
  };
}

function progressFor(input: ControlBootstrapInput, state: ControlBootstrapState, attempted: boolean, reason?: string): ControlBootstrapProgress {
  return {
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    controlWorkspaceRoot: path.resolve(input.controlWorkspaceRoot),
    controlStateDir: path.resolve(input.controlStateDir),
    state,
    capableContextAttempted: attempted,
    updatedAt: new Date().toISOString(),
    ...(reason ? { reason } : {}),
  };
}

function persistBlocked(input: ControlBootstrapInput, attempted: boolean, reason: string): void {
  try { writeControlBootstrapProgress(input.controlStateDir, progressFor(input, "CONTROL_BOOTSTRAP_BLOCKED", attempted, reason)); }
  catch { /* Keep the structured blocker; never escalate state writes here. */ }
}

export async function runControlBootstrap(
  input: ControlBootstrapInput,
  adapter: ControlBootstrapAdapter,
): Promise<ControlBootstrapResult> {
  const isolationError = validateControlBootstrapIsolation(input, adapter.approvedIdentities);
  const emptyProbe: StateDirectoryWriteProbe = { ok: false, created: false, readBack: false, deleted: false };
  if (isolationError) return resultBlocked(emptyProbe, false, isolationError);

  const stateDirectoryWriteProbe = adapter.stateDirectoryWriteProbe(input.controlStateDir);
  if (!stateDirectoryWriteProbe.ok) return resultBlocked(stateDirectoryWriteProbe, false, "CONTROL_STATE_NOT_WRITABLE");

  let progress: ControlBootstrapProgress | null;
  try { progress = readControlBootstrapProgress(input.controlStateDir, input.workspaceId); }
  catch { return resultBlocked(stateDirectoryWriteProbe, false, "CONTROL_BOOTSTRAP_PROGRESS_INVALID"); }
  let offered: boolean;
  let consumed: boolean;
  try {
    offered = retryMarkerExists(input.controlStateDir, "offered");
    consumed = retryMarkerExists(input.controlStateDir, "consumed");
  } catch {
    return resultBlocked(stateDirectoryWriteProbe, false, "CAPABLE_CONTEXT_MARKER_READ_FAILED");
  }
  if ((offered && !progress) ||
      (progress?.state === "CONTROL_CAPABLE_CONTEXT_REQUIRED" && !offered) ||
      (consumed && (!progress || progress.state === "CONTROL_CAPABLE_CONTEXT_REQUIRED" || progress.state === "CONTROL_CAPABLE_RETRY_IN_PROGRESS"))) {
    return resultBlocked(stateDirectoryWriteProbe, consumed, "CAPABLE_CONTEXT_MARKER_PROGRESS_INCONSISTENT");
  }
  if (progress && (
    !sameCanonical(canonicalExistingPath(progress.controlWorkspaceRoot), canonicalExistingPath(input.controlWorkspaceRoot)) ||
    !sameCanonical(canonicalControlStatePath(progress.controlStateDir), canonicalControlStatePath(input.controlStateDir))
  )) return resultBlocked(stateDirectoryWriteProbe, progress.capableContextAttempted, "CONTROL_BOOTSTRAP_IDENTITY_MISMATCH");
  if (progress?.state === "CONTROL_BOOTSTRAP_BLOCKED") {
    return resultBlocked(stateDirectoryWriteProbe, progress.capableContextAttempted, progress.reason ?? "CONTROL_BOOTSTRAP_ALREADY_BLOCKED");
  }
  if (input.capableContextRetry && (
    !progress || progress.state !== "CONTROL_CAPABLE_CONTEXT_REQUIRED" || progress.capableContextAttempted || !offered || consumed
  )) return resultBlocked(stateDirectoryWriteProbe, progress?.capableContextAttempted ?? false, "CAPABLE_CONTEXT_RETRY_NOT_AUTHORIZED");
  if (!input.capableContextRetry && progress?.state === "CONTROL_CAPABLE_RETRY_IN_PROGRESS") {
    return resultBlocked(stateDirectoryWriteProbe, true, "CAPABLE_CONTEXT_RETRY_ALREADY_CONSUMED");
  }

  if (input.capableContextRetry) {
    const marker = createControlBootstrapRetryMarker(input.controlStateDir, "consumed");
    if (marker !== "CREATED") {
      return resultBlocked(stateDirectoryWriteProbe, marker === "ALREADY_EXISTS", marker === "ALREADY_EXISTS"
        ? "CAPABLE_CONTEXT_RETRY_ALREADY_CONSUMED"
        : "CAPABLE_CONTEXT_MARKER_WRITE_FAILED");
    }
    progress = progressFor(input, "CONTROL_CAPABLE_RETRY_IN_PROGRESS", true);
    try { writeControlBootstrapProgress(input.controlStateDir, progress); }
    catch { return resultBlocked(stateDirectoryWriteProbe, true, "CONTROL_BOOTSTRAP_PROGRESS_WRITE_FAILED"); }
  }

  let localProbe: ExecutionProbe;
  try { localProbe = await adapter.localProbe(); }
  catch {
    const attempted = input.capableContextRetry || progress?.capableContextAttempted || false;
    const reason = attempted ? "BLOCKED_LOCAL_EXECUTION" : "LOCAL_EXECUTION_PROBE_FAILED";
    if (attempted) persistBlocked(input, true, reason);
    return resultBlocked(stateDirectoryWriteProbe, attempted, reason);
  }

  if (!capable(localProbe)) {
    if (localProbe.classification === "RESTRICTED_EXECUTION_CONTEXT" &&
        !input.capableContextRetry && !progress?.capableContextAttempted) {
      const marker = createControlBootstrapRetryMarker(input.controlStateDir, "offered");
      if (marker !== "CREATED") {
        return resultBlocked(stateDirectoryWriteProbe, false, marker === "ALREADY_EXISTS"
          ? "CAPABLE_CONTEXT_HANDOFF_ALREADY_OFFERED"
          : "CAPABLE_CONTEXT_MARKER_WRITE_FAILED", localProbe);
      }
      try { writeControlBootstrapProgress(input.controlStateDir, progressFor(input, "CONTROL_CAPABLE_CONTEXT_REQUIRED", false, "LOCAL_RELAY_FORK_EPERM")); }
      catch { return resultBlocked(stateDirectoryWriteProbe, false, "CONTROL_BOOTSTRAP_PROGRESS_WRITE_FAILED", localProbe); }
      return {
        ok: false,
        state: "CONTROL_CAPABLE_CONTEXT_REQUIRED",
        nextAction: "RETRY_CAPABLE_CONTEXT",
        capableContextAttempted: false,
        stateDirectoryWriteProbe,
        localProbe,
        reason: "Local relay fork is restricted; one Codex-controlled capable-context handoff is allowed",
      };
    }
    const attempted = input.capableContextRetry || progress?.capableContextAttempted || false;
    const reason = attempted ? "BLOCKED_LOCAL_EXECUTION" : "LOCAL_EXECUTION_CAPABILITY_REQUIRED";
    if (attempted) persistBlocked(input, true, reason);
    return resultBlocked(stateDirectoryWriteProbe, attempted, reason, localProbe);
  }

  let observation: BridgeObservation;
  try { observation = await adapter.findBridge(input.workspaceId); }
  catch { return resultBlocked(stateDirectoryWriteProbe, progress?.capableContextAttempted ?? false, "CONTROL_BRIDGE_OBSERVATION_FAILED", localProbe); }
  if (observation.state === "unknown") {
    const result = resultBlocked(stateDirectoryWriteProbe, progress?.capableContextAttempted ?? false, "CONTROL_BRIDGE_STATE_UNKNOWN", localProbe, observation.state);
    persistBlocked(input, result.capableContextAttempted, result.reason!);
    return result;
  }

  let runtime: RuntimeState;
  let finalBridgeStatus: BridgeObservation["state"] = observation.state;
  if (observation.state === "healthy") {
    runtime = observation.runtime;
  } else {
    try {
      runtime = (await adapter.startBridge(input.controlWorkspaceRoot)).runtime;
      finalBridgeStatus = "healthy";
    } catch {
      const result = resultBlocked(stateDirectoryWriteProbe, progress?.capableContextAttempted ?? false, "CONTROL_BRIDGE_START_FAILED", localProbe, observation.state);
      persistBlocked(input, result.capableContextAttempted, result.reason!);
      return result;
    }
  }
  if (runtime.workspaceId !== input.workspaceId || path.resolve(runtime.workspaceRoot) !== path.resolve(input.controlWorkspaceRoot)) {
    const result = resultBlocked(stateDirectoryWriteProbe, progress?.capableContextAttempted ?? false, "CONTROL_BRIDGE_IDENTITY_MISMATCH", localProbe, finalBridgeStatus);
    persistBlocked(input, result.capableContextAttempted, result.reason!);
    return result;
  }

  let bridgeProbe: BridgeProbeObservation;
  try { bridgeProbe = await adapter.bridgeProbe(runtime, input.workspaceId); }
  catch {
    bridgeProbe = {
      bridgeInfoHealthy: false,
      bridgeInfoStatus: null,
      bridgeInfoErrorKind: "CONNECTION_FAILURE",
      bridgeProbe: null,
      bridgeProbeStatus: null,
      bridgeProbeErrorKind: "CONNECTION_FAILURE",
    };
  }
  if (!bridgeCapable(bridgeProbe)) {
    const result = resultBlocked(stateDirectoryWriteProbe, progress?.capableContextAttempted ?? false, "CONTROL_BRIDGE_CAPABILITY_FAILED", localProbe, finalBridgeStatus, bridgeProbe);
    persistBlocked(input, result.capableContextAttempted, result.reason!);
    return result;
  }

  const attempted = progress?.capableContextAttempted ?? false;
  try { writeControlBootstrapProgress(input.controlStateDir, progressFor(input, "CONTROL_BRIDGE_READY", attempted)); }
  catch { return resultBlocked(stateDirectoryWriteProbe, attempted, "CONTROL_BOOTSTRAP_PROGRESS_WRITE_FAILED", localProbe, finalBridgeStatus, bridgeProbe); }
  return {
    ok: true,
    state: "CONTROL_BRIDGE_READY",
    nextAction: "CONTROL_LOCAL_HEALTH_GATE",
    capableContextAttempted: attempted,
    stateDirectoryWriteProbe,
    localProbe,
    bridgeStatus: finalBridgeStatus,
    bridgeProbe,
  };
}
