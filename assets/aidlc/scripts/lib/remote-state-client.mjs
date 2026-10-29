import { randomUUID } from "node:crypto";

const parseMessage = (body, contentType, id) => {
  if (contentType.includes("text/event-stream")) {
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") continue;
      try { const message = JSON.parse(data); if (message.id === id) return message; } catch { /* keep reading */ }
    }
    return undefined;
  }
  const message = JSON.parse(body);
  return Array.isArray(message) ? message.find((entry) => entry.id === id) : message;
};

export const remoteConfig = (env = process.env) => {
  const url = env.AIDLC_FLEET_URL;
  const workspace = env.AIDLC_FLEET_WORKSPACE;
  const token = env.AIDLC_FLEET_TOKEN;
  const projectRoot = env.AIDLC_FLEET_PROJECT_ROOT;
  const leadEpoch = Number(env.AIDLC_FLEET_LEAD_EPOCH);
  if (!url || !/^https?:\/\//.test(url) || !workspace || !token || !projectRoot?.startsWith("/") || !Number.isSafeInteger(leadEpoch) || leadEpoch < 1) {
    throw new Error("Remote state requires AIDLC_FLEET_URL, WORKSPACE, TOKEN, absolute PROJECT_ROOT, and positive LEAD_EPOCH");
  }
  return { url, workspace, token, projectRoot, leadEpoch, leadOwnerToken: env.AIDLC_FLEET_LEAD_OWNER_TOKEN, integrationBranch: env.AIDLC_FLEET_INTEGRATION_BRANCH, gitRemote: env.AIDLC_FLEET_GIT_REMOTE ?? "origin" };
};

export const featureConfig = (env = process.env) => {
  const url = env.AIDLC_FLEET_URL;
  const workspace = env.AIDLC_FLEET_WORKSPACE;
  const token = env.AIDLC_FLEET_TOKEN;
  const projectRoot = env.AIDLC_FLEET_PROJECT_ROOT;
  if (!url || !/^https?:\/\//.test(url) || !workspace || !token || !projectRoot?.startsWith("/")) {
    throw new Error("Remote feature commands require AIDLC_FLEET_URL, WORKSPACE, TOKEN, and absolute PROJECT_ROOT");
  }
  return { url, workspace, token, projectRoot };
};

export const reviewerConfig = (env = process.env) => {
  const url = env.AIDLC_FLEET_URL;
  const workspace = env.AIDLC_FLEET_WORKSPACE;
  const token = env.AIDLC_FLEET_REVIEWER_TOKEN;
  const projectRoot = env.AIDLC_FLEET_PROJECT_ROOT;
  if (!url || !/^https?:\/\//.test(url) || !workspace || !token || !projectRoot?.startsWith("/")) {
    throw new Error("Remote review requires AIDLC_FLEET_URL, WORKSPACE, REVIEWER_TOKEN, and absolute PROJECT_ROOT");
  }
  return { url, workspace, token, projectRoot, integrationBranch: env.AIDLC_FLEET_INTEGRATION_BRANCH, gitRemote: env.AIDLC_FLEET_GIT_REMOTE ?? "origin" };
};

export const callRemoteTool = async (config, name, args = {}, fetchImpl = fetch) => {
  const id = randomUUID();
  let response;
  try {
    response = await fetchImpl(config.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(20000)
    });
  } catch (error) { throw new Error(`Remote coordination unavailable: ${error.message}`); }
  const body = await response.text();
  if (!response.ok) throw new Error(`Remote coordination HTTP ${response.status}: ${body.slice(0, 300)}`);
  let message;
  try { message = parseMessage(body, response.headers.get("content-type") ?? "", id); }
  catch { throw new Error("Remote coordination returned invalid JSON"); }
  if (!message || message.id !== id) throw new Error("Remote coordination returned no matching result");
  if (message.error) throw new Error(`Remote coordination RPC ${message.error.code}: ${message.error.message}`);
  const tool = message.result;
  if (!Array.isArray(tool?.content) || tool.content[0]?.type !== "text") throw new Error("Remote coordination returned no JSON text");
  let value;
  try { value = JSON.parse(tool.content[0].text); } catch { throw new Error("Remote coordination returned invalid tool JSON"); }
  if (tool.isError) {
    const error = new Error(value.message ?? value.code ?? "Remote coordination rejected operation");
    error.code = value.code; error.current = value.current;
    throw error;
  }
  return value;
};

export const createRemoteStateClient = (config, call = callRemoteTool) => ({
  get: () => call(config, "state_get", { workspace: config.workspace }),
  task: (taskId) => call(config, "task_get", { workspace: config.workspace, taskId, clientProjectRoot: config.projectRoot }),
  apply: (expectedRevision, taskId, task) => call(config, "state_apply", {
    workspace: config.workspace, expectedRevision, idempotencyKey: randomUUID(), clientProjectRoot: config.projectRoot,
    leadEpoch: config.leadEpoch, ...(config.leadOwnerToken ? { leadOwnerToken: config.leadOwnerToken } : {}), command: { type: "upsertTask", taskId, task }
  }),
  snapshot: (expectedRevision, taskId, gate, reviewText, integrationCommit) => call(config, "gate_snapshot_put", {
    workspace: config.workspace, expectedRevision, idempotencyKey: randomUUID(), taskId,
    leadEpoch: config.leadEpoch, ...(config.leadOwnerToken ? { leadOwnerToken: config.leadOwnerToken } : {}), gate, reviewText, ...(integrationCommit ? { integrationCommit } : {})
  }),
  featureGet: (featureId) => call(config, "feature_get", { workspace: config.workspace, featureId }),
  featureReady: (featureId) => call(config, "feature_ready", { workspace: config.workspace, featureId }),
  featureApply: (expectedRevision, feature) => call(config, "feature_apply", {
    workspace: config.workspace, expectedRevision, idempotencyKey: randomUUID(), feature
  }),
  fleetGet: () => call(config, "fleet_get", { workspace: config.workspace }),
  runClaim: (expectedRevision, taskId, leaseMs) => call(config, "run_claim", {
    workspace: config.workspace, expectedRevision, idempotencyKey: randomUUID(), taskId, leaseMs
  }),
  runRelease: (expectedRevision, taskId, epoch) => call(config, "run_release", {
    workspace: config.workspace, expectedRevision, idempotencyKey: randomUUID(), taskId, epoch
  })
});

export const createRemoteReviewerClient = (config, call = callRemoteTool) => ({
  get: () => call(config, "state_get", { workspace: config.workspace }),
  inbox: () => call(config, "gate_inbox_get", { workspace: config.workspace }),
  approve: (expectedRevision, taskId, snapshotId, source, integrationCommit) => call(config, "gate_approve", {
    workspace: config.workspace, expectedRevision, idempotencyKey: randomUUID(), taskId, snapshotId,
    source, clientProjectRoot: config.projectRoot, ...(integrationCommit ? { integrationCommit } : {})
  })
});
