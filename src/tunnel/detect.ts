import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const COMMON_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  path.join(process.env.HOME ?? "", ".local", "bin"),
  "C:\\Program Files\\cloudflared",
  "C:\\Program Files (x86)\\cloudflared",
];

/**
 * Return deterministic candidate paths without executing any candidate.
 * Callers that use this for a security-sensitive probe must validate each
 * result against their own approved location before starting a process.
 */
export function discoverBinaryCandidates(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const candidates: string[] = [];
  if (name === "cloudflared" && env.C2C_CLOUDFLARED_PATH?.trim()) {
    candidates.push(env.C2C_CLOUDFLARED_PATH.trim());
  }
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    const cleaned = directory.trim().replace(/^"(.*)"$/, "$1");
    if (cleaned) candidates.push(path.join(cleaned, exe));
  }
  for (const directory of COMMON_DIRS) candidates.push(path.join(directory, exe));
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = process.platform === "win32" ? path.resolve(candidate).toLowerCase() : path.resolve(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function accessibleFile(candidate: string): string | null {
  try {
    const resolved = path.resolve(candidate);
    if (!fs.statSync(resolved).isFile()) return null;
    fs.accessSync(resolved, fs.constants.F_OK | fs.constants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

/** Locate a binary on PATH or in common install locations. */
export function findBinary(name: string): string | null {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  if (name === "cloudflared" && process.env.C2C_CLOUDFLARED_PATH?.trim()) {
    const configured = accessibleFile(process.env.C2C_CLOUDFLARED_PATH.trim());
    if (configured) return configured;
  }
  try {
    const probe = spawnSync(exe, ["--version"], {
      stdio: "ignore",
      timeout: 5000,
      windowsHide: true,
    });
    if (probe.status === 0 || probe.status === 1) return exe; // on PATH
  } catch {
    // not on PATH
  }
  for (const dir of COMMON_DIRS) {
    const full = path.join(dir, exe);
    const configured = accessibleFile(full);
    if (configured) return configured;
  }
  return null;
}

export interface TunnelBinaries {
  cloudflared: string | null;
  wrangler: string | null;
}

export function detectTunnelBinaries(): TunnelBinaries {
  return {
    cloudflared: findBinary("cloudflared"),
    wrangler: findBinary("wrangler"),
  };
}
