import assert from "node:assert/strict";
import test from "node:test";
import { FleetConflict, PostgresFleetRepository, SqliteFleetRepository, applyFleetCommand, featureReady, validateCanonicalFeature, validateFeature } from "../src/fleet.mjs";
import { PostgresStateRepository, SqliteStateRepository } from "../src/repository.mjs";
import { callTool } from "../src/fleet-client.mjs";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PostgresCoordinationRepository } from "../src/coordination.mjs";

const sha = "a".repeat(40);
const task = { id: "T1", title: "First", type: "infra", phase: "clarify", gate: "G0_confirm", status: "blocked_on_user", language: "en", risk: "normal", areas: ["root"], branch: "—", artifacts: { intent: ".agents/data/tasks/T1/intent.md", design: ".agents/data/tasks/T1/design.md", workplan: ".agents/data/tasks/T1/workplan.md" }, decisions: [], tasks: [], evidence: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };

test("feature graph rejects missing dependencies and cycles and derives ready work", () => {
  const manifest = validateFeature({ id: "F1", integrationBranch: "feature/one", tasks: [{ id: "T1", dependsOn: [] }, { id: "T2", dependsOn: ["T1"] }] });
  assert.deepEqual(featureReady(manifest, []).map((item) => item.ready), [true, false]);
  assert.deepEqual(featureReady(manifest, ["T1"]).map((item) => item.ready), [false, true]);
  assert.throws(() => validateFeature({ ...manifest, tasks: [{ id: "T1", dependsOn: ["T2"] }, { id: "T2", dependsOn: ["T1"] }] }), /cycle/);
  assert.throws(() => validateFeature({ ...manifest, tasks: [{ id: "T1", dependsOn: ["missing"] }] }), /unknown feature dependency/);
  assert.deepEqual(validateCanonicalFeature(manifest,{tasks:{T1:{featureId:"F1"},T2:{featureId:"F1"}}}),manifest);
  assert.throws(() => validateCanonicalFeature(manifest,{tasks:{T1:{featureId:"F1"}}}),/does not exist in canonical state/);
  assert.throws(() => validateCanonicalFeature(manifest,{tasks:{T1:{featureId:"F1"},T2:{featureId:"other"}}}),/another feature/);
});

test("fleet claims fence stale leads and workers, persist checkpoints, and replay idempotently", async () => {
  const repo = new SqliteFleetRepository(":memory:");
  try {
    const feature = await repo.apply("w", 0, "feature", "lead", "lead", { type: "feature_apply", feature: { id: "F1", integrationBranch: "feature/one", tasks: [{ id: "T1", dependsOn: [] }] } });
    assert.equal(feature.fleet.features.F1.revision, 1);
    const claimed = await repo.apply("w", 1, "lead-1", "lead", "lead", { type: "run_claim", taskId: "T1", leaseMs: 60000 });
    assert.equal(claimed.fleet.leads.T1.epoch, 1);
    const retry = await repo.apply("w", 1, "lead-1", "lead", "lead", { type: "run_claim", taskId: "T1", leaseMs: 60000 });
    assert.deepEqual(retry, claimed);
    await assert.rejects(() => repo.apply("w", 2, "wrong-lead", "other", "lead", { type: "run_claim", taskId: "T1", leaseMs: 60000 }), FleetConflict);
    const scheduled = await repo.apply("w", 2, "schedule", "lead", "lead", { type: "job_schedule", jobId: "J1", taskId: "T1", itemId: "I1", workerId: "worker1", agent: "codex", attempt: 1, leadEpoch: 1, ownedPaths: ["src/a.ts"], baseCommit: sha, branch: "worker/J1" });
    await assert.rejects(() => repo.apply("w", 3, "wrong-worker", "worker2", "worker", { type: "job_claim", jobId: "J1", leaseMs: 60000 }), /not assigned/);
    const worker = await repo.apply("w", 3, "worker-claim", "worker1", "worker", { type: "job_claim", jobId: "J1", leaseMs: 60000 });
    assert.equal(worker.fleet.jobs.J1.epoch, 1);
    const checkpoint = await repo.apply("w", 4, "checkpoint", "worker1", "worker", { type: "job_checkpoint", jobId: "J1", epoch: 1, sessionId: "session-1", checkpoint: "turn 2" });
    assert.equal(checkpoint.fleet.jobs.J1.sessionId, "session-1");
    await assert.rejects(() => repo.apply("w", 5, "stale-worker", "worker1", "worker", { type: "job_report", jobId: "J1", epoch: 0, commitSha: sha, changedPaths: [] }), FleetConflict);
    const report = await repo.apply("w", 5, "report", "worker1", "worker", { type: "job_report", jobId: "J1", epoch: 1, commitSha: sha, changedPaths: ["src/a.ts"] });
    assert.equal(report.fleet.jobs.J1.state, "reported");
    await assert.rejects(() => repo.apply("w", 6, "duplicate-report", "worker1", "worker", { type: "job_report", jobId: "J1", epoch: 1, commitSha: sha, changedPaths: [] }), FleetConflict);
    assert.equal(scheduled.revision, 3);
  } finally { repo.close(); }
});

test("lead takeover makes every unfinished prior-epoch job uncertain and recovers a verified commit", () => {
  const time=Date.parse("2026-01-01T01:00:00.000Z");
  const base={schemaVersion:1,features:{},leads:{T1:{taskId:"T1",actor:"old",epoch:1,expiresAt:new Date(time-1).toISOString()}},jobs:{}};
  for(const [name,state] of [["ready","ready"],["leased","leased"],["reported","reported"],["integrated","integrated"]]) base.jobs[name]={schemaVersion:1,id:name,taskId:"T1",itemId:name,workerId:"worker1",agent:"codex",attempt:1,leadEpoch:1,epoch:1,ownedPaths:[`src/${name}.ts`],baseCommit:sha,branch:`worker/${name}`,state,expiresAt:new Date(time+1000).toISOString(),sessionId:"old-session",checkpoint:"old",report:state==="reported"||state==="integrated"?{commitSha:sha,changedPaths:[`src/${name}.ts`]}:null};
  const expiredWorker=structuredClone(base); expiredWorker.leads.T1.expiresAt=new Date(time+60000).toISOString(); expiredWorker.jobs.leased.expiresAt=new Date(time-1).toISOString();
  assert.throws(()=>applyFleetCommand(expiredWorker,{type:"job_claim",jobId:"leased",leaseMs:60000},"worker1","worker",time),/requires lead reconciliation/);
  const reconciled=applyFleetCommand(expiredWorker,{type:"job_reconcile",jobId:"leased",leadEpoch:1,state:"uncertain"},"old","lead",time);
  assert.equal(reconciled.jobs.leased.uncertainAt,new Date(time).toISOString());
  const taken=applyFleetCommand(base,{type:"run_claim",taskId:"T1",leaseMs:60000},"new","lead",time);
  assert.equal(taken.leads.T1.epoch,2);
  for(const name of ["ready","leased","reported"]) { assert.equal(taken.jobs[name].state,"uncertain"); assert.equal(taken.jobs[name].uncertainAt,new Date(time).toISOString()); }
  assert.equal(taken.jobs.integrated.state,"integrated");
  assert.throws(()=>applyFleetCommand(taken,{type:"job_report",jobId:"leased",epoch:1,commitSha:sha,changedPaths:["src/leased.ts"]},"worker1","worker",time+1),/stale or expired job claim/);
  const recovered=applyFleetCommand(taken,{type:"job_recover",jobId:"reported",leadEpoch:2,commitSha:sha,changedPaths:["src/reported.ts"]},"new","lead",time+1);
  assert.equal(recovered.jobs.reported.state,"reported"); assert.equal(recovered.jobs.reported.leadEpoch,2); assert.equal(recovered.jobs.reported.uncertainAt,null);
  const requeued=applyFleetCommand(taken,{type:"job_reconcile",jobId:"ready",leadEpoch:2,state:"ready"},"new","lead",time+1);
  assert.equal(requeued.jobs.ready.uncertainAt,null); assert.equal(requeued.jobs.ready.sessionId,null);
  const integrated=applyFleetCommand(recovered,{type:"job_reconcile",jobId:"reported",leadEpoch:2,state:"integrated"},"new","lead",time+2);
  assert.equal(integrated.jobs.reported.state,"integrated");
  assert.throws(()=>applyFleetCommand(taken,{type:"job_recover",jobId:"ready",leadEpoch:2,commitSha:sha,changedPaths:["other.ts"]},"new","lead",time+1),/out-of-scope/);
});

test("review snapshots require a ready wait and approval is atomic against its revision", async () => {
  const repo = new SqliteStateRepository(":memory:");
  try {
    const first = await repo.apply("w", 0, "create", { type: "upsertTask", taskId: "T1", task }, "/workspace/project");
    assert.equal(first.nextActions.T1.classification, "await_user");
    const snapshot = await repo.putGateSnapshot("w", 1, "snapshot", "T1", "G0_confirm", "Review this intent");
    assert.equal((await repo.gateInbox("w")).length, 1);
    const sibling={...task,id:"T2",title:"Sibling",status:"active",artifacts:{intent:".agents/data/tasks/T2/intent.md",design:".agents/data/tasks/T2/design.md",workplan:".agents/data/tasks/T2/workplan.md"}};
    await repo.apply("w",1,"sibling",{type:"upsertTask",taskId:"T2",task:sibling},"/workspace/project");
    assert.equal((await repo.gateInbox("w"))[0].currentRevision,2);
    await assert.rejects(() => repo.approveGate("w", 0, "stale", "T1", snapshot.id, "human approval", "/workspace/project"), /revision conflict/);
    const approval = await repo.approveGate("w", 2, "approve", "T1", snapshot.id, "human approval", "/workspace/project");
    assert.equal(approval.state.tasks.T1.phase, "plan");
    assert.equal(approval.state.tasks.T1.evidence.at(-1).kind, "approval");
    assert.deepEqual(await repo.gateInbox("w"), []);
    assert.deepEqual(await repo.approveGate("w", 2, "approve", "T1", snapshot.id, "human approval", "/workspace/project"), approval);
    await assert.rejects(() => repo.approveGate("w", 3, "again", "T1", snapshot.id, "human approval", "/workspace/project"), /stale gate snapshot/);
  } finally { repo.close(); }
});

test("G2 snapshot binds the reviewed integration commit through approval", async () => {
  const repo=new SqliteStateRepository(":memory:");
  try {
    const g2={...task,phase:"build",gate:"G2_codereview",evidence:[
      {kind:"approval",gate:"G1_review",result:"pass",source:"human",recordedAt:"2026-01-01T00:00:01.000Z"},
      {kind:"test",area:"root",result:"pass",source:"test",recordedAt:"2026-01-01T00:00:02.000Z"},
      {kind:"review",result:"pass",source:"review",recordedAt:"2026-01-01T00:00:03.000Z"}
    ]};
    const created=await repo.apply("g2",0,"create",{type:"upsertTask",taskId:"T1",task:g2},"/workspace/project");
    assert.equal(created.nextActions.T1.classification,"await_user");
    await assert.rejects(() => repo.putGateSnapshot("g2",1,"missing","T1","G2_codereview","Review build"),/integration commit SHA/);
    const snapshot=await repo.putGateSnapshot("g2",1,"snapshot","T1","G2_codereview","Review build",undefined,sha);
    assert.deepEqual(await repo.putGateSnapshot("g2",0,"snapshot","T1","G2_codereview","Changed retry",undefined,sha),snapshot);
    assert.equal((await repo.gateInbox("g2"))[0].integrationCommit,sha);
    assert.match(snapshot.reviewText,new RegExp(`Integration commit: ${sha}`));
    await assert.rejects(() => repo.approveGate("g2",1,"wrong","T1",snapshot.id,"human","/workspace/project","b".repeat(40)),/does not match/);
    const approved=await repo.approveGate("g2",1,"approved","T1",snapshot.id,"human","/workspace/project",sha);
    assert.equal(approved.state.tasks.T1.phase,"wrap");
  } finally {repo.close();}
});

test("a fleet lifecycle mutation is fenced by the current lead epoch", async () => {
  const dir=mkdtempSync(join(tmpdir(),"aidlc-fleet-fence-")); const file=join(dir,"state.db");
  const fleet=new SqliteFleetRepository(file); const state=new SqliteStateRepository(file);
  try {
    const lead=await fleet.apply("w",0,"claim","lead","lead",{type:"run_claim",taskId:"T1",leaseMs:60000});
    assert.equal(lead.fleet.leads.T1.epoch,1);
    await assert.rejects(() => state.apply("w",0,"wrong",{type:"upsertTask",taskId:"T1",task},"/workspace/project",0),/stale or expired lead epoch/);
    const activeT1={...task,status:"active"};
    const created=await state.apply("w",0,"create",{type:"upsertTask",taskId:"T1",task:activeT1},"/workspace/project",1);
    assert.equal(created.revision,1);
    assert.equal(created.nextActions.T1.classification,"run_phase");
    const forged={...activeT1,evidence:[{kind:"approval",gate:"G0_confirm",result:"pass",source:"forged by lead",recordedAt:"2026-01-01T00:00:01.000Z"}]};
    await assert.rejects(() => state.apply("w",1,"forged",{type:"upsertTask",taskId:"T1",task:forged},"/workspace/project",1),/lead credential cannot record human gate approval/);
    await fleet.apply("w",1,"claim-T2","lead","lead",{type:"run_claim",taskId:"T2",leaseMs:60000});
    const active={...task,id:"T2",title:"Active sibling",status:"active",artifacts:{intent:".agents/data/tasks/T2/intent.md",design:".agents/data/tasks/T2/design.md",workplan:".agents/data/tasks/T2/workplan.md"}};
    await state.apply("w",1,"create-T2",{type:"upsertTask",taskId:"T2",task:active},"/workspace/project",1);
    for(const [phase,gate,status] of [["plan","G1_review","active"],["build","G2_codereview","active"],["wrap","none","active"],["done","none","done"]]) {
      const skipped={...active,phase,gate,status,...(phase==="done"?{lessonDisposition:{status:"none",reason:"none",source:"lead",recordedAt:"2026-01-01T00:00:02.000Z"}}:{})};
      await assert.rejects(() => state.apply("w",2,`skip-${phase}`,{type:"upsertTask",taskId:"T2",task:skipped},"/workspace/project",1),/human gate approval is required/);
    }
    await assert.rejects(() => state.apply("w",2,"remove-active",{type:"removeTask",taskId:"T2"},"/workspace/project",1),/active fleet task cannot be removed/);
    await fleet.apply("w",2,"release","lead","lead",{type:"run_release",taskId:"T1",epoch:1});
    await assert.rejects(() => state.apply("w",2,"stale",{type:"upsertTask",taskId:"T1",task},"/workspace/project",1),/stale or expired lead epoch/);
  } finally {state.close();fleet.close();rmSync(dir,{recursive:true,force:true});}
});

test("fenced lead may complete the gateless wrap phase after lesson disposition", async () => {
  const dir=mkdtempSync(join(tmpdir(),"aidlc-fleet-wrap-")); const file=join(dir,"state.db");
  const fleet=new SqliteFleetRepository(file); const state=new SqliteStateRepository(file);
  try {
    const wrapped={...task,phase:"wrap",gate:"none",status:"active",evidence:[
      {kind:"approval",gate:"G1_review",result:"pass",source:"human",recordedAt:"2026-01-01T00:00:00.000Z"},
      {kind:"approval",gate:"G2_codereview",result:"pass",source:"human",recordedAt:"2026-01-01T00:00:01.000Z"}
    ],lessonDisposition:{status:"none",reason:"none",source:"human",recordedAt:"2026-01-01T00:00:02.000Z"}};
    await state.apply("w",0,"seed",{type:"upsertTask",taskId:"T1",task:wrapped},"/workspace/project");
    await fleet.apply("w",0,"claim","lead","lead",{type:"run_claim",taskId:"T1",leaseMs:60000});
    const done=await state.apply("w",1,"complete",{type:"transition",taskId:"T1",target:"done"},"/workspace/project",1);
    assert.equal(done.state.tasks.T1.phase,"done");
    assert.equal(done.nextActions.T1.classification,"complete");
  } finally {state.close();fleet.close();rmSync(dir,{recursive:true,force:true});}
});

test("MCP client parses a stateless SSE tool response and rejects tool errors", async () => {
  const ok=await callTool({url:"http://localhost/mcp",token:"test",name:"fleet_get",args:{workspace:"w"},fetchImpl:async (_,options)=>{const body=JSON.parse(options.body);return new Response(`data: ${JSON.stringify({jsonrpc:"2.0",id:body.id,result:{content:[{type:"text",text:JSON.stringify({revision:1})}]}})}\n\n`,{status:200,headers:{"content-type":"text/event-stream"}});}});
  assert.equal(ok.revision,1);
  await assert.rejects(() => callTool({url:"http://localhost/mcp",token:"test",name:"x",fetchImpl:async (_,options)=>{const body=JSON.parse(options.body);return new Response(JSON.stringify({jsonrpc:"2.0",id:body.id,result:{isError:true,content:[{type:"text",text:JSON.stringify({code:"DENIED",message:"role denied"})}]}}),{status:200,headers:{"content-type":"application/json"}});}}),/role denied/);
});

test("installed project fleet wrapper resolves its runner assets", () => {
  const dir=mkdtempSync(join(tmpdir(),"aidlc-fleet-installed-"));
  try {
    const serviceSrc=join(dir,".agents","aidlc-coordination","src");
    mkdirSync(serviceSrc,{recursive:true});
    for(const file of ["fleet-run.mjs","fleet-client.mjs"]) cpSync(new URL(`../src/${file}`,import.meta.url),join(serviceSrc,file));
    cpSync(new URL("../../../assets/aidlc/scripts",import.meta.url),join(dir,".agents","aidlc","scripts"),{recursive:true});
    const run=spawnSync(process.execPath,[join(serviceSrc,"fleet-run.mjs")],{encoding:"utf8"});
    assert.equal(run.status,1);
    assert.match(`${run.stdout}\n${run.stderr}`,/Usage: aidlc-fleet coordinator/,JSON.stringify({stdout:run.stdout,stderr:run.stderr,error:run.error?.message}));
    assert.doesNotMatch(run.stderr,/Fleet runner assets are missing|ERR_MODULE_NOT_FOUND/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("PostgreSQL board preserves the full task/comment projection across writes", { skip: !process.env.TEST_POSTGRES_URL }, async () => {
  const repo=new PostgresCoordinationRepository(process.env.TEST_POSTGRES_URL); const workspace=`test-${randomUUID()}`;
  try {
    await repo.apply(workspace,0,"create","human","writer",{type:"upsert_task",task:{id:"K1",title:"Work",status:"ready"}});
    await repo.apply(workspace,1,"comment","human","commenter",{type:"add_comment",taskId:"K1",authorType:"human",intent:"status",body:"Progress"});
    const board=await repo.get(workspace); const thread=await repo.thread(workspace,"K1");
    assert.deepEqual(board.board.tasks.map((item)=>item.id),["K1"]);
    assert.deepEqual(thread.comments.map((item)=>item.body),["Progress"]);
    const row=(await repo.pool.query("SELECT board FROM coordination_workspaces WHERE workspace=$1",[workspace])).rows[0];
    assert.equal(Array.isArray(row.board.tasks),false);
    assert.equal(row.board.comments.K1.length,1);
  } finally { await repo.pool.query("DELETE FROM coordination_events WHERE workspace=$1",[workspace]); await repo.pool.query("DELETE FROM coordination_idempotency WHERE workspace=$1",[workspace]); await repo.pool.query("DELETE FROM coordination_workspaces WHERE workspace=$1",[workspace]); await repo.close(); }
});

test("PostgreSQL fleet and canonical state enforce fencing and atomic reviewer approval", { skip: !process.env.TEST_POSTGRES_URL }, async () => {
  const fleet=new PostgresFleetRepository(process.env.TEST_POSTGRES_URL); const state=new PostgresStateRepository(process.env.TEST_POSTGRES_URL); const workspace=`test-${randomUUID()}`;
  try {
    const claim=await fleet.apply(workspace,0,"claim","lead","lead",{type:"run_claim",taskId:"T1",leaseMs:60000});
    assert.equal(claim.fleet.leads.T1.epoch,1);
    await assert.rejects(() => state.apply(workspace,0,"stale",{type:"upsertTask",taskId:"T1",task},"/workspace/project",0),/stale or expired lead epoch/);
    const activeTask={...task,status:"active"};
    const created=await state.apply(workspace,0,"create",{type:"upsertTask",taskId:"T1",task:activeTask},"/workspace/project",1);
    assert.equal(created.nextActions.T1.classification,"run_phase");
    for(const [phase,gate,status] of [["plan","G1_review","active"],["build","G2_codereview","active"],["wrap","none","active"],["done","none","done"]]) {
      const skipped={...activeTask,phase,gate,status,...(phase==="done"?{lessonDisposition:{status:"none",reason:"none",source:"lead",recordedAt:"2026-01-01T00:00:02.000Z"}}:{})};
      await assert.rejects(() => state.apply(workspace,1,`skip-${phase}`,{type:"upsertTask",taskId:"T1",task:skipped},"/workspace/project",1),/human gate approval is required/);
    }
    await state.apply(workspace,1,"wait",{type:"upsertTask",taskId:"T1",task},"/workspace/project",1);
    const snapshot=await state.putGateSnapshot(workspace,2,"snapshot","T1","G0_confirm","Review this intent",1);
    assert.deepEqual(await state.putGateSnapshot(workspace,0,"snapshot","T1","G0_confirm","Changed retry",1),snapshot);
    const forged={...task,status:"active",evidence:[{kind:"approval",gate:"G0_confirm",result:"pass",source:"forged by lead",recordedAt:"2026-01-01T00:00:01.000Z"}]};
    await assert.rejects(() => state.apply(workspace,2,"forged",{type:"upsertTask",taskId:"T1",task:forged},"/workspace/project",1),/lead credential cannot record human gate approval/);
    const sibling={...task,id:"T2",title:"Sibling",status:"active",artifacts:{intent:".agents/data/tasks/T2/intent.md",design:".agents/data/tasks/T2/design.md",workplan:".agents/data/tasks/T2/workplan.md"}};
    await state.apply(workspace,2,"sibling",{type:"upsertTask",taskId:"T2",task:sibling},"/workspace/project");
    assert.equal((await state.gateInbox(workspace))[0].currentRevision,3);
    const approval=await state.approveGate(workspace,3,"approve","T1",snapshot.id,"human approval","/workspace/project");
    assert.equal(approval.state.tasks.T1.phase,"plan");
    await assert.rejects(() => state.approveGate(workspace,4,"stale-snapshot","T1",snapshot.id,"human approval","/workspace/project"),/stale gate snapshot/);
    const g2={...task,id:"T3",title:"G2 task",phase:"build",gate:"G2_codereview",artifacts:{intent:".agents/data/tasks/T3/intent.md",design:".agents/data/tasks/T3/design.md",workplan:".agents/data/tasks/T3/workplan.md"},evidence:[
      {kind:"approval",gate:"G1_review",result:"pass",source:"human",recordedAt:"2026-01-01T00:00:01.000Z"},
      {kind:"test",area:"root",result:"pass",source:"test",recordedAt:"2026-01-01T00:00:02.000Z"},
      {kind:"review",result:"pass",source:"review",recordedAt:"2026-01-01T00:00:03.000Z"}
    ]};
    await state.apply(workspace,4,"seed-g2",{type:"upsertTask",taskId:"T3",task:g2},"/workspace/project");
    const g2Snapshot=await state.putGateSnapshot(workspace,5,"g2-snapshot","T3","G2_codereview","Review integrated build",undefined,sha);
    assert.equal((await state.gateInbox(workspace))[0].integrationCommit,sha);
    assert.match(g2Snapshot.reviewText,new RegExp(`Integration commit: ${sha}`));
    await assert.rejects(() => state.approveGate(workspace,5,"g2-wrong","T3",g2Snapshot.id,"human approval","/workspace/project","b".repeat(40)),/does not match/);
    const g2Approval=await state.approveGate(workspace,5,"g2-approved","T3",g2Snapshot.id,"human approval","/workspace/project",sha);
    assert.equal(g2Approval.state.tasks.T3.phase,"wrap");
    await fleet.apply(workspace,1,"schedule","lead","lead",{type:"job_schedule",jobId:"J1",taskId:"T1",itemId:"I1",workerId:"worker1",agent:"codex",attempt:1,leadEpoch:1,ownedPaths:["src/a.ts"],baseCommit:sha,branch:"worker/J1"});
    await fleet.apply(workspace,2,"worker-claim","worker1","worker",{type:"job_claim",jobId:"J1",leaseMs:60000});
    await fleet.apply(workspace,3,"worker-report","worker1","worker",{type:"job_report",jobId:"J1",epoch:1,commitSha:sha,changedPaths:["src/a.ts"]});
    await fleet.apply(workspace,4,"release","lead","lead",{type:"run_release",taskId:"T1",epoch:1});
    const takeover=await fleet.apply(workspace,5,"takeover","lead","lead",{type:"run_claim",taskId:"T1",leaseMs:60000});
    assert.equal(takeover.fleet.jobs.J1.state,"uncertain");
    assert.match(takeover.fleet.jobs.J1.uncertainAt,/^\d{4}-\d{2}-\d{2}T/);
    await assert.rejects(() => fleet.apply(workspace,6,"late-worker","worker1","worker",{type:"job_report",jobId:"J1",epoch:1,commitSha:sha,changedPaths:["src/a.ts"]}),/stale or expired job claim/);
    const recovered=await fleet.apply(workspace,6,"recover","lead","lead",{type:"job_recover",jobId:"J1",leadEpoch:2,commitSha:sha,changedPaths:["src/a.ts"]});
    assert.equal(recovered.fleet.jobs.J1.state,"reported"); assert.equal(recovered.fleet.jobs.J1.leadEpoch,2);
  } finally {
    for(const table of ["state_gate_snapshots","state_events","state_idempotency","state_workspaces","fleet_idempotency","fleet_workspaces"]) await state.pool.query(`DELETE FROM ${table} WHERE workspace=$1`,[workspace]);
    await state.close();await fleet.close();
  }
});
