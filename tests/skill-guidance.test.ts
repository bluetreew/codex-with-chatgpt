import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skill = fs.readFileSync(path.join(root, "skill", "SKILL.md"), "utf8");
const troubleshooting = fs.readFileSync(path.join(root, "docs", "troubleshooting.md"), "utf8").replace(/\r\n/g, "\n");
const emergency = fs.readFileSync(path.join(root, "skill", "c2c-emergency-recovery", "SKILL.md"), "utf8");

describe("C2C browser and Project binding guidance", () => {
  it("uses the official bundled browser-client", () => {
    expect(skill).toContain("browser-client.mjs");
    expect(skill).toContain("metadata.codexSessionId");
    expect(skill).toContain("setupBrowserRuntime({globals: globalThis})");
    expect(skill).toContain('agent.browsers.get("iab")');
  });
  it("uses browser-layer failure state instead of Bridge failure", () => {
    expect(skill).toContain("IAB_CONTROL_UNAVAILABLE");
    expect(skill).toContain("IAB_CONTROL_UNAVAILABLE");
    expect(skill).toContain("evidence of Bridge, MCP, Connector, or Tunnel failure");
  });
  it("reacquires the same browser tab after a kernel reset", () => {
    expect(skill).toContain("same `iab`");
    expect(skill).toContain("`tabs.get(id)`");
    expect(troubleshooting).toContain("Re-bootstrap after a kernel");
  });
  it("requires expected URL, controlled URL, and enabled composer before sending", () => {
    expect(skill).toContain("expectedChatUrl");
    expect(skill).toContain("actualTabUrl == expectedChatUrl");
    expect(skill).toContain("composer is present and enabled");
  });
  it("forbids blind resend after an uncertain send result", () => {
    expect(skill).toContain("If it is present, treat the send as committed and do not resend.");
    expect(troubleshooting).toContain("If presence is uncertain, stop without");
  });
  it("checks unique protocol markers before retrying", () => {
    expect(skill).toContain("`TASK_ID` + `STATE` + `ITERATION`");
    expect(troubleshooting).toContain("check the unique");
  });
  it("treats project-mode session URL and checkpoint as workspace-level hints", () => {
    expect(skill).toContain("it is not an authoritative binding for the current Codex thread");
    expect(skill).toContain("`THREAD_BINDING_UNKNOWN`");
    expect(troubleshooting).toContain("not proof of the current Codex thread's binding");
  });
  it("keeps Connector health, browser control, and thread delivery separate", () => {
    expect(skill).toContain("Connector → workspace (`workspace_info` identity)");
    expect(skill).toContain("IAB/browser page control");
    expect(troubleshooting).toContain("A healthy infrastructure with an IAB-only");
    expect(troubleshooting).toContain("unofficial browser bridge.");
  });
});

describe("official browser runtime recovery and installation", () => {
  it("declares the official Browser Runtime and bundled client as primary", () => {
    expect(skill).toContain("primary ChatGPT control surface is the official OpenAI Browser Runtime");
    expect(skill).toContain("browser-client.mjs");
    expect(skill).toContain("setupBrowserRuntime({globals: globalThis})");
    expect(skill).toContain('agent.browsers.get("iab")');
    expect(skill).toContain("Computer Use / CUA is not required by C2C");
  });
  it("gives emergency recovery an explicit official Browser Runtime contract", () => {
    expect(emergency).toContain("All ChatGPT page control in this recovery");
    expect(emergency).toContain("browser-client.mjs");
    expect(emergency).toContain("setupBrowserRuntime({globals: globalThis})");
    expect(emergency).toContain('agent.browsers.get("iab")');
    expect(emergency).toContain("Do not use");
    expect(emergency).toContain("cua.getTab()");
  });
  it("isolates Project-mode thread binding from workspace session.url", () => {
    expect(emergency).toContain("Workspace-level session.url alone is not authoritative.");
    expect(emergency).toContain("THREAD_BINDING_UNKNOWN");
    expect(emergency).toContain("explicit URL for this Codex conversation");
  });
  it("reclaims the existing exact-URL tab after a REPL reset", () => {
    expect(emergency).toContain("within the same Codex session must reacquire that session IAB");
    expect(emergency).toContain("reacquire that session IAB and its existing exact-URL tab");
    expect(emergency).toContain("This recovery path MUST NOT call tabs.new()");
  });
  it("keeps the Send Gate section singular", () => {
    expect(skill.split("### Send gate, timeout recovery, and health layers")).toHaveLength(2);
  });
  it("maps browser control failure to its browser-layer state", () => {
    expect(emergency).toContain("IAB_CONTROL_UNAVAILABLE");
    expect(emergency).toContain("A CUA timeout is");
    expect(emergency).toContain("not a Bridge finding");
  });
  it("syncs the full managed emergency package and preserves unmanaged artifacts", async () => {
    const os = await import("node:os");
    const { syncSkills } = await import("../scripts/sync-skills.mjs");
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-skill-sync-"));
    try {
      const fixtureRepo = path.join(temp, "repo");
      const home = path.join(temp, "codex-home");
      const emergencySource = path.join(fixtureRepo, "skill", "c2c-emergency-recovery");
      const emergencyTarget = path.join(home, "skills", "c2c-emergency-recovery");
      fs.mkdirSync(path.join(emergencySource, "scripts", "nested"), { recursive: true });
      fs.mkdirSync(emergencyTarget, { recursive: true });
      fs.writeFileSync(path.join(fixtureRepo, "skill", "SKILL.md"), "checkout=<ACTUAL_CHECKOUT_PATH>", "utf8");
      fs.writeFileSync(path.join(emergencySource, "SKILL.md"), "source guidance", "utf8");
      fs.writeFileSync(path.join(emergencySource, "scripts", "c2c-status.ps1"), "new wrapper", "utf8");
      fs.writeFileSync(path.join(emergencySource, "scripts", "nested", "helper.ps1"), "nested helper", "utf8");
      fs.writeFileSync(path.join(emergencyTarget, "SKILL.md"), "old guidance", "utf8");
      fs.mkdirSync(path.join(emergencyTarget, "scripts"), { recursive: true });
      fs.writeFileSync(path.join(emergencyTarget, "scripts", "c2c-status.ps1"), "stale wrapper", "utf8");
      fs.writeFileSync(path.join(emergencyTarget, "user-note.txt"), "preserve me", "utf8");

      const result = syncSkills({ repoRoot: fixtureRepo, codexHome: home });

      expect(result.emergencyPackageSync).toBe("PASS");
      expect(result.emergencyManagedFiles).toBe(3);
      expect(result.differingFiles).toEqual([]);
      expect(result.emergencyInstalledManifest).toEqual(result.emergencyManifest);
      expect(fs.readFileSync(path.join(home, "skills", "codex-with-chatgpt", "SKILL.md"), "utf8"))
        .toBe(`checkout=${fixtureRepo.split(path.sep).join("/")}`);
      expect(fs.readFileSync(path.join(emergencyTarget, "SKILL.md"), "utf8")).toBe("source guidance");
      expect(fs.readFileSync(path.join(emergencyTarget, "scripts", "c2c-status.ps1"), "utf8")).toBe("new wrapper");
      expect(fs.readFileSync(path.join(emergencyTarget, "scripts", "nested", "helper.ps1"), "utf8")).toBe("nested helper");
      expect(fs.readFileSync(path.join(emergencyTarget, "user-note.txt"), "utf8")).toBe("preserve me");
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});

describe("fresh Codex session tab lifecycle", () => {
  it("treats an empty fresh-session IAB as healthy and awaiting tab initialization", () => {
    expect(skill).toContain("empty tab list while the IAB exists means Browser Runtime health is PASS");
    expect(skill).toContain("TAB_INITIALIZATION_REQUIRED");
    expect(skill).toContain("not IAB_CONTROL_UNAVAILABLE");
  });
  it("creates exactly one tab only for a fresh session with an authoritative URL", () => {
    expect(skill).toContain("current session is fresh and the IAB tab list is empty");
    expect(skill).toContain("create exactly one tab with tab = await iab.tabs.new()");
    expect(skill).toContain("await tab.goto(expectedChatUrl)");
    expect(skill).toContain("await tab.url() == expectedChatUrl");
    expect(skill).toContain("Report a tab-control failure only if tabs.new(), navigation, actual-URL verification, or composer observation fails");
  });
  it("keeps same-session handle reset on the existing-tab path", () => {
    expect(skill).toContain("Same-session handle reset");
    expect(skill).toContain("This path MUST NOT call `tabs.new()`");
    expect(skill).toContain("bind the existing tab whose actual URL equals expectedChatUrl");
  });
  it("does not navigate from Project mode using workspace session.url alone", () => {
    expect(skill).toContain("workspace-level session.url alone is insufficient");
    expect(skill).toContain("THREAD_BINDING_UNKNOWN and do not call goto");
  });
  it("distinguishes browser-tab creation from ChatGPT conversation creation", () => {
    expect(skill).toContain("tabs.new() creates a browser tab for this Codex session; it does not create a ChatGPT conversation");
    expect(emergency).toContain("tabs.new() creates a browser tab in this Codex session; it does not create a ChatGPT conversation");
  });
  it("applies the same fresh-session lifecycle in emergency recovery and troubleshooting", () => {
    expect(emergency).toContain("newly started Codex session may receive a new IAB with an empty tab list");
    expect(emergency).toContain("create exactly one tab with tab = await iab.tabs.new()");
    expect(emergency).toContain("bind it with `tabs.get(id)`");
    expect(emergency).toContain("within the same Codex session must reacquire");
    expect(emergency).toContain("This recovery path MUST NOT call tabs.new()");
    expect(troubleshooting).toContain("### Fresh Codex session has an empty IAB tab list");
    expect(troubleshooting).toContain("create exactly one tab");
  });
});
