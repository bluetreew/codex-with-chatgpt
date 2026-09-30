import type { ResolvedControlTargetProfile } from "../control-target-profile.js";

export interface RecoveryTargetBinding {
  profileId: string;
  workspaceId: string;
  workspaceRoot: string;
  stateDir: string;
}

export type RecoveryTargetBindingMatch = "MATCH" | "LEGACY_MOZI_UNBOUND" | "MISMATCH";

export function recoveryTargetBindingFromProfile(profile: ResolvedControlTargetProfile): RecoveryTargetBinding {
  return Object.freeze({
    profileId: profile.profileId,
    workspaceId: profile.workspaceId,
    workspaceRoot: profile.targetWorkspaceRoot,
    stateDir: profile.targetStateDir,
  });
}

export function matchRecoveryTargetBinding(
  stored: RecoveryTargetBinding | undefined,
  expected: RecoveryTargetBinding,
): RecoveryTargetBindingMatch {
  if (!stored) return expected.profileId === "mozi" ? "LEGACY_MOZI_UNBOUND" : "MISMATCH";
  return stored.profileId === expected.profileId &&
    stored.workspaceId === expected.workspaceId &&
    stored.workspaceRoot === expected.workspaceRoot &&
    stored.stateDir === expected.stateDir
    ? "MATCH"
    : "MISMATCH";
}
