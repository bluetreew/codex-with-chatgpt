import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";

/**
 * Runtime state file: how the CLI/Skill finds a running bridge for a
 * workspace. Contains the admin token, so it is 0600 and lives in the user
 * state dir, never in the project.
 */
export interface RuntimeState {
  service: string;
  version: string;
  workspaceId: string;
  workspaceRoot: string;
  pid: number;
  port: number;
  adminToken: string;
  publicUrl: string | null;
  startedAt: string;
  /** OS-sourced creation time for this exact PID; absent on historical records. */
  processCreatedAt?: string | null;
}

export type RuntimeStateFields = Omit<RuntimeState, "startedAt" | "processCreatedAt">;

export interface ProcessCreatedAtProbeResult {
  status: number | null;
  stdout: string;
  error?: unknown;
}

export interface ProcessCreatedAtQueryOptions {
  platform?: NodeJS.Platform;
  systemRoot?: string;
  run?: (command: string, args: string[], script: string) => ProcessCreatedAtProbeResult;
}

/** Normalize OS process times to the shared UTC millisecond precision used by both queries. */
export function normalizeProcessCreatedAt(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/** Query Win32_Process for the exact PID; never infer process creation from application clocks. */
export function queryProcessCreatedAt(pid: number, options: ProcessCreatedAtQueryOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || !Number.isSafeInteger(pid) || pid <= 0) return null;

  const systemRoot = options.systemRoot ?? process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const powershell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = [
    "$ErrorActionPreference='Stop'",
    `$processId=${pid}`,
    "$process=Get-CimInstance -ClassName Win32_Process -Filter (\"ProcessId = $processId\")",
    "if ($null -eq $process) { exit 2 }",
    "$process.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')",
  ].join("; ");
  const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
  const run = options.run ?? ((command: string, commandArgs: string[], _script: string): ProcessCreatedAtProbeResult => {
    const result = spawnSync(command, commandArgs, {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: process.env.PATH ?? "" },
    });
    return { status: result.status, stdout: result.stdout ?? "", error: result.error };
  });

  try {
    const result = run(powershell, args, script);
    if (result.error || result.status !== 0) return null;
    return normalizeProcessCreatedAt(result.stdout.trim());
  } catch {
    return null;
  }
}

/** Keep Bridge readiness time separate from OS process creation provenance. */
export function createRuntimeState(
  fields: RuntimeStateFields,
  processCreatedAt: string | null,
  readyAt: Date = new Date(),
): RuntimeState {
  return {
    ...fields,
    processCreatedAt: normalizeProcessCreatedAt(processCreatedAt),
    startedAt: readyAt.toISOString(),
  };
}

export function runtimeFile(workspaceId: string): string {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), `${workspaceId}.json`);
}

export function writeRuntimeState(state: RuntimeState): void {
  writeSecureJson(runtimeFile(state.workspaceId), state);
}

export function readRuntimeState(workspaceId: string): RuntimeState | null {
  return readJsonIfExists<RuntimeState>(runtimeFile(workspaceId));
}

export function clearRuntimeState(workspaceId: string): void {
  try {
    fs.rmSync(runtimeFile(workspaceId), { force: true });
  } catch {
    // ignore
  }
}

export interface HealthPayload {
  service: string;
  version: string;
  workspaceId: string;
  status: string;
}

/** Probe a port and check whether a healthy c2c bridge for the workspace answers. */
export async function probeBridge(
  port: number,
  timeoutMs = 2000
): Promise<HealthPayload | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const body = (await response.json()) as HealthPayload;
    if (body.service !== SERVICE_NAME) return null;
    return body;
  } catch {
    return null;
  }
}

export type BridgeObservation =
  | { state: "healthy"; runtime: RuntimeState }
  | { state: "stopped"; runtime: RuntimeState | null; reason: "runtime_missing" | "pid_missing" }
  | { state: "unknown"; runtime: RuntimeState | null; reason: "probe_failed" | "pid_unknown" | "workspace_mismatch" };

function observePid(pid: number): "present" | "missing" | "unknown" {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "missing" : "unknown";
  }
}

/**
 * Distinguish a dead bridge from a probe that simply failed.
 * Read-only: never starts, stops, or clears runtime.
 */
export async function findBridgeObservation(workspaceId: string): Promise<BridgeObservation> {
  const runtime = readRuntimeState(workspaceId);
  if (!runtime) return { state: "stopped", runtime: null, reason: "runtime_missing" };

  const health = await probeBridge(runtime.port);
  if (health && health.workspaceId === workspaceId) {
    return { state: "healthy", runtime };
  }
  if (health) {
    return { state: "unknown", runtime, reason: "workspace_mismatch" };
  }

  const pid = observePid(runtime.pid);
  if (pid === "missing") return { state: "stopped", runtime, reason: "pid_missing" };
  return { state: "unknown", runtime, reason: pid === "unknown" ? "pid_unknown" : "probe_failed" };
}

export async function findLiveBridge(workspaceId: string): Promise<RuntimeState | null> {
  const observation = await findBridgeObservation(workspaceId);
  return observation.state === "healthy" ? observation.runtime : null;
}

export { SERVICE_NAME, VERSION };
