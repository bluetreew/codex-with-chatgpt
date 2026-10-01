import { fork, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { managedCloudflaredDirectory } from "../config/paths.js";
import { classifyProbe, type BridgeContext, type BridgeProbeErrorKind, type ExecutionProbe, type ProbeStatus } from "./harness.js";

export interface BridgeProbeObservation {
  bridgeInfoHealthy: boolean;
  bridgeInfoStatus: number | null;
  bridgeInfoErrorKind: BridgeProbeErrorKind | null;
  bridgeInfoTunnelHealth?: "HEALTHY" | "UNHEALTHY" | "UNKNOWN";
  bridgeInfoPublicUrl?: string | null;
  bridgeProbe: ExecutionProbe | null;
  bridgeProbeStatus: number | null;
  bridgeProbeErrorKind: BridgeProbeErrorKind | null;
}

function transportErrorKind(error: unknown): BridgeProbeErrorKind {
  const value = error as NodeJS.ErrnoException;
  if (value.name === "AbortError") return "TIMEOUT";
  const code = value.cause && typeof value.cause === "object"
    ? (value.cause as NodeJS.ErrnoException).code
    : value.code;
  if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ENOTFOUND"].includes(code ?? "")) {
    return "CONNECTION_FAILURE";
  }
  return "OTHER";
}

function httpErrorKind(status: number, phase: "info" | "probe"): BridgeProbeErrorKind {
  if (status === 401 || status === 403) return "AUTH_FAILURE";
  if (status >= 500) return "SERVER_ERROR";
  if (phase === "info" && status === 404) return "ADMIN_INFO_UNAVAILABLE";
  if (phase === "probe" && status === 404) return "ROUTE_NOT_FOUND";
  return "OTHER";
}

function isExecutionProbe(value: unknown): value is ExecutionProbe {
  if (!value || typeof value !== "object") return false;
  const probe = value as Partial<ExecutionProbe>;
  const statuses: ProbeStatus[] = ["PASS", "EPERM", "FAIL", "NOT_CONFIGURED", "UNAPPROVED_CLOUDFLARED_PATH"];
  const classifications: ExecutionProbe["classification"][] = [
    "CAPABLE", "RESTRICTED_EXECUTION_CONTEXT", "RESTRICTED_BRIDGE_CONTEXT", "CLOUDFLARED_UNAVAILABLE", "UNAPPROVED_CLOUDFLARED_PATH", "PROBE_FAILED",
  ];
  return statuses.includes(probe.nodeChildSpawn as ProbeStatus) &&
    statuses.includes(probe.cloudflaredSpawn as ProbeStatus) &&
    statuses.includes(probe.relayFork as ProbeStatus) &&
    classifications.includes(probe.classification as ExecutionProbe["classification"]);
}

/** Read the authenticated admin-info and recovery-probe routes without changing Bridge state. */
export async function observeBridgeRecoveryProbe(options: {
  port: number;
  adminToken: string;
  workspaceId: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}): Promise<BridgeProbeObservation> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 12_000;
  const request = async (route: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetcher(`http://127.0.0.1:${options.port}${route}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${options.adminToken}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };
  const failed = (
    bridgeInfoStatus: number | null,
    bridgeInfoErrorKind: BridgeProbeErrorKind | null,
    bridgeProbeStatus: number | null,
    bridgeProbeErrorKind: BridgeProbeErrorKind
  ): BridgeProbeObservation => ({
    bridgeInfoHealthy: false,
    bridgeInfoStatus,
    bridgeInfoErrorKind,
    bridgeInfoTunnelHealth: "UNKNOWN",
    bridgeProbe: null,
    bridgeProbeStatus,
    bridgeProbeErrorKind,
  });

  let infoResponse: Response;
  try {
    infoResponse = await request("/admin/info");
  } catch (error) {
    const kind = transportErrorKind(error);
    return failed(null, kind, null, kind);
  }
  if (infoResponse.status !== 200) {
    const kind = httpErrorKind(infoResponse.status, "info");
    return failed(infoResponse.status, kind, null, kind);
  }

  let info: unknown;
  try {
    info = JSON.parse(await infoResponse.text());
  } catch {
    return failed(infoResponse.status, "SCHEMA_MISMATCH", null, "SCHEMA_MISMATCH");
  }
  if (!info || typeof info !== "object" || (info as { service?: unknown }).service !== "c2c-bridge" || (info as { workspaceId?: unknown }).workspaceId !== options.workspaceId) {
    return failed(infoResponse.status, "SCHEMA_MISMATCH", null, "SCHEMA_MISMATCH");
  }
  const infoValue = info as { publicUrl?: unknown; tunnel?: { running?: unknown } };
  const bridgeInfoTunnelHealth = infoValue.tunnel?.running === false
    ? "UNHEALTHY"
    : infoValue.tunnel?.running === true && typeof infoValue.publicUrl === "string" && Boolean(infoValue.publicUrl)
      ? "HEALTHY"
      : "UNKNOWN";
  const bridgeInfoPublicUrl = typeof infoValue.publicUrl === "string" ? infoValue.publicUrl : null;

  let probeResponse: Response;
  try {
    probeResponse = await request("/admin/recovery-probe");
  } catch (error) {
    const kind = transportErrorKind(error);
    return { ...failed(infoResponse.status, null, null, kind), bridgeInfoHealthy: true, bridgeInfoTunnelHealth, bridgeInfoPublicUrl };
  }
  if (!probeResponse.ok) {
    const kind = httpErrorKind(probeResponse.status, "probe");
    return { ...failed(infoResponse.status, null, probeResponse.status, kind), bridgeInfoHealthy: true, bridgeInfoTunnelHealth, bridgeInfoPublicUrl };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await probeResponse.text());
  } catch {
    return { ...failed(infoResponse.status, null, probeResponse.status, "INVALID_JSON"), bridgeInfoHealthy: true, bridgeInfoTunnelHealth, bridgeInfoPublicUrl };
  }
  if (!payload || typeof payload !== "object" ||
      (payload as { ok?: unknown }).ok !== true ||
      (payload as { context?: unknown }).context !== "bridge" ||
      !isExecutionProbe((payload as { probe?: unknown }).probe)) {
    return { ...failed(infoResponse.status, null, probeResponse.status, "SCHEMA_MISMATCH"), bridgeInfoHealthy: true, bridgeInfoTunnelHealth, bridgeInfoPublicUrl };
  }
  return {
    bridgeInfoHealthy: true,
    bridgeInfoStatus: infoResponse.status,
    bridgeInfoErrorKind: null,
    bridgeInfoTunnelHealth,
    bridgeInfoPublicUrl,
    bridgeProbe: (payload as { probe: ExecutionProbe }).probe,
    bridgeProbeStatus: probeResponse.status,
    bridgeProbeErrorKind: null,
  };
}

export interface ProbeAdapter {
  spawnVersion(executable: string, timeoutMs: number): ProbeStatus;
  forkRelay(relayPath: string, timeoutMs: number): Promise<ProbeStatus>;
}

function statusFromError(error: unknown): ProbeStatus {
  return (error as NodeJS.ErrnoException)?.code === "EPERM" ? "EPERM" : "FAIL";
}

export function resolveApprovedCloudflaredPath(
  candidate: unknown,
  managedDirectory = managedCloudflaredDirectory()
): { status: "PASS"; path: string } | { status: "NOT_CONFIGURED" | "UNAPPROVED_CLOUDFLARED_PATH" } {
  try {
    const requestedManagedRoot = path.resolve(managedDirectory);
    const managedRoot = fs.realpathSync.native(requestedManagedRoot);
    const comparePath = (value: string): string => {
      const normalized = path.resolve(value).replace(/^\\\\\\?\\/, "");
      return process.platform === "win32" ? normalized.toLowerCase() : normalized;
    };
    // The approved root itself must not be redirected through a symlink or junction.
    if (comparePath(managedRoot) !== comparePath(requestedManagedRoot)) {
      return { status: "UNAPPROVED_CLOUDFLARED_PATH" };
    }
    const canonicalPath = path.join(managedRoot, "cloudflared.exe");
    const canonical = fs.realpathSync.native(canonicalPath);
    // The managed executable entry itself must also be a regular canonical file,
    // not a symlink/junction whose target escapes the approved root.
    if (comparePath(canonical) !== comparePath(canonicalPath) ||
        !fs.statSync(canonical).isFile() || path.basename(canonical).toLowerCase() !== "cloudflared.exe") {
      return { status: "UNAPPROVED_CLOUDFLARED_PATH" };
    }
    const configured = candidate === undefined || candidate === null || candidate === "" ? canonicalPath : candidate;
    if (typeof configured !== "string" || !path.isAbsolute(configured)) {
      return { status: "UNAPPROVED_CLOUDFLARED_PATH" };
    }
    const resolved = fs.realpathSync.native(path.resolve(configured));
    if (!fs.statSync(resolved).isFile() || comparePath(resolved) !== comparePath(canonical)) return { status: "UNAPPROVED_CLOUDFLARED_PATH" };
    return { status: "PASS", path: resolved };
  } catch {
    return candidate === undefined || candidate === null || candidate === ""
      ? { status: "NOT_CONFIGURED" }
      : { status: "UNAPPROVED_CLOUDFLARED_PATH" };
  }
}

function probeEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] ? [[key, process.env[key] as string]] : []));
}

const defaultAdapter: ProbeAdapter = {
  spawnVersion(executable, timeoutMs) {
    try {
      const result = spawnSync(executable, ["--version"], {
        encoding: "utf8",
        stdio: "ignore",
        timeout: timeoutMs,
        windowsHide: true,
      env: probeEnvironment(),
      });
      if (result.error) return statusFromError(result.error);
      return result.status === 0 ? "PASS" : "FAIL";
    } catch (error) {
      return statusFromError(error);
    }
  },
  forkRelay(relayPath, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (status: ProbeStatus): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(status);
      };
      try {
        const child = fork(relayPath, ["recovery-probe"], {
          execArgv: [],
          silent: true,
          env: probeEnvironment(),
        });
        timer = setTimeout(() => {
          child.kill();
          finish("FAIL");
        }, timeoutMs);
        child.once("message", (message) => {
          const probeMessage = message as { type?: unknown } | null;
          finish(probeMessage?.type === "c2c-recovery-probe-ready" ? "PASS" : "FAIL");
          child.kill();
        });
        child.once("error", (error) => finish(statusFromError(error)));
        child.once("exit", (code) => {
          if (!settled) finish(code === 0 ? "PASS" : "FAIL");
        });
      } catch (error) {
        finish(statusFromError(error));
      }
    });
  },
};

export async function probeExecutionContext(options: {
  context: BridgeContext;
  cloudflaredPath?: unknown;
  managedCloudflaredDirectory?: string;
  timeoutMs?: number;
  adapter?: ProbeAdapter;
}): Promise<ExecutionProbe> {
  const adapter = options.adapter ?? defaultAdapter;
  const timeoutMs = options.timeoutMs ?? 5000;
  const relayPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../relay.cjs");
  const approvedCloudflared = resolveApprovedCloudflaredPath(options.cloudflaredPath, options.managedCloudflaredDirectory);
  const [nodeChildSpawn, cloudflaredSpawn, relayFork] = await Promise.all([
    Promise.resolve(adapter.spawnVersion(process.execPath, timeoutMs)),
    approvedCloudflared.status === "PASS"
      ? Promise.resolve(adapter.spawnVersion(approvedCloudflared.path, timeoutMs))
      : Promise.resolve<ProbeStatus>(approvedCloudflared.status),
    adapter.forkRelay(relayPath, timeoutMs),
  ]);
  return {
    nodeChildSpawn,
    cloudflaredSpawn,
    relayFork,
    classification: classifyProbe(options.context, { nodeChildSpawn, cloudflaredSpawn, relayFork }),
  };
}
