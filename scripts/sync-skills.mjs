import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function listFiles(root, relative = '') {
  const directory = path.join(root, relative);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.posix.join(relative.replaceAll(path.sep, '/'), entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Skill package must not contain symlinks: ${child}`);
    if (entry.isDirectory()) return listFiles(root, child);
    if (!entry.isFile()) throw new Error(`Unsupported skill package entry: ${child}`);
    return [child];
  }).sort();
}

export function packageManifest(root) {
  return listFiles(root).map((relativePath) => {
    const content = fs.readFileSync(path.join(root, relativePath));
    return {
      path: relativePath,
      size: content.length,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
    };
  });
}

function syncPackage(source, destination) {
  const sourceManifest = packageManifest(source);
  for (const file of sourceManifest) {
    const from = path.join(source, file.path);
    const to = path.join(destination, file.path);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  const installedManifest = sourceManifest.map(({ path: relativePath }) => {
    const content = fs.readFileSync(path.join(destination, relativePath));
    return {
      path: relativePath,
      size: content.length,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
    };
  });
  const differingFiles = sourceManifest.filter((file, index) =>
    file.path !== installedManifest[index].path || file.sha256 !== installedManifest[index].sha256);
  if (differingFiles.length) throw new Error(`Emergency skill sync verification failed: ${differingFiles.map((file) => file.path).join(', ')}`);
  return { sourceManifest, installedManifest, differingFiles };
}

export function syncSkills({ repoRoot = path.resolve(scriptDir, '..'), codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex') } = {}) {
  const root = path.resolve(repoRoot);
  const home = path.resolve(codexHome);
  const mainSource = path.join(root, 'skill', 'SKILL.md');
  const emergencySource = path.join(root, 'skill', 'c2c-emergency-recovery');
  const mainTarget = path.join(home, 'skills', 'codex-with-chatgpt', 'SKILL.md');
  const emergencyTarget = path.join(home, 'skills', 'c2c-emergency-recovery');
  let mainText = fs.readFileSync(mainSource, 'utf8');
  mainText = mainText.replace('<ACTUAL_CHECKOUT_PATH>', root.split(path.sep).join('/'));
  fs.mkdirSync(path.dirname(mainTarget), { recursive: true });
  fs.writeFileSync(mainTarget, mainText, 'utf8');
  const emergency = syncPackage(emergencySource, emergencyTarget);
  const expectedMain = fs.readFileSync(mainTarget, 'utf8');
  if (expectedMain !== mainText) throw new Error('Main skill sync verification failed.');
  return {
    mainTarget,
    emergencyTarget,
    mainSkillSync: 'PASS',
    emergencyPackageSync: 'PASS',
    emergencyManagedFiles: emergency.sourceManifest.length,
    differingFiles: emergency.differingFiles,
    emergencyManifest: emergency.sourceManifest,
    emergencyInstalledManifest: emergency.installedManifest,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--repo', '--codex-home'].includes(key) || !args[i + 1]) throw new Error('Usage: node scripts/sync-skills.mjs [--repo PATH] [--codex-home PATH]');
    options[key === '--repo' ? 'repoRoot' : 'codexHome'] = args[i + 1];
  }
  const result = syncSkills(options);
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}
