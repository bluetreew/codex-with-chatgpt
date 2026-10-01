import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptsRoot = path.join(root, "skill", "c2c-emergency-recovery", "scripts");
const emergencySkill = fs.readFileSync(path.join(root, "skill", "c2c-emergency-recovery", "SKILL.md"), "utf8");
const cli = fs.readFileSync(path.join(root, "src", "cli", "index.ts"), "utf8");

function declaredParameters(source: string): string[] {
  const block = source.match(/^param\(([\s\S]*?)^\)/m)?.[1];
  if (!block) throw new Error("PowerShell script has no top-level param block.");
  return [...block.matchAll(/\$([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]);
}

describe("emergency recovery package parameter contract", () => {
  const publicWrappers = [
    "c2c-status.ps1",
    "c2c-start-tunnel.ps1",
    "c2c-pair.ps1",
    "c2c-confirm.ps1",
  ];

  it("declares the documented mandatory profile parameter in every public wrapper", () => {
    const installedWrappers = fs.readdirSync(scriptsRoot)
      .filter((name) => name.endsWith(".ps1") && name !== "_common.ps1")
      .sort();
    expect(installedWrappers).toEqual([...publicWrappers].sort());

    for (const name of publicWrappers) {
      expect(emergencySkill, name).toContain(`scripts/${name} -TargetProfile`);
      const source = fs.readFileSync(path.join(scriptsRoot, name), "utf8");
      expect(declaredParameters(source), name).toContain("TargetProfile");
      expect(source.match(/^param\(([\s\S]*?)^\)/m)?.[1], name)
        .toMatch(/\[Parameter\(Mandatory\s*=\s*\$true\)\]\s*\[string\]\$TargetProfile/);
    }
  });

  it("maps wrapper profile resolution and recovery calls to the CLI's declared flags", () => {
    const common = fs.readFileSync(path.join(scriptsRoot, "_common.ps1"), "utf8");
    expect(declaredParameters(common)).toContain("TargetProfile");
    expect(common).toMatch(/'control-target'\s+'resolve'\s+'--profile'\s+\$TargetProfile/);

    const resolveCommand = cli.match(/controlTargetCmd\s+\.command\("resolve"\)([\s\S]*?)\.action\(/)?.[1];
    expect(resolveCommand).toBeDefined();
    expect(resolveCommand).toContain('.requiredOption("--profile <id>")');

    const status = fs.readFileSync(path.join(scriptsRoot, "c2c-status.ps1"), "utf8");
    const tunnel = fs.readFileSync(path.join(scriptsRoot, "c2c-start-tunnel.ps1"), "utf8");
    expect(declaredParameters(status)).toContain("ReadOnly");
    expect(status).toContain("if ($ReadOnly) { $planArgs += '--read-only' }");
    expect(status).toContain("'recovery-probe', '--target-profile', $TargetProfile");
    expect(status).toContain("'recovery-plan', '--target-profile', $TargetProfile");
    expect(tunnel).toContain("'recovery-replace-legacy-bridge', '--target-profile', $TargetProfile");

    for (const command of ["recovery-probe", "recovery-plan", "recovery-replace-legacy-bridge"]) {
      const commandBlock = cli.match(new RegExp(`\\.command\\("${command}"[\\s\\S]*?\\n\\s*\\.action\\(`))?.[0];
      expect(commandBlock, command).toContain('.requiredOption("--target-profile <id>")');
    }
  });

  it("routes pair and connector actions through a profile-validated preflight", () => {
    for (const name of ["c2c-pair.ps1", "c2c-confirm.ps1"]) {
      const source = fs.readFileSync(path.join(scriptsRoot, name), "utf8");
      expect(source, name).toMatch(/PSScriptRoot\\_common\.ps1"\s+-TargetProfile \$TargetProfile/);
      expect(source, name).toContain("c2c-status.ps1");
      expect(declaredParameters(source), name).toContain("TargetProfile");
    }
  });
});
