/** A trusted identity profile for the workspace a CONTROL recovery may inspect. */
export interface ControlTargetProfile {
  schemaVersion: 1;
  profileId: string;
  targetWorkspaceRoot: string;
  targetStateDir: string;
  expectedWorkspaceId: string;
}

/** A profile after path, overlap, and derived workspace identity validation. */
export interface ResolvedControlTargetProfile extends Readonly<ControlTargetProfile> {
  readonly workspaceId: string;
}

/** The original CONTROL → MOZI binding, retained as the compatibility profile. */
export const MOZI_CONTROL_TARGET_PROFILE: Readonly<ControlTargetProfile> = Object.freeze({
  schemaVersion: 1,
  profileId: "mozi",
  targetWorkspaceRoot: "D:\\workshop\\职业教育-MOZI",
  targetStateDir: "D:\\app_home\\codex-with-chatgpt-state",
  expectedWorkspaceId: "8b01a8558a23",
});
