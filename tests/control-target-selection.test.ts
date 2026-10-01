import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveControlTargetProfile } from "../src/config/control-target-registry.js";
import { ControlTargetSelectionError, selectControlTargetProfile } from "../src/control-target-selection.js";
import { MOZI_CONTROL_TARGET_PROFILE } from "../src/control-target-profile.js";
import { Workspace } from "../src/workspace/manager.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-target-selection-"));
  roots.push(root);
  const controlWorkspaceRoot = path.join(root, "control");
  const controlStateDir = path.join(root, "control-state");
  const targetWorkspaceRoot = path.join(root, "target");
  const targetStateDir = path.join(root, "future-state", "target");
  const registryFile = path.join(root, "home", ".codex", "c2c-repair-control", "targets.json");
  fs.mkdirSync(controlWorkspaceRoot, { recursive: true });
  fs.mkdirSync(controlStateDir);
  fs.mkdirSync(targetWorkspaceRoot);
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  fs.writeFileSync(registryFile, JSON.stringify({
    schemaVersion: 1,
    profiles: [{
      schemaVersion: 1,
      profileId: "project-a",
      targetWorkspaceRoot,
      targetStateDir,
      expectedWorkspaceId: new Workspace(targetWorkspaceRoot).id,
    }],
  }));
  return { root, registryFile, controlWorkspaceRoot, controlStateDir, targetWorkspaceRoot, targetStateDir };
}

describe("CONTROL target selection", () => {
  it("selects and resolves a registered non-MOZI profile", () => {
    const value = fixture();
    const profileId = selectControlTargetProfile({ targetProfile: "project-a" });
    const resolved = resolveControlTargetProfile(profileId, value);
    expect(resolved.profileId).toBe("project-a");
    expect(fs.existsSync(value.targetStateDir)).toBe(false);
  });

  it("rejects an unknown profile during resolution without creating target state", () => {
    const value = fixture();
    const profileId = selectControlTargetProfile({ targetProfile: "missing" });
    expect(() => resolveControlTargetProfile(profileId, value)).toThrowError(/Unknown target profile/);
    expect(fs.existsSync(value.targetStateDir)).toBe(false);
  });

  it("accepts only the exact legacy MOZI path pair", () => {
    expect(selectControlTargetProfile({
      targetWorkspace: MOZI_CONTROL_TARGET_PROFILE.targetWorkspaceRoot,
      targetStateDir: MOZI_CONTROL_TARGET_PROFILE.targetStateDir,
    })).toBe("mozi");
    expect(() => selectControlTargetProfile({
      targetWorkspace: "D:\\other-project",
      targetStateDir: MOZI_CONTROL_TARGET_PROFILE.targetStateDir,
    })).toThrowError(new ControlTargetSelectionError("CONTROL_TARGET_PROFILE_IDENTITY_MISMATCH"));
  });

  it.each([
    ["profile combined with legacy arguments", { targetProfile: "project-a", targetWorkspace: MOZI_CONTROL_TARGET_PROFILE.targetWorkspaceRoot, targetStateDir: MOZI_CONTROL_TARGET_PROFILE.targetStateDir }],
    ["only one legacy argument", { targetWorkspace: MOZI_CONTROL_TARGET_PROFILE.targetWorkspaceRoot }],
    ["no target selected", {}],
  ])("blocks %s before target resolution", (_label, input) => {
    expect(() => selectControlTargetProfile(input)).toThrowError(ControlTargetSelectionError);
  });
});
