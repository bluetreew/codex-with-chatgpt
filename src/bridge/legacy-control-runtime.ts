import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeProcessCreatedAt, type RuntimeState } from "./runtime.js";

export const LEGACY_CONTROL_STATE_DIR = "D:\\app_home\\codex-with-chatgpt-repair-control-state";
const CONTROL_WORKSPACE_ROOT = "D:\\app_home\\codex-with-chatgpt";
const RETIREMENT_TIMEOUT_MS = 8_000;
const RETIREMENT_POLL_MS = 100;

export interface ListenerEndpointEvidence {
  localAddress: string;
  localPort: number;
  ownerPid: number;
}

export type ListenerQueryResult =
  | { status: "ok"; listeners: ListenerEndpointEvidence[] }
  | { status: "error"; reason: string };

export interface LegacyProcessEvidence {
  state: "MISSING" | "PRESENT" | "UNKNOWN";
  listenerQuery: ListenerQueryResult;
  processId?: number;
  createdAt?: string;
  executablePath?: string;
  commandLine?: string;
}

export interface LegacyProcessProbeResult {
  status: number | null;
  stdout: string;
  error?: { code?: string; message?: string } | null;
}

export interface LegacyAdminInfo {
  status: number;
  body: unknown;
}

export type LegacyRuntimeInspection =
  | { disposition: "NONE" }
  | { disposition: "STALE"; reason: "PROCESS_MISSING" }
  | { disposition: "EXACT"; runtime: RuntimeState }
  | { disposition: "CONFLICT"; reason: string };

export type LegacyRuntimeReconciliation =
  | { disposition: "NONE" | "STALE" | "RETIRED" }
  | { disposition: "CONFLICT"; reason: "CONTROL_RUNTIME_IDENTITY_CONFLICT" | "LEGACY_RUNTIME_CREATION_PROVENANCE_MISSING" }
  | { disposition: "BLOCKED"; reason: "LEGACY_CONTROL_RUNTIME_RETIREMENT_INCOMPLETE" };

export interface LegacyReconciliationOptions {
  /** Test seam only; production passes no path and always uses the fixed identity. */
  legacyStateDirectory?: string;
  processEvidence?: (runtime: RuntimeState) => Promise<LegacyProcessEvidence> | LegacyProcessEvidence;
  adminInfo?: (runtime: RuntimeState, workspaceRoot: string) => Promise<LegacyAdminInfo>;
  health?: (runtime: RuntimeState) => Promise<boolean>;
  requestShutdown?: (runtime: RuntimeState) => Promise<boolean>;
  waitForRetirement?: (runtime: RuntimeState) => Promise<boolean>;
}

export interface RetirementWaitOptions {
  processEvidence?: () => Promise<LegacyProcessEvidence> | LegacyProcessEvidence;
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value).replace(/^\\\\\?\\/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function processCommandMatches(commandLine: string, workspaceRoot: string): boolean {
  const canonicalRoot = process.platform === "win32" ? path.win32.resolve(workspaceRoot) : path.resolve(workspaceRoot);
  const escaped = canonicalRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cliEntry = `(?:"[^\"]*[\\\\/]cli[\\\\/]index\\.(?:js|ts)"|[^\\s"]*[\\\\/]cli[\\\\/]index\\.(?:js|ts))`;
  return new RegExp(`${cliEntry}\\s+serve\\s+--workspace\\s+(?:"${escaped}"|${escaped})(?:\\s|$)`, "i").test(commandLine);
}

function parseRuntime(value: unknown, workspaceId: string, workspaceRoot: string): RuntimeState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const runtime = value as Partial<RuntimeState>;
  if (runtime.service !== "c2c-bridge" || runtime.workspaceId !== workspaceId ||
      typeof runtime.workspaceRoot !== "string" || normalizedPath(runtime.workspaceRoot) !== normalizedPath(workspaceRoot) ||
      !Number.isSafeInteger(runtime.pid) || (runtime.pid ?? 0) <= 0 || (runtime.pid ?? 0) > 0xffff_ffff ||
      !Number.isSafeInteger(runtime.port) || (runtime.port ?? 0) < 1 || (runtime.port ?? 0) > 65535 ||
      typeof runtime.adminToken !== "string" || runtime.adminToken.length < 16 ||
      typeof runtime.startedAt !== "string" || !Number.isFinite(Date.parse(runtime.startedAt))) return null;
  const processCreatedAt = runtime.processCreatedAt;
  if (processCreatedAt !== undefined && processCreatedAt !== null && !normalizeProcessCreatedAt(processCreatedAt)) return null;
  return {
    ...(runtime as RuntimeState),
    ...(typeof processCreatedAt === "string" ? { processCreatedAt: normalizeProcessCreatedAt(processCreatedAt)! } : {}),
  };
}

function processProbeError(reason: string): LegacyProcessEvidence {
  return { state: "UNKNOWN", listenerQuery: { status: "error", reason } };
}

/** Decode the OS probe without ever collapsing query failure into an empty listener set. */
export function parseLegacyProcessProbeResult(result: LegacyProcessProbeResult): LegacyProcessEvidence {
  if (result.error) return processProbeError(`spawn ${result.error.code ?? "error"}: ${result.error.message ?? "process query failed"}`);
  if (result.status !== 0) return processProbeError(`process query exited with status ${String(result.status)}`);
  let value: unknown;
  try { value = JSON.parse(result.stdout); }
  catch { return processProbeError("process query returned malformed JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return processProbeError("process query returned an invalid object");
  const payload = value as {
    process?: { processId?: unknown; createdAt?: unknown; executablePath?: unknown; commandLine?: unknown } | null;
    listenerQuery?: { status?: unknown; reason?: unknown; listeners?: unknown };
  };
  const query = payload.listenerQuery;
  if (!query || query.status === "error") {
    return processProbeError(typeof query?.reason === "string" ? query.reason : "listener query failed");
  }
  if (query.status !== "ok" || !Array.isArray(query.listeners)) return processProbeError("listener query returned malformed data");
  const listeners: ListenerEndpointEvidence[] = [];
  for (const candidate of query.listeners) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return processProbeError("listener query returned a malformed listener");
    const item = candidate as Record<string, unknown>;
    if (typeof item.localAddress !== "string" || !Number.isSafeInteger(item.localPort) ||
        !Number.isSafeInteger(item.ownerPid) || Number(item.localPort) < 1 || Number(item.localPort) > 65535 || Number(item.ownerPid) <= 0) {
      return processProbeError("listener query returned invalid endpoint fields");
    }
    listeners.push({ localAddress: item.localAddress, localPort: Number(item.localPort), ownerPid: Number(item.ownerPid) });
  }
  const listenerQuery: ListenerQueryResult = { status: "ok", listeners };
  if (payload.process === null || payload.process === undefined) return { state: "MISSING", listenerQuery };
  const proc = payload.process;
  const createdAt = normalizeProcessCreatedAt(proc.createdAt);
  if (typeof proc.processId !== "number" || !Number.isSafeInteger(proc.processId) || !createdAt ||
      typeof proc.executablePath !== "string" || typeof proc.commandLine !== "string") {
    return { state: "UNKNOWN", listenerQuery };
  }
  return {
    state: "PRESENT",
    listenerQuery,
    processId: proc.processId,
    createdAt,
    executablePath: proc.executablePath,
    commandLine: proc.commandLine,
  };
}

function defaultProcessEvidence(runtime: RuntimeState): LegacyProcessEvidence {
  if (process.platform !== "win32") return processProbeError("process ownership query is only available on Windows");
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const powershell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$processId=${runtime.pid}`,
    `$port=${runtime.port}`,
    "$process=Get-CimInstance -ClassName Win32_Process -Filter (\"ProcessId = $processId\")",
    "$null=Get-Command Get-NetTCPConnection -ErrorAction Stop",
    "$listenerQuery=$null",
    "try { $connections=@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object @{Name='localAddress';Expression={$_.LocalAddress}},@{Name='localPort';Expression={$_.LocalPort}},@{Name='ownerPid';Expression={$_.OwningProcess}}); $listenerQuery=[pscustomobject]@{status='ok';listeners=$connections} } catch { $listenerQuery=[pscustomobject]@{status='error';reason=$_.Exception.Message} }",
    "$processValue=$null",
    "if ($null -ne $process) { $processValue=[pscustomobject]@{ processId=$process.ProcessId; createdAt=$process.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ'); executablePath=$process.ExecutablePath; commandLine=$process.CommandLine } }",
    "[pscustomobject]@{ process=$processValue; listenerQuery=$listenerQuery } | ConvertTo-Json -Compress -Depth 4",
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  try {
    const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      encoding: "utf8", timeout: 5_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: process.env.PATH ?? "" },
    });
    return parseLegacyProcessProbeResult({ status: result.status, stdout: result.stdout ?? "", error: result.error });
  } catch (error) {
    const value = error as NodeJS.ErrnoException;
    return processProbeError(`spawn ${value.code ?? "error"}: ${value.message}`);
  }
}

async function defaultAdminInfo(runtime: RuntimeState): Promise<LegacyAdminInfo> {
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/admin/info`, {
      method: "GET", redirect: "error", headers: { Authorization: `Bearer ${runtime.adminToken}` },
      signal: AbortSignal.timeout(3_000),
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

async function defaultHealth(runtime: RuntimeState): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/health`, { redirect: "error", signal: AbortSignal.timeout(2_000) });
    if (response.status !== 200) return false;
    const value = await response.json() as { service?: unknown; workspaceId?: unknown; status?: unknown };
    return value.service === "c2c-bridge" && value.workspaceId === runtime.workspaceId && value.status === "ok";
  } catch {
    return false;
  }
}

function fixedLegacyRuntimePath(directory: string, workspaceId: string): string {
  if (!/^[a-f0-9]{12}$/i.test(workspaceId)) throw new Error("invalid workspace identity");
  const runtimeDirectory = path.join(directory, "runtime");
  const file = path.join(runtimeDirectory, `${workspaceId}.json`);
  const expectedState = path.resolve(directory);
  const actualState = fs.realpathSync.native(directory);
  if (normalizedPath(actualState) !== normalizedPath(expectedState)) throw new Error("legacy state redirected");
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("legacy state is linked");
  let runtimeDirectoryStat: fs.Stats;
  try { runtimeDirectoryStat = fs.lstatSync(runtimeDirectory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return file;
    throw error;
  }
  if (!runtimeDirectoryStat.isDirectory()) throw new Error("legacy runtime path is not a directory");
  if (fs.lstatSync(runtimeDirectory).isSymbolicLink() ||
      normalizedPath(fs.realpathSync.native(runtimeDirectory)) !== normalizedPath(runtimeDirectory)) {
    throw new Error("legacy runtime directory redirected");
  }
  let fileStat: fs.Stats;
  try { fileStat = fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return file;
    throw error;
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || normalizedPath(fs.realpathSync.native(file)) !== normalizedPath(file)) {
    throw new Error("legacy runtime record redirected");
  }
  return file;
}

async function observeAdminInfo(runtime: RuntimeState, workspaceRoot: string, options: LegacyReconciliationOptions): Promise<boolean> {
  const observed = await (options.adminInfo?.(runtime, workspaceRoot) ?? defaultAdminInfo(runtime));
  if (observed.status !== 200 || !observed.body || typeof observed.body !== "object") return false;
  const info = observed.body as Record<string, unknown>;
  return info.service === "c2c-bridge" && info.workspaceId === runtime.workspaceId &&
    typeof info.workspaceRoot === "string" && normalizedPath(info.workspaceRoot) === normalizedPath(workspaceRoot) &&
    info.pid === runtime.pid && info.port === runtime.port && typeof info.startedAt === "string" &&
    Date.parse(info.startedAt) === Date.parse(runtime.startedAt);
}

function exactProcess(runtime: RuntimeState, workspaceRoot: string, evidence: LegacyProcessEvidence): boolean {
  if (evidence.state !== "PRESENT" || evidence.processId !== runtime.pid || !evidence.createdAt || !evidence.executablePath || !evidence.commandLine ||
      path.win32.basename(evidence.executablePath).toLowerCase() !== "node.exe" ||
      !processCommandMatches(evidence.commandLine, workspaceRoot)) return false;
  const processStart = Date.parse(evidence.createdAt);
  const recordedProcessStart = Date.parse(runtime.processCreatedAt ?? "");
  return Number.isFinite(processStart) && Number.isFinite(recordedProcessStart) && processStart === recordedProcessStart;
}

export async function inspectLegacyControlRuntime(
  workspaceId: string,
  workspaceRoot: string,
  options: LegacyReconciliationOptions = {},
): Promise<LegacyRuntimeInspection> {
  const directory = options.legacyStateDirectory ?? LEGACY_CONTROL_STATE_DIR;
  let file: string;
  try {
    try { fs.lstatSync(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { disposition: "NONE" };
      throw error;
    }
    file = fixedLegacyRuntimePath(directory, workspaceId);
  } catch {
    return { disposition: "CONFLICT", reason: "legacy state identity is not canonical" };
  }
  if (!fs.existsSync(file)) return { disposition: "NONE" };
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return { disposition: "CONFLICT", reason: "legacy runtime record is unreadable" }; }
  const runtime = parseRuntime(raw, workspaceId, workspaceRoot);
  if (!runtime) return { disposition: "CONFLICT", reason: "legacy runtime record identity is invalid" };
  if (!runtime.processCreatedAt) {
    return { disposition: "CONFLICT", reason: "LEGACY_RUNTIME_CREATION_PROVENANCE_MISSING" };
  }
  const evidence = await (options.processEvidence?.(runtime) ?? defaultProcessEvidence(runtime));
  if (evidence.state === "UNKNOWN" || evidence.listenerQuery.status === "error") {
    return { disposition: "CONFLICT", reason: evidence.listenerQuery.status === "error" ? evidence.listenerQuery.reason : "process evidence unavailable" };
  }
  const listeners = evidence.listenerQuery.listeners;
  if (evidence.state === "MISSING") {
    return listeners.length === 0
      ? { disposition: "STALE", reason: "PROCESS_MISSING" }
      : { disposition: "CONFLICT", reason: "expected port is owned by another process" };
  }
  if (!exactProcess(runtime, workspaceRoot, evidence)) {
    return { disposition: "CONFLICT", reason: "live PID ownership evidence does not match" };
  }
  if (listeners.length !== 1 || listeners[0]?.ownerPid !== runtime.pid ||
      listeners[0]?.localPort !== runtime.port || listeners[0]?.localAddress !== "127.0.0.1") {
    return { disposition: "CONFLICT", reason: "expected loopback listener ownership does not match" };
  }
  if (!(await observeAdminInfo(runtime, workspaceRoot, options))) {
    return { disposition: "CONFLICT", reason: "authenticated admin info did not prove exact ownership" };
  }
  const health = options.health ? await options.health(runtime) : await defaultHealth(runtime);
  if (!health) return { disposition: "CONFLICT", reason: "Bridge health did not prove exact workspace identity" };
  return { disposition: "EXACT", runtime };
}

function legacyRuntimeIdentity(runtime: RuntimeState): string {
  return [runtime.workspaceId, normalizedPath(LEGACY_CONTROL_STATE_DIR), runtime.pid, runtime.startedAt, runtime.port].join("\n");
}

function legacyRuntimeMarkerDigest(runtime: RuntimeState): string {
  return crypto.createHash("sha256").update(legacyRuntimeIdentity(runtime)).digest("hex");
}

function retirementMarkerDirectory(controlStateDirectory: string): string {
  return path.join(path.resolve(controlStateDirectory), "legacy-runtime-retirement");
}

export function legacyRetirementIntentFile(controlStateDirectory: string, runtime: RuntimeState): string {
  return path.join(retirementMarkerDirectory(controlStateDirectory), `${legacyRuntimeMarkerDigest(runtime)}.intent.json`);
}

function persistLegacyRetirementIntent(controlStateDirectory: string, runtime: RuntimeState): boolean {
  const markerDirectory = retirementMarkerDirectory(controlStateDirectory);
  const digest = legacyRuntimeMarkerDigest(runtime);
  const intentFile = legacyRetirementIntentFile(controlStateDirectory, runtime);
  let descriptor: number | undefined;
  try {
    const canonicalStateDirectory = path.resolve(controlStateDirectory);
    if (normalizedPath(fs.realpathSync.native(canonicalStateDirectory)) !== normalizedPath(canonicalStateDirectory) ||
        normalizedPath(fs.realpathSync.native(markerDirectory)) !== normalizedPath(markerDirectory)) return false;
    const intent = {
      schemaVersion: 1,
      attemptState: "RETIREMENT_ATTEMPTED",
      markerIdentity: digest,
      workspaceId: runtime.workspaceId,
      legacyStateDirectory: normalizedPath(LEGACY_CONTROL_STATE_DIR),
      pid: runtime.pid,
      startedAt: runtime.startedAt,
      port: runtime.port,
      reason: "EXACT_OWNERSHIP_PROVEN",
      updatedAt: new Date().toISOString(),
    };
    descriptor = fs.openSync(intentFile, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(intent));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    return true;
  } catch {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch { /* marker remains authoritative */ } }
    return false;
  }
}

/** Marker location is derived internally from the canonical state and exact legacy runtime identity. */
export function consumeLegacyRetirementMarker(controlStateDirectory: string, runtime: RuntimeState): "CREATED" | "ALREADY_EXISTS" | "FAILED" {
  const digest = legacyRuntimeMarkerDigest(runtime);
  const markerDirectory = retirementMarkerDirectory(controlStateDirectory);
  const marker = path.join(markerDirectory, `${digest}.marker`);
  let descriptor: number | undefined;
  try {
    const canonicalStateDirectory = path.resolve(controlStateDirectory);
    if (normalizedPath(fs.realpathSync.native(canonicalStateDirectory)) !== normalizedPath(canonicalStateDirectory)) return "FAILED";
    fs.mkdirSync(markerDirectory, { recursive: true, mode: 0o700 });
    if (normalizedPath(fs.realpathSync.native(markerDirectory)) !== normalizedPath(markerDirectory)) return "FAILED";
    descriptor = fs.openSync(marker, "wx", 0o600);
    fs.writeSync(descriptor, `${digest}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    return "CREATED";
  } catch (error) {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch { /* leave the fail-closed marker */ } }
    return (error as NodeJS.ErrnoException).code === "EEXIST" ? "ALREADY_EXISTS" : "FAILED";
  }
}

async function defaultRequestShutdown(runtime: RuntimeState): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/admin/shutdown`, {
      method: "POST", redirect: "error", headers: { Authorization: `Bearer ${runtime.adminToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status !== 200) return false;
    const body = await response.json() as { shuttingDown?: unknown };
    return body.shuttingDown === true;
  } catch {
    return false;
  }
}

export async function waitForLegacyRetirement(runtime: RuntimeState, options: RetirementWaitOptions = {}): Promise<boolean> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? RETIREMENT_TIMEOUT_MS);
  const processEvidence = options.processEvidence ?? (() => defaultProcessEvidence(runtime));
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let first = true;
  while (first || now() < deadline) {
    first = false;
    const evidence = await processEvidence();
    if (evidence.state === "UNKNOWN" || evidence.listenerQuery.status === "error") return false;
    const listeners = evidence.listenerQuery.listeners;
    if (listeners.some((listener) => listener.ownerPid !== runtime.pid)) return false;
    if (evidence.state === "MISSING") return listeners.length === 0;
    if (!exactProcess(runtime, CONTROL_WORKSPACE_ROOT, evidence)) return listeners.length === 0;
    if (now() >= deadline) return false;
    await delay(options.pollIntervalMs ?? RETIREMENT_POLL_MS);
  }
  return false;
}

export async function retireExactLegacyControlRuntime(
  controlStateDirectory: string,
  runtime: RuntimeState,
  options: LegacyReconciliationOptions = {},
): Promise<"RETIRED" | "ALREADY_ATTEMPTED" | "INCOMPLETE"> {
  const marker = consumeLegacyRetirementMarker(controlStateDirectory, runtime);
  if (marker !== "CREATED") return marker === "ALREADY_EXISTS" ? "ALREADY_ATTEMPTED" : "INCOMPLETE";
  if (!persistLegacyRetirementIntent(controlStateDirectory, runtime)) return "INCOMPLETE";
  const stopped = await (options.requestShutdown?.(runtime) ?? defaultRequestShutdown(runtime));
  if (!stopped) return "INCOMPLETE";
  const retired = await (options.waitForRetirement?.(runtime) ?? waitForLegacyRetirement(runtime));
  return retired ? "RETIRED" : "INCOMPLETE";
}

/** Production adapter: fixed legacy identity, authenticated proof, one-shot graceful retirement. */
export async function reconcileLegacyControlRuntime(options: {
  workspaceId: string;
  workspaceRoot: string;
  controlStateDirectory: string;
}): Promise<LegacyRuntimeReconciliation> {
  const inspected = await inspectLegacyControlRuntime(options.workspaceId, options.workspaceRoot);
  if (inspected.disposition === "NONE" || inspected.disposition === "STALE") return inspected;
  if (inspected.disposition === "CONFLICT") {
    return {
      disposition: "CONFLICT",
      reason: inspected.reason === "LEGACY_RUNTIME_CREATION_PROVENANCE_MISSING"
        ? inspected.reason
        : "CONTROL_RUNTIME_IDENTITY_CONFLICT",
    };
  }
  const retired = await retireExactLegacyControlRuntime(options.controlStateDirectory, inspected.runtime);
  return retired === "RETIRED"
    ? { disposition: "RETIRED" }
    : { disposition: "BLOCKED", reason: "LEGACY_CONTROL_RUNTIME_RETIREMENT_INCOMPLETE" };
}
