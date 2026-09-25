import { describe, it, expect, afterEach } from "vitest";
import {
  connectorAction,
  confirmedConnectorUrl,
  confirmConnector,
  connectorNameFor,
  DEFAULT_CONNECTOR_NAME,
  mcpUrlFromPublic,
  normalizePublicUrl,
  reclaimUserMessage,
  writeLastEndpoint,
  readLastEndpoint,
} from "../src/config/endpoint.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const stateDirs: string[] = [];
afterEach(() => { while (stateDirs.length) cleanup(stateDirs.pop()!); });

describe("connector confirmation", () => {
  it("keeps a pending update across repeated doctor runs until the new URL is confirmed", () => {
    stateDirs.push(isolateStateDir());
    const previous = writeLastEndpoint({ workspaceId: "mozi", port: 48765, publicUrl: "https://old.trycloudflare.com", mcpUrl: "https://old.trycloudflare.com/mcp" });
    expect(confirmedConnectorUrl(previous)).toBe(previous.mcpUrl);
    writeLastEndpoint({ workspaceId: "mozi", port: 48765, publicUrl: "https://new.trycloudflare.com", mcpUrl: "https://new.trycloudflare.com/mcp", connectorConfirmedMcpUrl: confirmedConnectorUrl(previous) });
    expect(connectorAction(confirmedConnectorUrl(readLastEndpoint("mozi")), readLastEndpoint("mozi")?.mcpUrl)).toBe("update");
    expect(() => confirmConnector("mozi", "https://wrong.trycloudflare.com/mcp")).toThrow();
    confirmConnector("mozi", "https://new.trycloudflare.com/mcp");
    expect(connectorAction(confirmedConnectorUrl(readLastEndpoint("mozi")), readLastEndpoint("mozi")?.mcpUrl)).toBe("none");
  });
});

describe("connectorAction", () => {
  it("creates on the first successful URL", () => {
    expect(connectorAction(null, "https://a.trycloudflare.com/mcp")).toBe("create");
  });

  it("is a no-op when the URL is unchanged", () => {
    expect(connectorAction("https://a.trycloudflare.com/mcp", "https://a.trycloudflare.com/mcp/")).toBe("none");
  });

  it("updates when the old address was reclaimed", () => {
    expect(connectorAction("https://old.trycloudflare.com/mcp", "https://new.trycloudflare.com/mcp")).toBe("update");
    expect(reclaimUserMessage("Codex with ChatGPT")).toContain("删除");
    expect(reclaimUserMessage("Codex with ChatGPT")).not.toContain("Reconnect");
  });

  it("does nothing without a next URL", () => {
    expect(connectorAction("https://a.trycloudflare.com/mcp", null)).toBe("none");
  });
});

describe("connectorNameFor", () => {
  it("keeps a stored name for the same workspace", () => {
    expect(
      connectorNameFor({
        workspaceName: "EchoMind",
        workspaceId: "abc123abc123",
        previousName: "Codex with ChatGPT",
        hadEndpointBefore: true,
      })
    ).toBe(DEFAULT_CONNECTOR_NAME);
  });

  it("keeps the legacy title when this workspace was used before the name field existed", () => {
    expect(
      connectorNameFor({
        workspaceName: "EchoMind",
        workspaceId: "abc123abc123",
        hadEndpointBefore: true,
      })
    ).toBe(DEFAULT_CONNECTOR_NAME);
  });

  it("gives a new workspace its own connector title", () => {
    expect(
      connectorNameFor({
        workspaceName: "Landing",
        workspaceId: "def456def456",
        hadEndpointBefore: false,
      })
    ).toBe("Codex with ChatGPT · Landing");
  });
});

describe("mcpUrlFromPublic", () => {
  it("appends /mcp and folds case/slash variants", () => {
    expect(mcpUrlFromPublic("https://A.trycloudflare.com/")).toBe("https://a.trycloudflare.com/mcp");
    expect(mcpUrlFromPublic("https://a.trycloudflare.com/mcp")).toBe("https://a.trycloudflare.com/mcp");
    expect(normalizePublicUrl("https://A.trycloudflare.com/")).toBe("https://a.trycloudflare.com");
  });
});
