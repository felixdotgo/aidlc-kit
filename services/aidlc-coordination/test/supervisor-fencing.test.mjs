import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { applyFleetCommand, SqliteFleetRepository } from '../src/fleet.mjs';
const owner = 's'.repeat(48), runOwner = 'r'.repeat(48), bad = 'x'.repeat(48), leaseMs = 60000, actor = 'lead', time = 1800000000000;
const run = (state, command, timestamp = time) => applyFleetCommand(state, command, actor, 'lead', timestamp);
test('supervisor binds run and fences stale and tokenless leads', () => {
  let state = { schemaVersion: 1, features: {}, leads: {}, jobs: {} };
  state = run(state, { type: 'supervisor_claim', taskId: 'T', leaseMs, ownerToken: owner });
  assert.throws(() => run(state, { type: 'supervisor_claim', taskId: 'T', leaseMs, ownerToken: bad }), /held/);
  assert.throws(() => run(state, { type: 'run_claim', taskId: 'T', leaseMs }), /supervisor claim/);
  assert.throws(() => run(state, { type: 'run_claim', taskId: 'T', leaseMs, supervisorEpoch: 1, supervisorOwnerToken: bad, ownerToken: runOwner }), /supervisor claim/);
  state = run(state, { type: 'run_claim', taskId: 'T', leaseMs, supervisorEpoch: 1, supervisorOwnerToken: owner, ownerToken: runOwner });
  assert.throws(() => run(state, { type: 'run_heartbeat', taskId: 'T', epoch: 1, leaseMs, ownerToken: bad }), /lead claim/);
  state = run(state, { type: 'supervisor_release', taskId: 'T', epoch: 1, ownerToken: owner });
  assert.throws(() => run(state, { type: 'run_heartbeat', taskId: 'T', epoch: 1, leaseMs, ownerToken: runOwner }), /supervisor claim/);
  state = run(state, { type: 'supervisor_claim', taskId: 'T', leaseMs, ownerToken: bad }, time + leaseMs + 1);
  assert.equal(state.supervisors.T.epoch, 2);
  assert.throws(() => run(state, { type: 'run_claim', taskId: 'T', leaseMs, supervisorEpoch: 1, supervisorOwnerToken: owner, ownerToken: runOwner }, time + leaseMs + 2), /supervisor claim/);
});
test('supervisor and lead secrets never appear in fleet output or idempotency cache', async () => {
  const repo = new SqliteFleetRepository(':memory:');
  try {
    const command = { type: 'supervisor_claim', taskId: 'T', leaseMs, ownerToken: owner };
    const first = await repo.apply('W', 0, 's1', actor, 'lead', command);
    assert.equal(first.fleet.supervisors.T.epoch, 1);
    const task = { id: 'T', phase: 'plan', gate: 'G1_review', status: 'active', decisions: [], tasks: [], evidence: [] };
    repo.db.exec('CREATE TABLE state_workspaces (workspace TEXT, revision INTEGER, state TEXT); CREATE TABLE state_gate_checkpoints (workspace TEXT, task_id TEXT); CREATE TABLE state_gate_snapshots (workspace TEXT, id TEXT)');
    repo.db.prepare('INSERT INTO state_workspaces VALUES (?, ?, ?)').run('W', 1, JSON.stringify({ tasks: { T: task } }));
    const digest = createHash('sha256').update(JSON.stringify(task)).digest('hex');
    const runClaim = { type: 'run_claim', taskId: 'T', leaseMs, ownerToken: runOwner, supervisorEpoch: 1, supervisorOwnerToken: owner, expectedStateRevision: 1, expectedTaskDigest: digest };
    const next = await repo.apply('W', 1, 'r1', actor, 'lead', runClaim);
    const serialized = JSON.stringify([first, next, await repo.get('W'), repo.db.prepare('SELECT response FROM fleet_idempotency').all()]);
    assert.ok(!serialized.includes(owner) && !serialized.includes(runOwner) && !serialized.includes('ownerTokenHash') && !serialized.includes('supervisorOwnerTokenHash'));
    assert.deepEqual(await repo.apply('W', 0, 's1', actor, 'lead', command), first);
    await assert.rejects(repo.apply('W', 0, 's1', actor, 'lead', { ...command, leaseMs: 120000 }), /payload mismatch/);
    await repo.apply('W', 2, 'release', actor, 'lead', { type: 'supervisor_release', taskId: 'T', epoch: 1, ownerToken: owner });
    await assert.rejects(repo.apply('W', 1, 'r1', actor, 'lead', runClaim), /supervisor claim/);
  } finally { repo.close(); }
});
test('Git gateway persists intent, fences lease and retains pending on uncertain callback', async () => {
  const repo = new SqliteFleetRepository(':memory:');
  try {
    await repo.apply('W', 0, 's1', actor, 'lead', { type:'supervisor_claim',taskId:'T',leaseMs,ownerToken:owner });
    const task={id:'T',phase:'plan',gate:'G1_review',status:'active',decisions:[],tasks:[],evidence:[]};
    repo.db.exec('CREATE TABLE state_workspaces (workspace TEXT, revision INTEGER, state TEXT); CREATE TABLE state_gate_checkpoints (workspace TEXT, task_id TEXT); CREATE TABLE state_gate_snapshots (workspace TEXT, id TEXT)');
    repo.db.prepare('INSERT INTO state_workspaces VALUES (?,?,?)').run('W',1,JSON.stringify({tasks:{T:task}}));
    await repo.apply('W',1,'run',actor,'lead',{type:'run_claim',taskId:'T',leaseMs,ownerToken:runOwner,supervisorEpoch:1,supervisorOwnerToken:owner,expectedStateRevision:1,expectedTaskDigest:createHash('sha256').update(JSON.stringify(task)).digest('hex')});
    const intent={workspace:'W',taskId:'T',epoch:1,ownerToken:runOwner,operationId:'op',ref:'refs/heads/main',oldOid:'a'.repeat(40),newOid:'b'.repeat(40)};
    assert.deepEqual(await repo.prepareGitOperation(intent),{status:'pending'});
    await assert.rejects(repo.prepareGitOperation({...intent,newOid:'c'.repeat(40)}),/mismatch/);
    await assert.rejects(repo.withGitFence(intent,async ({assertValid})=>{assertValid();throw Error('ambiguous Git result');}),/ambiguous/);
    assert.equal((await repo.getGitOperation(intent)).status,'pending');
    await repo.withGitFence(intent,async ({record,assertValid,complete})=>{assert.equal(record.ref,intent.ref);assertValid();await complete();});
    assert.equal((await repo.getGitOperation(intent)).status,'complete');
    await repo.apply('W',2,'super-release',actor,'lead',{type:'supervisor_release',taskId:'T',epoch:1,ownerToken:owner});
    await assert.rejects(repo.prepareGitOperation(intent),/supervisor/);
  } finally { repo.close(); }
});
