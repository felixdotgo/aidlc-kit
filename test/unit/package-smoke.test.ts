import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { packageVersion } from "../../src/workflow.js";

test("packed tarball initializes a clean local project without a registry install", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-package-smoke-"));
  try {
    const archiveDir = join(root, "archives"); mkdirSync(archiveDir);
    const npmCli = process.env.npm_execpath;
    assert.ok(npmCli, "npm_execpath is required to create the local package tarball");
    const packed = spawnSync(process.execPath, [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", archiveDir], { cwd: resolve("."), encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    const [{ filename }] = JSON.parse(packed.stdout) as Array<{ filename: string }>;
    const archive = join(archiveDir, filename);
    assert.ok(existsSync(archive), "npm pack did not create a local tarball");

    const extracted = join(root, "extracted"); mkdirSync(extracted);
    const untar = spawnSync("tar", ["-xzf", archive, "-C", extracted], { cwd: root, encoding: "utf8" });
    assert.equal(untar.status, 0, untar.stderr);
    const project = join(root, "project"); mkdirSync(project);
    const init = spawnSync(process.execPath, [join(extracted, "package", "dist", "src", "cli.js"), "init", project, "--agent", "codex", "--yes"], { cwd: root, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    assert.ok(existsSync(join(project, ".agents", "aidlc", "orchestrator.md")));
    assert.equal(JSON.parse(readFileSync(join(project, ".agents", "data", "state", "aidlc-state.json"), "utf8")).schemaVersion, 4);
    assert.ok(existsSync(join(project, ".agents", "data", "lessons", "index.json")));
    assert.ok(existsSync(join(project, ".agents", "aidlc", "scripts", "gate-view.mjs")));
    assert.ok(existsSync(join(project, ".agents", "aidlc", "scripts", "loop.mjs")));
    const cli = join(extracted, "package", "dist", "src", "cli.js");
    assert.ok(existsSync(join(extracted, "package", "docs", "architecture.md")));
    const status = spawnSync(process.execPath, [cli, "status", project], { cwd: root, encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr); assert.match(status.stdout, new RegExp(`installed version: ${packageVersion().replaceAll(".", "\\.")}`));
    const doctor = spawnSync(process.execPath, [cli, "doctor", project, "--strict"], { cwd: root, encoding: "utf8" });
    assert.equal(doctor.status, 0, doctor.stderr); assert.match(doctor.stdout, /^OK:/);

    const legacyProject = join(root, "legacy-project");
    mkdirSync(join(legacyProject, ".aidlc", "index"), { recursive: true });
    mkdirSync(join(legacyProject, ".aidlc", "rules"), { recursive: true });
    writeFileSync(join(legacyProject, ".aidlc", "index", "repo-map.md"), "legacy index\n");
    writeFileSync(join(legacyProject, ".aidlc", "rules", "custom.md"), "legacy rule\n");
    const legacyInit = spawnSync(process.execPath, [cli, "init", legacyProject, "--agent", "codex", "--yes"], { cwd: root, encoding: "utf8" });
    assert.equal(legacyInit.status, 0, legacyInit.stderr);
    assert.match(legacyInit.stdout, /migrated legacy data\. Backup:/);
    assert.equal(existsSync(join(legacyProject, ".aidlc")), false);
    assert.equal(readFileSync(join(legacyProject, ".agents", "data", "index", "repo-map.md"), "utf8"), "legacy index\n");
    assert.equal(readFileSync(join(legacyProject, ".agents", "project", "rules", "custom.md"), "utf8"), "legacy rule\n");
    assert.ok(existsSync(join(legacyProject, ".agents", "data", "state", "backups")));

    for (const path of [join(extracted, "package", "dist", "dev"), join(extracted, "package", "dist", "src", "eval.js"), join(extracted, "package", "dist", "src", "release.js"), join(extracted, "package", "dist", "assets", ".agents", "aidlc", "eval"), join(extracted, "package", "dist", "assets", ".agents", "aidlc", "schemas", "eval-suite.schema.json")]) assert.equal(existsSync(path), false, `${path} must be excluded from the tarball`);
    const evalCommand = spawnSync(process.execPath, [cli, "eval", "list", project], { cwd: root, encoding: "utf8" });
    assert.equal(evalCommand.status, 1); assert.match(evalCommand.stderr, /Unknown command/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
