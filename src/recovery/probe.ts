import { fork, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getStateDir } from "../config/paths.js";
import { classifyProbe, type BridgeContext, type ExecutionProbe, type ProbeStatus } from "./harness.js";

export interface ProbeAdapter {
  spawnVersion(executable: string, timeoutMs: number): ProbeStatus;
  forkRelay(relayPath: string, timeoutMs: number): Promise<ProbeStatus>;
}

function statusFromError(error: unknown): ProbeStatus {
  return (error as NodeJS.ErrnoException)?.code === "EPERM" ? "EPERM" : "FAIL";
}

export function resolveApprovedCloudflaredPath(
  candidate: unknown,
  managedDirectory = path.join(path.dirname(getStateDir()), "cloudflared")
): { status: "PASS"; path: string } | { status: "NOT_CONFIGURED" | "UNAPPROVED_CLOUDFLARED_PATH" } {
  try {
    const managedRoot = fs.realpathSync(managedDirectory);
    const canonicalPath = path.join(managedRoot, "cloudflared.exe");
    const canonical = fs.realpathSync(canonicalPath);
    if (!fs.statSync(canonical).isFile() || path.basename(canonical).toLowerCase() !== "cloudflared.exe") {
      return { status: "UNAPPROVED_CLOUDFLARED_PATH" };
    }
    const configured = candidate === undefined || candidate === null || candidate === "" ? canonicalPath : candidate;
    if (typeof configured !== "string" || !path.isAbsolute(configured)) {
      return { status: "UNAPPROVED_CLOUDFLARED_PATH" };
    }
    const resolved = fs.realpathSync(path.resolve(configured));
    if (!fs.statSync(resolved).isFile() || resolved.toLowerCase() !== canonical.toLowerCase()) return { status: "UNAPPROVED_CLOUDFLARED_PATH" };
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
