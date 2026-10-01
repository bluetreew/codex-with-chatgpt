import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { networkProcessEnv, readNetworkProfile, writeNetworkProfile } from "../src/config/network-profile.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()!); });

describe("workspace network profile", () => {
  it("persists outside the workspace and rebuilds child-only proxy settings", () => {
    dirs.push(isolateStateDir());
    const profile = {
      proxyUrl: "http://127.0.0.1:10809",
      tunnelProtocol: "http2" as const,
      quickServiceRelay: true,
      noProxy: "localhost,127.0.0.1,::1",
      cloudflaredPath: path.resolve("cloudflared"),
    };
    writeNetworkProfile("mozi", profile);
    expect(readNetworkProfile("mozi")).toEqual(profile);
    const base = { PATH: "test" };
    const child = networkProcessEnv(readNetworkProfile("mozi"), base);
    expect(base).toEqual({ PATH: "test" });
    expect(child.HTTP_PROXY).toBe(profile.proxyUrl);
    expect(child.https_proxy).toBe(profile.proxyUrl);
    expect(child.C2C_TUNNEL_PROTOCOL).toBe("http2");
    expect(child.C2C_QUICK_SERVICE_RELAY).toBe("1");
    expect(child.NO_PROXY).toBe(profile.noProxy);
  });
});
