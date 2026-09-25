import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "./paths.js";

export interface NetworkProfile {
  proxyUrl: string;
  tunnelProtocol: "auto" | "quic" | "http2";
  quickServiceRelay: boolean;
  noProxy: string;
  cloudflaredPath: string;
}

export function networkProfileFile(workspaceId: string): string {
  return path.join(getStateDir(), "network-profiles", `${workspaceId}.json`);
}

export function readNetworkProfile(workspaceId: string): NetworkProfile | null {
  const value = readJsonIfExists<NetworkProfile>(networkProfileFile(workspaceId));
  if (!value) return null;
  const url = new URL(value.proxyUrl);
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || !url.port || url.username || url.password) {
    throw new Error("Invalid C2C network profile proxyUrl");
  }
  if (!["auto", "quic", "http2"].includes(value.tunnelProtocol)) {
    throw new Error("Invalid C2C network profile tunnelProtocol");
  }
  if (typeof value.quickServiceRelay !== "boolean" || typeof value.noProxy !== "string" || !path.isAbsolute(value.cloudflaredPath)) {
    throw new Error("Invalid C2C network profile");
  }
  return value;
}

export function writeNetworkProfile(workspaceId: string, profile: NetworkProfile): void {
  writeSecureJson(networkProfileFile(workspaceId), profile);
}

export function networkProcessEnv(profile: NetworkProfile | null, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!profile) return { ...base };
  const env = { ...base };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) env[key] = profile.proxyUrl;
  env.NO_PROXY = profile.noProxy;
  env.no_proxy = profile.noProxy;
  env.C2C_TUNNEL_PROTOCOL = profile.tunnelProtocol;
  env.C2C_CLOUDFLARED_PATH = profile.cloudflaredPath;
  env.C2C_QUICK_SERVICE_RELAY = profile.quickServiceRelay ? "1" : "0";
  return env;
}
