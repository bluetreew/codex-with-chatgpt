import path from "node:path";
import { MOZI_CONTROL_TARGET_PROFILE } from "./control-target-profile.js";

export interface ControlTargetSelectionInput {
  targetProfile?: string;
  targetWorkspace?: string;
  targetStateDir?: string;
}

export type ControlTargetSelectionErrorCode =
  | "CONTROL_TARGET_PROFILE_REQUIRED"
  | "CONTROL_TARGET_PROFILE_IDENTITY_MISMATCH";

export class ControlTargetSelectionError extends Error {
  constructor(public readonly code: ControlTargetSelectionErrorCode) {
    super(code);
    this.name = "ControlTargetSelectionError";
  }
}

function sameCommandPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32" || process.platform === "darwin"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/** Select a registered profile or the exact legacy MOZI identity, before any bootstrap probe. */
export function selectControlTargetProfile(
  input: ControlTargetSelectionInput,
): string {
  const hasLegacyWorkspace = input.targetWorkspace !== undefined;
  const hasLegacyStateDir = input.targetStateDir !== undefined;
  if (hasLegacyWorkspace !== hasLegacyStateDir ||
      (input.targetProfile !== undefined && (hasLegacyWorkspace || hasLegacyStateDir))) {
    throw new ControlTargetSelectionError("CONTROL_TARGET_PROFILE_REQUIRED");
  }

  if (hasLegacyWorkspace && hasLegacyStateDir) {
    if (!sameCommandPath(input.targetWorkspace!, MOZI_CONTROL_TARGET_PROFILE.targetWorkspaceRoot) ||
        !sameCommandPath(input.targetStateDir!, MOZI_CONTROL_TARGET_PROFILE.targetStateDir)) {
      throw new ControlTargetSelectionError("CONTROL_TARGET_PROFILE_IDENTITY_MISMATCH");
    }
    return MOZI_CONTROL_TARGET_PROFILE.profileId;
  }

  if (!input.targetProfile) throw new ControlTargetSelectionError("CONTROL_TARGET_PROFILE_REQUIRED");
  return input.targetProfile;
}
