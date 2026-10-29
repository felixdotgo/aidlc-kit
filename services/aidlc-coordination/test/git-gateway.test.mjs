import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGitGateway } from "../src/git-gateway.mjs";
const git=(cwd,...args)=>execFileSync("git",args,{cwd,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
const token="x".repeat(64);
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),"aidlc-gateway-")); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const repo=join(dir,"bare"), work=join(dir,"work"); mkdirSync(repo); git(repo,"init","--bare"); git(dir,"clone",repo,work); git(work,"checkout","-b","main");
  writeFileSync(join(work,"a"),"one"); git(work,"add","a"); git(work,"-c","user.name=Test","-c","user.email=test@test","commit","-m","one"); const oldCommit=git(work,"rev-parse","HEAD"); git(work,"push","origin","HEAD:refs/heads/main");
  writeFileSync(join(work,"a"),"two"); git(work,"add","a"); git(work,"-c","user.name=Test","-c","user.email=test@test","commit","-m","two"); const newCommit=git(work,"rev-parse","HEAD"); git(work,"push","origin","HEAD:refs/heads/objects-staging");
  return {repo,oldCommit,newCommit};
}
function fakeAuthority() {
  const records=new Map(); let valid=true, active=false, failComplete=false;
  return {
    records, setValid:(value)=>{valid=value;}, failComplete:()=>{failComplete=true;},
    async prepareGitOperation(input) { if(!valid || input.ownerToken!==token) throw new Error("stale fence"); const {ownerToken,...operation}=input; const old=records.get(operation.operationId); if(old && JSON.stringify(old.record)!==JSON.stringify(operation)) throw new Error("operation conflict"); if(!old) records.set(operation.operationId,{record:operation,status:"pending"}); return records.get(operation.operationId); },
    async withGitFence(input, callback) { if(!valid || input.ownerToken!==token || active) throw new Error("stale fence"); active=true; try { const stored=records.get(input.operationId); return await callback({record:stored.record,assertValid:async ()=>{if(!valid) throw new Error("stale fence");},complete:async ()=>{if(failComplete) throw new Error("crash"); stored.status="complete";}}); } finally {active=false;} }
  };
}
test("gateway fences, CAS updates, and idempotently returns a completed operation", async (t) => {
  const {repo,oldCommit,newCommit}=fixture(t), authority=fakeAuthority();
  const gateway=createGitGateway({repo,protectedRefs:["refs/heads/main"],authority});
  const req={workspace:"w",taskId:"t",epoch:1,ownerToken:token,operationId:"one",ref:"refs/heads/main",oldCommit,newCommit};
  await assert.rejects(()=>gateway.update({...req,ownerToken:"y".repeat(64)}),/stale fence/);
  await assert.rejects(()=>gateway.update({...req,ref:"refs/heads/objects-staging"}),/Invalid protected/);
  assert.equal((await gateway.update(req)).status,"complete"); assert.equal(git(repo,"rev-parse","refs/heads/main"),newCommit);
  assert.equal((await gateway.update(req)).status,"complete");
  await assert.rejects(()=>gateway.update({...req,epoch:2}),/operation conflict/);
});
test("pending intent after ref update and failed authority commit fails closed", async (t) => {
  const {repo,oldCommit,newCommit}=fixture(t), authority=fakeAuthority(); const gateway=createGitGateway({repo,protectedRefs:["refs/heads/main"],authority});
  const req={workspace:"w",taskId:"t",epoch:1,ownerToken:token,operationId:"one",ref:"refs/heads/main",oldCommit,newCommit};
  authority.failComplete(); await assert.rejects(()=>gateway.update(req),/authority commit uncertain/);
  assert.equal(git(repo,"rev-parse","refs/heads/main"),newCommit); assert.equal(authority.records.get("one").status,"pending");
  await assert.rejects(()=>gateway.update(req),/outcome uncertain/);
});
test("ref moved before the lease-locked CAS is rejected", async (t) => {
  const {repo,oldCommit,newCommit}=fixture(t), authority=fakeAuthority(); const gateway=createGitGateway({repo,protectedRefs:["refs/heads/main"],authority});
  git(repo,"update-ref","refs/heads/main",newCommit,oldCommit);
  await assert.rejects(()=>gateway.update({workspace:"w",taskId:"t",epoch:1,ownerToken:token,operationId:"race",ref:"refs/heads/main",oldCommit,newCommit}),/outcome uncertain/);
  assert.equal(authority.records.get("race").status,"pending");
});

test("lease loss after durable intent prevents Git ref update", async (t) => {
  const {repo,oldCommit,newCommit}=fixture(t), authority=fakeAuthority();
  const prepare=authority.prepareGitOperation;
  authority.prepareGitOperation=async (input)=>{const result=await prepare(input);authority.setValid(false);return result;};
  const gateway=createGitGateway({repo,protectedRefs:["refs/heads/main"],authority});
  await assert.rejects(()=>gateway.update({workspace:"w",taskId:"t",epoch:1,ownerToken:token,operationId:"expiry",ref:"refs/heads/main",oldCommit,newCommit}),/stale fence/);
  assert.equal(git(repo,"rev-parse","refs/heads/main"),oldCommit);
  assert.equal(authority.records.get("expiry").status,"pending");
});

test("SQLite authority holds its real lease while gateway updates the Git ref", async (t) => {
  const {repo,oldCommit,newCommit}=fixture(t);
  const {SqliteFleetRepository,applyFleetCommand}=await import("../src/fleet.mjs");
  const authority=new SqliteFleetRepository(":memory:");
  t.after(()=>authority.close());
  await authority.get("w");
  const supervisorToken="s".repeat(64);
  let fleet={schemaVersion:1,features:{},leads:{},jobs:{}};
  fleet=applyFleetCommand(fleet,{type:"supervisor_claim",taskId:"t",leaseMs:60000,ownerToken:supervisorToken},"lead","lead");
  fleet=applyFleetCommand(fleet,{type:"run_claim",taskId:"t",leaseMs:60000,ownerToken:token,supervisorEpoch:1,supervisorOwnerToken:supervisorToken},"lead","lead");
  authority.db.prepare("UPDATE fleet_workspaces SET fleet=? WHERE workspace=?").run(JSON.stringify(fleet),"w");
  const gateway=createGitGateway({repo,protectedRefs:["refs/heads/main"],authority});
  const request={workspace:"w",taskId:"t",epoch:1,ownerToken:token,operationId:"actual",ref:"refs/heads/main",oldCommit,newCommit};
  assert.equal((await gateway.update(request)).status,"complete");
  assert.equal((await authority.getGitOperation({workspace:"w",operationId:"actual"})).status,"complete");
  assert.equal(git(repo,"rev-parse","refs/heads/main"),newCommit);
});
