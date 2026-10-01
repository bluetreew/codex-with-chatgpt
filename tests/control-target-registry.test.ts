import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { controlTargetRegistryFile } from "../src/config/paths.js";
import {
  ControlTargetRegistryError,
  listControlTargetProfiles,
  registerControlTargetProfile,
  resolveControlTargetProfile,
} from "../src/config/control-target-registry.js";
import { MOZI_CONTROL_TARGET_PROFILE, type ControlTargetProfile } from "../src/control-target-profile.js";
import { Workspace } from "../src/workspace/manager.js";

const roots: string[] = [];

const junctionFixtureSupported = (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-target-registry-junction-capability-"));
  try {
    fs.mkdirSync(path.join(root, "target"));
    fs.symlinkSync(path.join(root, "target"), path.join(root, "alias"), "junction");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-target-registry-"));
  roots.push(root);
  const home = path.join(root, "home");
  const controlWorkspaceRoot = path.join(root, "control-workspace");
  const controlStateDir = path.join(root, "control-state");
  const targetWorkspaceRoot = path.join(root, "target-a");
  const targetStateDir = path.join(root, "future-state", "target-a");
  const registryFile = path.join(home, ".codex", "c2c-repair-control", "targets.json");
  for (const directory of [home, controlWorkspaceRoot, controlStateDir, targetWorkspaceRoot]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const profile: ControlTargetProfile = {
    schemaVersion: 1,
    profileId: "project-a",
    targetWorkspaceRoot,
    targetStateDir,
    expectedWorkspaceId: new Workspace(targetWorkspaceRoot).id,
  };
  return { root, home, controlWorkspaceRoot, controlStateDir, targetWorkspaceRoot, targetStateDir, registryFile, profile };
}

function writeRegistry(file: string, profiles: unknown, schemaVersion = 1): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion, profiles }), "utf8");
}

function resolveOptions(value: ReturnType<typeof fixture>) {
  return {
    registryFile: value.registryFile,
    controlWorkspaceRoot: value.controlWorkspaceRoot,
    controlStateDir: value.controlStateDir,
  };
}

describe("CONTROL target registry", () => {
  it("places the registry under the canonical user-owned Codex directory", () => {
    const { home } = fixture();
    expect(controlTargetRegistryFile(home)).toBe(path.join(fs.realpathSync.native(home), ".codex", "c2c-repair-control", "targets.json"));
  });

  it("lists the built-in MOZI compatibility profile without creating the registry", () => {
    const value = fixture();
    const profiles = listControlTargetProfiles({ registryFile: value.registryFile });

    expect(profiles).toEqual([MOZI_CONTROL_TARGET_PROFILE]);
    expect(fs.existsSync(value.registryFile)).toBe(false);
    expect(fs.existsSync(path.dirname(value.registryFile))).toBe(false);
  });

  it("merges registered profiles and deduplicates an identical built-in MOZI entry", () => {
    const value = fixture();
    writeRegistry(value.registryFile, [MOZI_CONTROL_TARGET_PROFILE, value.profile]);

    expect(listControlTargetProfiles({ registryFile: value.registryFile })).toEqual([
      MOZI_CONTROL_TARGET_PROFILE,
      value.profile,
    ]);
  });

  it("rejects a conflicting attempt to override the built-in MOZI profile", () => {
    const value = fixture();
    writeRegistry(value.registryFile, [{
      ...MOZI_CONTROL_TARGET_PROFILE,
      targetStateDir: path.join(value.root, "other-state"),
    }]);

    expect(() => listControlTargetProfiles({ registryFile: value.registryFile }))
      .toThrowError(/built-in MOZI compatibility profile cannot be overridden/);
  });

  it.each([
    ["invalid JSON", "{"],
    ["unsupported registry schema", JSON.stringify({ schemaVersion: 2, profiles: [] })],
    ["extra registry fields", JSON.stringify({ schemaVersion: 1, profiles: [], secret: "not allowed" })],
    ["profile secret fields", JSON.stringify({ schemaVersion: 1, profiles: [{ ...MOZI_CONTROL_TARGET_PROFILE, token: "not allowed" }] })],
  ])("rejects %s", (_name, contents) => {
    const value = fixture();
    fs.mkdirSync(path.dirname(value.registryFile), { recursive: true });
    fs.writeFileSync(value.registryFile, contents, "utf8");

    expect(() => listControlTargetProfiles({ registryFile: value.registryFile }))
      .toThrowError(ControlTargetRegistryError);
  });

  it("rejects duplicate profile ids, workspace ids, and state roots", () => {
    const value = fixture();
    const profileB = {
      ...value.profile,
      profileId: "project-b",
      targetWorkspaceRoot: path.join(value.root, "target-b"),
      targetStateDir: path.join(value.root, "future-state", "target-b"),
    };
    fs.mkdirSync(profileB.targetWorkspaceRoot, { recursive: true });
    const duplicateId = { ...profileB, profileId: value.profile.profileId };
    const duplicateWorkspaceId = { ...profileB, expectedWorkspaceId: value.profile.expectedWorkspaceId };
    const duplicateState = { ...profileB, targetStateDir: value.profile.targetStateDir };

    for (const entries of [[value.profile, duplicateId], [value.profile, duplicateWorkspaceId], [value.profile, duplicateState]]) {
      writeRegistry(value.registryFile, entries);
      expect(() => listControlTargetProfiles({ registryFile: value.registryFile }))
        .toThrowError(/duplicate profile, workspace, or state-root identities/);
    }
  });

  it("resolves a registered profile by canonical root and derived workspaceId without creating state", () => {
    const value = fixture();
    writeRegistry(value.registryFile, [value.profile]);

    const resolved = resolveControlTargetProfile(value.profile.profileId, resolveOptions(value));

    expect(resolved).toMatchObject({
      schemaVersion: 1,
      profileId: "project-a",
      targetWorkspaceRoot: fs.realpathSync.native(value.targetWorkspaceRoot),
      targetStateDir: path.join(value.root, "future-state", "target-a"),
      expectedWorkspaceId: value.profile.expectedWorkspaceId,
      workspaceId: new Workspace(value.targetWorkspaceRoot).id,
    });
    expect(fs.existsSync(value.targetStateDir)).toBe(false);
  });

  it("registers a target with a derived workspaceId and writes only the temporary registry", () => {
    const value = fixture();
    const secondWorkspaceRoot = path.join(value.root, "target-b");
    const secondStateDir = path.join(value.root, "future-state", "target-b");
    fs.mkdirSync(secondWorkspaceRoot);

    const registered = registerControlTargetProfile("project-b", secondWorkspaceRoot, secondStateDir, resolveOptions(value));

    expect(registered).toMatchObject({
      profileId: "project-b",
      targetWorkspaceRoot: fs.realpathSync.native(secondWorkspaceRoot),
      targetStateDir: secondStateDir,
      expectedWorkspaceId: new Workspace(secondWorkspaceRoot).id,
      workspaceId: new Workspace(secondWorkspaceRoot).id,
    });
    expect(listControlTargetProfiles({ registryFile: value.registryFile })).toHaveLength(2);
    expect(fs.existsSync(secondStateDir)).toBe(false);
    if (process.platform !== "win32") expect(fs.statSync(value.registryFile).mode & 0o777).toBe(0o600);
  });

  it("rejects reserved and duplicate registration without changing the existing registry", () => {
    const value = fixture();
    writeRegistry(value.registryFile, [value.profile]);
    const original = fs.readFileSync(value.registryFile, "utf8");

    expect(() => registerControlTargetProfile("mozi", value.targetWorkspaceRoot, value.targetStateDir, resolveOptions(value)))
      .toThrowError(/invalid or reserved/);
    expect(() => registerControlTargetProfile("project-b", value.targetWorkspaceRoot, path.join(value.root, "other-state"), resolveOptions(value)))
      .toThrowError(ControlTargetRegistryError);
    expect(fs.readFileSync(value.registryFile, "utf8")).toBe(original);
    expect(fs.existsSync(path.join(value.root, "other-state"))).toBe(false);
  });

  it("keeps the old registry and removes temp and lock files when atomic replacement fails", () => {
    const value = fixture();
    writeRegistry(value.registryFile, [value.profile]);
    const original = fs.readFileSync(value.registryFile, "utf8");
    const secondWorkspaceRoot = path.join(value.root, "target-b");
    fs.mkdirSync(secondWorkspaceRoot);

    expect(() => registerControlTargetProfile("project-b", secondWorkspaceRoot, path.join(value.root, "future-state", "target-b"), {
      ...resolveOptions(value),
      replaceRegistry: () => { throw new Error("simulated replace failure"); },
    })).toThrowError(/failed without replacing the existing registry/);

    expect(fs.readFileSync(value.registryFile, "utf8")).toBe(original);
    expect(fs.existsSync(`${value.registryFile}.lock`)).toBe(false);
    expect(fs.readdirSync(path.dirname(value.registryFile)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(fs.existsSync(path.join(value.root, "future-state", "target-b"))).toBe(false);
  });

  it("returns a structured overlap error when registering a CONTROL path", () => {
    const value = fixture();
    try {
      registerControlTargetProfile("project-b", value.controlWorkspaceRoot, path.join(value.root, "other-state"), resolveOptions(value));
      throw new Error("expected registration to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ControlTargetRegistryError);
      expect((error as ControlTargetRegistryError).code).toBe("CONTROL_TARGET_PATH_OVERLAP");
    }
    expect(fs.existsSync(value.registryFile)).toBe(false);
    expect(fs.existsSync(path.join(value.root, "other-state"))).toBe(false);
  });

  it("rejects unknown profiles and workspaceId mismatches", () => {
    const value = fixture();
    writeRegistry(value.registryFile, [{ ...value.profile, expectedWorkspaceId: "000000000000" }]);

    expect(() => resolveControlTargetProfile("missing", resolveOptions(value)))
      .toThrowError(/Unknown target profile/);
    expect(() => resolveControlTargetProfile(value.profile.profileId, resolveOptions(value)))
      .toThrowError(/workspaceId does not match/);
    expect(fs.existsSync(value.targetStateDir)).toBe(false);
  });

  it("rejects target paths that overlap CONTROL or each other", () => {
    const value = fixture();
    const candidates = [
      { ...value.profile, targetStateDir: value.controlStateDir },
      {
        ...value.profile,
        targetWorkspaceRoot: value.controlWorkspaceRoot,
        expectedWorkspaceId: new Workspace(value.controlWorkspaceRoot).id,
      },
      { ...value.profile, targetStateDir: value.targetWorkspaceRoot },
    ];
    for (const profile of candidates) {
      writeRegistry(value.registryFile, [profile]);
      expect(() => resolveControlTargetProfile(profile.profileId, resolveOptions(value)))
        .toThrowError(/overlap CONTROL or each other/);
    }
  });

  it("rejects traversal paths before resolving a profile", () => {
    const value = fixture();
    writeRegistry(value.registryFile, [{ ...value.profile, targetStateDir: `${value.root}${path.sep}..${path.sep}escape` }]);

    expect(() => listControlTargetProfiles({ registryFile: value.registryFile }))
      .toThrowError(/malformed profile/);
  });

  it.skipIf(!junctionFixtureSupported)("rejects workspace junction aliases", () => {
    const value = fixture();
    const alias = path.join(value.root, "target-alias");
    fs.symlinkSync(value.targetWorkspaceRoot, alias, "junction");
    writeRegistry(value.registryFile, [{ ...value.profile, targetWorkspaceRoot: alias }]);

    expect(() => resolveControlTargetProfile(value.profile.profileId, resolveOptions(value)))
      .toThrowError(/symlink and junction aliases are not accepted/);
  });

  it.skipIf(!junctionFixtureSupported)("rejects state-root aliases that collide with another registered profile", () => {
    const value = fixture();
    fs.mkdirSync(value.targetStateDir, { recursive: true });
    const alias = path.join(value.root, "state-alias");
    fs.symlinkSync(value.targetStateDir, alias, "junction");
    const secondWorkspaceRoot = path.join(value.root, "target-b");
    fs.mkdirSync(secondWorkspaceRoot);
    const secondProfile: ControlTargetProfile = {
      schemaVersion: 1,
      profileId: "project-b",
      targetWorkspaceRoot: secondWorkspaceRoot,
      targetStateDir: alias,
      expectedWorkspaceId: new Workspace(secondWorkspaceRoot).id,
    };
    writeRegistry(value.registryFile, [value.profile, secondProfile]);

    expect(() => resolveControlTargetProfile(value.profile.profileId, resolveOptions(value)))
      .toThrowError(/symlink or junction alias/);
  });
});
