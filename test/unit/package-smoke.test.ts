import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {workItem} from "./work-fixture.js";
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
    for (const operation of ['intake', 'checkpoint', 'restore']) {
      assert.ok(existsSync(join(project, '.agents', 'skills', `work-${operation}`, 'SKILL.md')));
      assert.ok(existsSync(join(project, '.agents', 'aidlc', 'work', `${operation}.md`)));
    }
    assert.ok(existsSync(join(project, '.agents', 'aidlc', 'scripts', 'work.mjs')));
    assert.ok(existsSync(join(project, '.agents', 'aidlc', 'schemas', 'work-item.schema.json')));
    const utility = spawnSync(process.execPath, [join(project, '.agents', 'aidlc', 'scripts', 'work.mjs'), 'preflight', '--root', project], {encoding: 'utf8', input: '{}'});
    assert.equal(utility.status, 1); assert.match(utility.stderr, /WORK_DISABLED/);
    const workScript=join(project,'.agents','aidlc','scripts','work.mjs');
    const localInit=spawnSync(process.execPath,[workScript,'init','--root',project],{encoding:'utf8',input:'{}'});
    assert.equal(localInit.status,0,localInit.stderr);assert.equal(JSON.parse(localInit.stdout).result.provider,'local');
    const localCheck=spawnSync(process.execPath,[workScript,'preflight','--root',project],{encoding:'utf8',input:'{}'});
    assert.equal(localCheck.status,0,localCheck.stderr);
    const createdWork=spawnSync(process.execPath,[workScript,'create','--root',project],{encoding:'utf8',input:JSON.stringify({item:workItem(),idempotencyKey:'installed-create'})});
    assert.equal(createdWork.status,0,createdWork.stderr);
    const ref=JSON.parse(createdWork.stdout).result.ref;
    assert.ok(existsSync(join(project,'.agents','data','work',ref.id,'events.jsonl')));
    for(const name of ['asana.mjs','trello.mjs'])assert.equal(existsSync(join(project,'.agents','aidlc','work','lib',name)),false);
    assert.equal(existsSync(join(extracted,'package','dist','services','aidlc-coordination','src','work-tools.mjs')),false);
    const claudeProject=join(root,'claude-project');mkdirSync(claudeProject);
    const claudeInit=spawnSync(process.execPath,[join(extracted,'package','dist','src','cli.js'),'init',claudeProject,'--agent','claude','--yes'],{encoding:'utf8'});
    assert.equal(claudeInit.status,0,claudeInit.stderr);
    for(const operation of ['intake','checkpoint','restore'])assert.ok(existsSync(join(claudeProject,'.claude','skills',`work-${operation}`,'SKILL.md')));
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
