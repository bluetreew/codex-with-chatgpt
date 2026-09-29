import { spawn, fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import readline from "node:readline";
import { EnvHttpProxyAgent, ProxyAgent, fetch as proxyFetch } from "undici";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import { SERVICE_NAME } from "../version.js";
import { findBinary } from "./detect.js";
import { resolveApprovedCloudflaredPath } from "../recovery/probe.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "./provider.js";
import { tunnelProtocolArgs } from "./protocol.js";

const QUICK_TUNNEL_URL_RE = /https:\/\/[^\s|]+/gi;
const QUICK_TUNNEL_HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.trycloudflare\.com$/i;
const HEALTH_CHECK_INTERVAL_MS = 250;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const DEFAULT_START_TIMEOUT_MS = 90_000;
const DEFAULT_INITIAL_HEALTH_DELAY_MS = 15_000;
const envProxyAgent = new EnvHttpProxyAgent();

function configuredDuration(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isBridgeHealth(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const health = payload as Record<string, unknown>;
  return health.service === SERVICE_NAME && health.status === "ok";
}

async function bridgeHealth(
  fetchImpl: NonNullable<CloudflaredQuickTunnelOptions["fetchImpl"]>,
  publicUrl: string,
  useEnvironmentProxy: boolean
): Promise<{ ready: boolean; detail: string }> {
  const request = new URL("/health", publicUrl).toString();
  const options = {
    redirect: "error",
    signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
  } as const;
  const response = await (useEnvironmentProxy && (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY)
    ? proxyFetch(request, { ...options, dispatcher: envProxyAgent })
    : fetchImpl(request, options));
  if (!response) return { ready: false, detail: "Health check did not run" };
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { ready: false, detail: `Health check returned HTTP ${response.status}` };
  }
  return {
    ready: isBridgeHealth(await response.json().catch(() => null)),
    detail: `Health check did not identify ${SERVICE_NAME}`,
  };
}

/** Extract a Quick Tunnel public URL from a cloudflared log line. */
export function parseQuickTunnelUrl(line: string): string | null {
  for (const match of line.matchAll(QUICK_TUNNEL_URL_RE)) {
    try {
      const url = new URL(match[0]);
      if (url.protocol !== "https:" || !QUICK_TUNNEL_HOST_RE.test(url.hostname)) continue;
      if (url.hostname.toLowerCase() === "api.trycloudflare.com") continue;
      return url.origin;
    } catch {
      // Ignore malformed URLs embedded in log output.
    }
  }
  return null;
}

export interface CloudflaredQuickTunnelOptions {
  startTimeoutMs?: number;
  initialHealthDelayMs?: number;
  spawnImpl?: (
    command: string,
    args: string[],
    options: { stdio: ["ignore", "pipe", "pipe"]; windowsHide: true; env?: NodeJS.ProcessEnv }
  ) => ChildProcess;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  /** When set, disable PATH/profile discovery and use only this approved root. */
  managedCloudflaredDirectory?: string;
}

/**
 * Cloudflare Quick Tunnel provider.
 * Quick Tunnels need no account/login; the URL changes on every start,
 * which the bridge and the Skill handle by reconfiguring automatically.
 */
export class CloudflaredQuickTunnel implements TunnelProvider {
  readonly name = "cloudflare-quick";
  private child: ChildProcess | null = null;
  private url: string | null = null;
  private lastError: string | null = null;
  private readonly startTimeoutMs: number;
  private readonly initialHealthDelayMs: number;
  private readonly spawnImpl: NonNullable<CloudflaredQuickTunnelOptions["spawnImpl"]>;
  private readonly fetchImpl: NonNullable<CloudflaredQuickTunnelOptions["fetchImpl"]>;
  private readonly useEnvironmentProxy: boolean;
  private readonly managedCloudflaredDirectory?: string;
  private starting: Promise<string> | null = null;
  private cancelStart: (() => void) | null = null;
  private relay: ChildProcess | null = null;

  constructor(
    private readonly logger: Logger = nullLogger,
    private readonly binaryOverride?: string,
    options: CloudflaredQuickTunnelOptions = {}
  ) {
    this.startTimeoutMs = options.startTimeoutMs ?? configuredDuration("C2C_TUNNEL_START_TIMEOUT_MS", DEFAULT_START_TIMEOUT_MS);
    this.initialHealthDelayMs = options.initialHealthDelayMs ?? configuredDuration(
      "C2C_TUNNEL_HEALTH_INITIAL_DELAY_MS",
      DEFAULT_INITIAL_HEALTH_DELAY_MS
    );
    this.spawnImpl = options.spawnImpl ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.useEnvironmentProxy = options.fetchImpl === undefined;
    this.managedCloudflaredDirectory = options.managedCloudflaredDirectory;
  }

  private binary(): string | null {
    if (this.managedCloudflaredDirectory) {
      const approved = resolveApprovedCloudflaredPath(undefined, this.managedCloudflaredDirectory);
      return approved.status === "PASS" ? approved.path : null;
    }
    return this.binaryOverride ?? findBinary("cloudflared");
  }

  async start(localPort: number): Promise<string> {
    if (this.child && this.url) return this.url;
    if (this.starting) return this.starting;
    const starting = this.startProcess(localPort);
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  private startProcess(localPort: number): Promise<string> {
    const bin = this.binary();
    if (!bin) {
      return Promise.reject(
        new Error(
          "cloudflared is not installed. Install it (e.g. `brew install cloudflared`) and retry."
        )
      );
    }

    return this.startWithPreflight(localPort, bin);
  }

  private async startWithPreflight(localPort: number, bin: string): Promise<string> {
    let quickService = process.env.C2C_QUICK_SERVICE_URL?.trim();
    if (process.env.C2C_QUICK_SERVICE_RELAY === "1") {
      const proxyUrl = process.env.HTTP_PROXY ?? process.env.HTTPS_PROXY;
      if (!proxyUrl) throw new Error("C2C_PROXY_UNAVAILABLE: no proxy configured");
      const parsed = new URL(proxyUrl);
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(Number(parsed.port), parsed.hostname);
        socket.setTimeout(3000);
        socket.once("connect", () => { socket.destroy(); resolve(); });
        socket.once("timeout", () => { socket.destroy(); reject(new Error("C2C_PROXY_UNAVAILABLE: proxy timed out")); });
        socket.once("error", () => reject(new Error("C2C_PROXY_UNAVAILABLE: proxy connection failed")));
      });
      try {
        const agent = new ProxyAgent(proxyUrl);
        try {
        const response = await proxyFetch("https://api.trycloudflare.com/tunnel", {
          method: "GET", dispatcher: agent, signal: AbortSignal.timeout(8000),
        });
        await response.body?.cancel();
        } finally { await agent.close(); }
      } catch (error) {
        throw new Error(`C2C_PROXY_UNAVAILABLE: provisioning API unreachable: ${String(error)}`);
      }
      const relayPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../relay.cjs");
      const relay = fork(relayPath, ["serve"], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { ...process.env, C2C_RELAY_PROXY_URL: proxyUrl },
      });
      this.relay = relay;
      quickService = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("QUICK_SERVICE_RELAY_FAILED: relay startup timed out")), 5000);
        relay.once("message", (message: unknown) => {
          clearTimeout(timer);
          const port = (message as { port?: number })?.port;
          if (port) resolve(`http://127.0.0.1:${port}`);
          else reject(new Error("QUICK_SERVICE_RELAY_FAILED: invalid relay response"));
        });
        relay.once("error", (error) => { clearTimeout(timer); reject(new Error(`QUICK_SERVICE_RELAY_FAILED: ${error.message}`)); });
        relay.once("exit", () => { clearTimeout(timer); reject(new Error("QUICK_SERVICE_RELAY_FAILED: relay exited")); });
      }).catch((error) => { relay.kill(); this.relay = null; throw error; });
    }
    return new Promise<string>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawnImpl(
          bin,
          [
            "tunnel",
            "--url",
            `http://127.0.0.1:${localPort}`,
            "--no-autoupdate",
            ...(quickService ? ["--quick-service", quickService] : []),
            ...tunnelProtocolArgs(),
          ],
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env } }
        );
      } catch (error) {
        if (this.relay) { this.relay.kill(); this.relay = null; }
        reject(error);
        return;
      }
      this.child = child;
      this.url = null;
      this.lastError = null;
      let settled = false;
      let candidateUrl: string | null = null;
      let cancel: (() => void) | null = null;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const closeReaders = (): void => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      };

      const isAlive = (): boolean => this.child === child;

      const stopChild = (): void => {
        try {
          child.kill("SIGTERM");
        } catch {
          // The process may have exited between the state check and kill().
        }
      };

      const finish = (callback: () => void, closeOutput = true): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (closeOutput) closeReaders();
        if (cancel && this.cancelStart === cancel) this.cancelStart = null;
        callback();
      };

      const fail = (error: unknown): void => {
        finish(() => {
          stopChild();
          if (this.child === child) {
            this.child = null;
            this.url = null;
          }
          if (this.relay) { this.relay.kill(); this.relay = null; }
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      };

      cancel = () => fail(new Error("Tunnel start stopped"));
      this.cancelStart = cancel;

      const ready = (url: string): void => {
        if (!isAlive()) {
          fail(new Error("CLOUDFLARED_EDGE_FAILED: cloudflared exited before public health became ready"));
          return;
        }
        finish(
          () => {
            this.url = url;
            this.lastError = null;
            this.logger.info(`Quick tunnel established: ${url}`);
            resolve(url);
          },
          false
        );
      };

      const waitForHealth = async (): Promise<void> => {
        const publicUrl = candidateUrl;
        if (!publicUrl) return;
        while (!settled) {
          if (!isAlive()) {
            fail(new Error("CLOUDFLARED_EDGE_FAILED: cloudflared exited before public health became ready"));
            return;
          }

          try {
            const result = await bridgeHealth(this.fetchImpl, publicUrl, this.useEnvironmentProxy);
            if (settled) return;
            if (result.ready) {
              ready(publicUrl);
              return;
            }
            this.lastError = result.detail;
          } catch (error) {
            if (settled) return;
            const message = error instanceof Error ? error.message : String(error);
            const causeText = error instanceof Error && error.cause ? String(error.cause) : "";
            this.lastError = /ENOTFOUND|EAI_AGAIN|DNS/i.test(`${message} ${causeText}`)
              ? `QUICK_TUNNEL_DNS_NOT_READY: ${message}` : `PUBLIC_HEALTH_FAILED: ${message}`;
            const cause = error instanceof Error && error.cause ? `; cause: ${String(error.cause)}` : "";
            this.logger.debug(`Quick tunnel health check failed: ${this.lastError}${cause}`);
          }
          if (settled) return;
          await new Promise((resolveWait) => setTimeout(resolveWait, HEALTH_CHECK_INTERVAL_MS));
        }
      };

      timeout = setTimeout(() => {
        if (!settled) {
          this.logger.error(`Quick tunnel did not become ready within ${this.startTimeoutMs}ms`);
          const code = candidateUrl
            ? this.lastError?.startsWith("QUICK_TUNNEL_DNS_NOT_READY") ? "QUICK_TUNNEL_DNS_NOT_READY" : "PUBLIC_HEALTH_FAILED"
            : "QUICK_TUNNEL_ALLOCATION_FAILED";
          fail(new Error(`${code}: ${this.lastError ?? "Tunnel start timed out"}`));
        }
      }, this.startTimeoutMs);

      const scan = (stream: NodeJS.ReadableStream): void => {
        const rl = readline.createInterface({ input: stream });
        rl.on("line", (line) => {
          const url = parseQuickTunnelUrl(line);
          if (url && !candidateUrl) {
            candidateUrl = url;
            this.logger.info(
              `Quick tunnel URL issued: ${url}; waiting ${this.initialHealthDelayMs}ms before the first health check`
            );
            setTimeout(() => {
              void waitForHealth().catch((error) => {
                this.logger.error(`Quick tunnel health check failed: ${String(error)}`);
              });
            }, this.initialHealthDelayMs);
          }
          if (/\b(?:ERR|error|failed|fatal)\b/i.test(line)) {
            this.lastError = line.slice(0, 400);
            this.logger.warn(`cloudflared: ${line.slice(0, 400)}`);
          }
        });
      };
      if (child.stdout) scan(child.stdout);
      if (child.stderr) scan(child.stderr);

      child.on("error", (error) => {
        closeReaders();
        if (this.child === child) {
          this.child = null;
          this.url = null;
        }
        if (!settled) fail(error);
      });
      child.on("exit", (code) => {
        closeReaders();
        if (this.child === child) {
          this.child = null;
          this.url = null;
          this.lastError = this.lastError ?? `cloudflared exited (code ${code})`;
        }
        this.logger.warn(`cloudflared exited with code ${code}`);
        if (!settled) {
          fail(
            new Error(
              `CLOUDFLARED_EDGE_FAILED: cloudflared exited (code ${code}) before establishing a tunnel${this.lastError ? `: ${this.lastError}` : ""}`
            )
          );
        }
      });
    });
  }

  async stop(): Promise<void> {
    this.cancelStart?.();
    if (this.child) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // The process may have exited between the state check and kill().
      }
      this.child = null;
    }
    this.url = null;
    this.lastError = null;
    if (this.relay) { this.relay.kill(); this.relay = null; }
  }

  async restart(localPort: number): Promise<string> {
    await this.stop();
    return this.start(localPort);
  }

  status(): TunnelStatus {
    return {
      running: this.child !== null && this.url !== null,
      url: this.url,
      provider: this.name,
      detail: this.lastError ?? undefined,
    };
  }

  getPublicUrl(): string | null {
    return this.url;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    const bin = this.binary();
    const problems: string[] = [];
    if (!bin) problems.push("cloudflared binary not found");
    if (bin && !this.child) problems.push("tunnel process not running");
    if (this.child && !this.url) problems.push("tunnel running but no public URL yet");
    return {
      provider: this.name,
      binaryFound: bin !== null,
      binaryPath: bin,
      running: this.child !== null,
      url: this.url,
      problems,
    };
  }
}
