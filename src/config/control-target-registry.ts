import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { MOZI_CONTROL_TARGET_PROFILE, type ControlTargetProfile, type ResolvedControlTargetProfile } from "../control-target-profile.js";
import { workspaceIdFromCanonicalRoot } from "../workspace/manager.js";
import { controlTargetRegistryFile, ensureDir, writeSecureJson } from "./paths.js";

const REGISTRY_SCHEMA_VERSION = 1;
const MAX_REGISTRY_BYTES = 256 * 1024;
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const WORKSPACE_ID = /^[a-f0-9]{12}$/;
const PROFILE_KEYS = ["schemaVersion", "profileId", "targetWorkspaceRoot", "targetStateDir", "expectedWorkspaceId"];
const REGISTRY_KEYS = ["schemaVersion", "profiles"];

export type ControlTargetRegistryErrorCode =
  | "CONTROL_TARGET_REGISTRY_INVALID"
  | "CONTROL_TARGET_PROFILE_NOT_FOUND"
  | "CONTROL_TARGET_PROFILE_IDENTITY_MISMATCH"
  | "CONTROL_TARGET_PATH_OVERLAP";

export class ControlTargetRegistryError extends Error {
  constructor(public readonly code: ControlTargetRegistryErrorCode, message: string) {
    super(message);
    this.name = "ControlTargetRegistryError";
  }
}

export interface ControlTargetRegistryOptions {
  /** Test seam; production commands always use controlTargetRegistryFile(). */
  registryFile?: string;
  /** Test seam for deterministic atomic replacement failure coverage. */
  replaceRegistry?: (temporaryFile: string, registryFile: string) => void;
}

export interface ResolveControlTargetProfileOptions extends ControlTargetRegistryOptions {
  controlWorkspaceRoot: string;
  controlStateDir: string;
}

function registryError(message: string): ControlTargetRegistryError {
  return new ControlTargetRegistryError("CONTROL_TARGET_REGISTRY_INVALID", message);
}

function profileError(message: string): ControlTargetRegistryError {
  return new ControlTargetRegistryError("CONTROL_TARGET_PROFILE_IDENTITY_MISMATCH", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => Object.hasOwn(value, key));
}

function hasDotSegments(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment === "." || segment === "..");
}

function isAbsoluteProfilePath(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

function pathApi(value: string): typeof path {
  return path.win32.isAbsolute(value) ? path.win32 : path.posix;
}

function pathKey(value: string): string {
  const api = pathApi(value);
  const normalized = api.normalize(value);
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin" || api === path.win32;
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function isSameOrDescendant(parent: string, candidate: string): boolean {
  if (pathApi(parent) !== pathApi(candidate)) return false;
  const api = pathApi(parent);
  const relative = api.relative(pathKey(parent), pathKey(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative));
}

function pathsOverlap(left: string, right: string): boolean {
  return isSameOrDescendant(left, right) || isSameOrDescendant(right, left);
}

function assertRegistryPathIsSafe(file: string): void {
  if (!path.isAbsolute(file) || hasDotSegments(file)) throw registryError("Target registry path must be absolute and canonical.");
  const absoluteFile = path.resolve(file);
  let current = path.dirname(absoluteFile);
  while (true) {
    if (fs.existsSync(current)) {
      let real: string;
      try {
        if (fs.lstatSync(current).isSymbolicLink()) throw registryError("Target registry cannot use a symlink or junction parent.");
        real = fs.realpathSync.native(current);
      } catch (error) {
        if (error instanceof ControlTargetRegistryError) throw error;
        throw registryError("Target registry parent cannot be canonicalized.");
      }
      if (!samePath(current, real)) throw registryError("Target registry cannot use a symlink or junction parent.");
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (fs.existsSync(absoluteFile)) {
    try {
      const metadata = fs.lstatSync(absoluteFile);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw registryError("Target registry must be a regular, non-symlink file.");
    } catch (error) {
      if (error instanceof ControlTargetRegistryError) throw error;
      throw registryError("Target registry cannot be inspected safely.");
    }
  }
}

function parseProfile(value: unknown): ControlTargetProfile {
  if (!isRecord(value) || !hasOnlyKeys(value, PROFILE_KEYS) || value.schemaVersion !== 1 ||
      typeof value.profileId !== "string" || !PROFILE_ID.test(value.profileId) ||
      typeof value.targetWorkspaceRoot !== "string" || !isAbsoluteProfilePath(value.targetWorkspaceRoot) || hasDotSegments(value.targetWorkspaceRoot) ||
      typeof value.targetStateDir !== "string" || !isAbsoluteProfilePath(value.targetStateDir) || hasDotSegments(value.targetStateDir) ||
      typeof value.expectedWorkspaceId !== "string" || !WORKSPACE_ID.test(value.expectedWorkspaceId)) {
    throw registryError("Target registry contains a malformed profile.");
  }
  return Object.freeze({
    schemaVersion: 1,
    profileId: value.profileId,
    targetWorkspaceRoot: value.targetWorkspaceRoot,
    targetStateDir: value.targetStateDir,
    expectedWorkspaceId: value.expectedWorkspaceId,
  });
}

function profilesExactlyEqual(left: ControlTargetProfile, right: ControlTargetProfile): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.profileId === right.profileId &&
    left.targetWorkspaceRoot === right.targetWorkspaceRoot &&
    left.targetStateDir === right.targetStateDir &&
    left.expectedWorkspaceId === right.expectedWorkspaceId;
}

function assertUniqueDeclaredIdentities(profiles: readonly ControlTargetProfile[]): void {
  const profileIds = new Set<string>();
  const workspaceIds = new Set<string>();
  const workspaceRoots = new Set<string>();
  const stateRoots = new Set<string>();
  for (const profile of profiles) {
    const workspaceRoot = pathKey(profile.targetWorkspaceRoot);
    const stateRoot = pathKey(profile.targetStateDir);
    if (profileIds.has(profile.profileId) || workspaceIds.has(profile.expectedWorkspaceId) ||
        workspaceRoots.has(workspaceRoot) || stateRoots.has(stateRoot)) {
      throw registryError("Target registry contains duplicate profile, workspace, or state-root identities.");
    }
    profileIds.add(profile.profileId);
    workspaceIds.add(profile.expectedWorkspaceId);
    workspaceRoots.add(workspaceRoot);
    stateRoots.add(stateRoot);
  }
}

function readRegistryProfiles(file: string): ControlTargetProfile[] {
  assertRegistryPathIsSafe(file);
  let text: string;
  try {
    const metadata = fs.lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_REGISTRY_BYTES) {
      throw registryError("Target registry must be a regular, non-symlink file under 256 KiB.");
    }
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if (error instanceof ControlTargetRegistryError) throw error;
    throw registryError("Target registry could not be read.");
  }

  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; }
  catch { throw registryError("Target registry is not valid JSON."); }
  if (!isRecord(parsed) || !hasOnlyKeys(parsed, REGISTRY_KEYS) || parsed.schemaVersion !== REGISTRY_SCHEMA_VERSION || !Array.isArray(parsed.profiles)) {
    throw registryError("Target registry must use schemaVersion 1 and contain only a profiles array.");
  }
  if (parsed.profiles.length > 128) throw registryError("Target registry contains too many profiles.");
  return parsed.profiles.map(parseProfile);
}

function mergeStoredProfiles(stored: readonly ControlTargetProfile[]): readonly ControlTargetProfile[] {
  const moziEntries = stored.filter((profile) => profile.profileId === MOZI_CONTROL_TARGET_PROFILE.profileId);
  if (moziEntries.length > 1 || (moziEntries.length === 1 && !profilesExactlyEqual(moziEntries[0], MOZI_CONTROL_TARGET_PROFILE))) {
    throw registryError("The built-in MOZI compatibility profile cannot be overridden.");
  }
  const profiles = [MOZI_CONTROL_TARGET_PROFILE, ...stored.filter((profile) => profile.profileId !== MOZI_CONTROL_TARGET_PROFILE.profileId)];
  assertUniqueDeclaredIdentities(profiles);
  return Object.freeze(profiles.map((profile) => Object.freeze({ ...profile })));
}

function mergedProfiles(options: ControlTargetRegistryOptions): readonly ControlTargetProfile[] {
  return mergeStoredProfiles(readRegistryProfiles(options.registryFile ?? controlTargetRegistryFile()));
}

/** Read the built-in MOZI profile and owner-local profiles without creating or changing state. */
export function listControlTargetProfiles(options: ControlTargetRegistryOptions = {}): readonly ControlTargetProfile[] {
  return mergedProfiles(options);
}

function canonicalExistingDirectory(value: string, label: string): string {
  if (!path.isAbsolute(value) || hasDotSegments(value)) throw profileError(`${label} must be an absolute canonical directory path.`);
  let real: string;
  try { real = fs.realpathSync.native(path.resolve(value)); }
  catch { throw profileError(`${label} does not exist or cannot be resolved.`); }
  try { if (!fs.statSync(real).isDirectory()) throw profileError(`${label} is not a directory.`); }
  catch (error) { if (error instanceof ControlTargetRegistryError) throw error; throw profileError(`${label} is not accessible.`); }
  if (!samePath(path.resolve(value), real)) throw profileError(`${label} is not canonical; symlink and junction aliases are not accepted.`);
  return real;
}

/** Canonicalize a directory that may not exist yet, using its deepest real existing parent. */
function canonicalFutureDirectory(value: string, label: string): string {
  if (!path.isAbsolute(value) || hasDotSegments(value)) throw profileError(`${label} must be an absolute canonical directory path.`);
  const requested = path.resolve(value);
  let existing = requested;
  const missingSegments: string[] = [];
  while (true) {
    try {
      if (!fs.statSync(existing).isDirectory()) throw profileError(`${label} has a non-directory parent.`);
      break;
    } catch (error) {
      if (error instanceof ControlTargetRegistryError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw profileError(`${label} parent is not accessible.`);
      const parent = path.dirname(existing);
      if (parent === existing) throw profileError(`${label} has no resolvable parent.`);
      missingSegments.unshift(path.basename(existing));
      existing = parent;
    }
  }
  let realParent: string;
  try { realParent = fs.realpathSync.native(existing); }
  catch { throw profileError(`${label} parent cannot be canonicalized.`); }
  const canonical = path.resolve(realParent, ...missingSegments);
  if (!samePath(requested, canonical)) throw profileError(`${label} traverses a symlink or junction alias.`);
  return canonical;
}

/** Resolve one registered profile and fail closed on identity or path overlap. This is read-only. */
function resolveProfileFromSet(
  profileId: string,
  profiles: readonly ControlTargetProfile[],
  options: ResolveControlTargetProfileOptions,
): ResolvedControlTargetProfile {
  const profile = profiles.find((candidate) => candidate.profileId === profileId);
  if (!profile) throw new ControlTargetRegistryError("CONTROL_TARGET_PROFILE_NOT_FOUND", `Unknown target profile: ${profileId}`);

  const targetWorkspaceRoot = canonicalExistingDirectory(profile.targetWorkspaceRoot, "Target workspace root");
  const workspaceId = workspaceIdFromCanonicalRoot(targetWorkspaceRoot);
  if (workspaceId !== profile.expectedWorkspaceId) throw profileError("Target workspaceId does not match the registered profile.");
  const targetStateDir = canonicalFutureDirectory(profile.targetStateDir, "Target state root");
  const controlWorkspaceRoot = canonicalExistingDirectory(options.controlWorkspaceRoot, "CONTROL workspace root");
  const controlStateDir = canonicalFutureDirectory(options.controlStateDir, "CONTROL state root");
  const protectedRoots = [controlWorkspaceRoot, controlStateDir];
  if (pathsOverlap(targetWorkspaceRoot, targetStateDir) || protectedRoots.some((root) =>
    pathsOverlap(root, targetWorkspaceRoot) || pathsOverlap(root, targetStateDir))) {
    throw new ControlTargetRegistryError("CONTROL_TARGET_PATH_OVERLAP", "Target paths overlap CONTROL or each other.");
  }

  for (const other of profiles) {
    if (other.profileId === profile.profileId) continue;
    if (other.expectedWorkspaceId === workspaceId) {
      throw registryError("Another profile claims the resolved workspaceId.");
    }
    let otherWorkspaceRoot: string | null = null;
    if (path.isAbsolute(other.targetWorkspaceRoot) && fs.existsSync(path.resolve(other.targetWorkspaceRoot))) {
      otherWorkspaceRoot = canonicalExistingDirectory(other.targetWorkspaceRoot, "Other registered workspace root");
    }
    let otherStateRoot: string | null = null;
    if (path.isAbsolute(other.targetStateDir) && fs.existsSync(path.parse(path.resolve(other.targetStateDir)).root)) {
      otherStateRoot = canonicalFutureDirectory(other.targetStateDir, "Other registered state root");
    }
    if ((otherWorkspaceRoot && (pathsOverlap(targetWorkspaceRoot, otherWorkspaceRoot) || pathsOverlap(targetStateDir, otherWorkspaceRoot))) ||
        (otherStateRoot && (pathsOverlap(targetWorkspaceRoot, otherStateRoot) || pathsOverlap(targetStateDir, otherStateRoot)))) {
      throw new ControlTargetRegistryError("CONTROL_TARGET_PATH_OVERLAP", "Resolved target overlaps another registered profile.");
    }
  }

  return Object.freeze({
    ...profile,
    targetWorkspaceRoot,
    targetStateDir,
    workspaceId,
  });
}

export function resolveControlTargetProfile(
  profileId: string,
  options: ResolveControlTargetProfileOptions,
): ResolvedControlTargetProfile {
  return resolveProfileFromSet(profileId, mergedProfiles(options), options);
}

/** Register a target by deriving its identity; this writes only the local registry. */
export function registerControlTargetProfile(
  profileId: string,
  targetWorkspaceRootInput: string,
  targetStateDirInput: string,
  options: ResolveControlTargetProfileOptions,
): ResolvedControlTargetProfile {
  if (!PROFILE_ID.test(profileId) || profileId === MOZI_CONTROL_TARGET_PROFILE.profileId) {
    throw registryError("Profile id is invalid or reserved for the built-in MOZI profile.");
  }
  const registryFile = options.registryFile ?? controlTargetRegistryFile();
  assertRegistryPathIsSafe(registryFile);
  const targetWorkspaceRoot = canonicalExistingDirectory(targetWorkspaceRootInput, "Target workspace root");
  const targetStateDir = canonicalFutureDirectory(targetStateDirInput, "Target state root");
  const candidate: ControlTargetProfile = Object.freeze({
    schemaVersion: 1,
    profileId,
    targetWorkspaceRoot,
    targetStateDir,
    expectedWorkspaceId: workspaceIdFromCanonicalRoot(targetWorkspaceRoot),
  });

  const lockFile = `${registryFile}.lock`;
  const directory = path.dirname(registryFile);
  ensureDir(directory);
  assertRegistryPathIsSafe(registryFile);
  let lockDescriptor: number;
  try { lockDescriptor = fs.openSync(lockFile, "wx", 0o600); }
  catch { throw registryError("Target registry is locked by another registration operation."); }

  let temporaryFile: string | null = null;
  try {
    const storedProfiles = readRegistryProfiles(registryFile);
    const existingProfiles = mergeStoredProfiles(storedProfiles);
    const nextStoredProfiles = [...storedProfiles, candidate];
    const nextProfiles = mergeStoredProfiles(nextStoredProfiles);
    const resolved = resolveProfileFromSet(profileId, nextProfiles, options);

    for (const other of existingProfiles) {
      let otherWorkspaceRoot: string | null = null;
      if (path.isAbsolute(other.targetWorkspaceRoot) && fs.existsSync(path.resolve(other.targetWorkspaceRoot))) {
        otherWorkspaceRoot = canonicalExistingDirectory(other.targetWorkspaceRoot, "Other registered workspace root");
      }
      let otherStateRoot: string | null = null;
      if (path.isAbsolute(other.targetStateDir) && fs.existsSync(path.parse(path.resolve(other.targetStateDir)).root)) {
        otherStateRoot = canonicalFutureDirectory(other.targetStateDir, "Other registered state root");
      }
      if ((otherWorkspaceRoot && (pathsOverlap(resolved.targetWorkspaceRoot, otherWorkspaceRoot) || pathsOverlap(resolved.targetStateDir, otherWorkspaceRoot))) ||
          (otherStateRoot && (pathsOverlap(resolved.targetWorkspaceRoot, otherStateRoot) || pathsOverlap(resolved.targetStateDir, otherStateRoot)))) {
        throw new ControlTargetRegistryError("CONTROL_TARGET_PATH_OVERLAP", "Registered target overlaps another profile.");
      }
    }

    temporaryFile = path.join(directory, `.targets.${process.pid}.${randomUUID()}.tmp`);
    writeSecureJson(temporaryFile, { schemaVersion: REGISTRY_SCHEMA_VERSION, profiles: nextStoredProfiles });
    (options.replaceRegistry ?? fs.renameSync)(temporaryFile, registryFile);
    return resolved;
  } catch (error) {
    if (temporaryFile) {
      try { fs.unlinkSync(temporaryFile); } catch { /* best effort cleanup */ }
    }
    if (error instanceof ControlTargetRegistryError) throw error;
    throw registryError("Target profile registration failed without replacing the existing registry.");
  } finally {
    try { fs.closeSync(lockDescriptor); } catch { /* best effort cleanup */ }
    try { fs.unlinkSync(lockFile); } catch { /* leave an unexpected lock visible for manual inspection */ }
  }
}
