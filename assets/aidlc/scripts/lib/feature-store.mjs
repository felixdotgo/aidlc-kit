import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nextAction } from "./store.mjs";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const checkedId = (id) => { if (!idPattern.test(id ?? "")) throw new Error(`Invalid feature/task id: ${id}`); return id; };
const directory = (root) => join(root, ".agents/data/features");
const pathOf = (root, id) => join(directory(root), `${checkedId(id)}.json`);
const safePath = (root, id) => {
  const dir = directory(root);
  let cursor = root;
  for (const part of [".agents", "data", "features"]) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`Feature path crosses symlink: ${id}`);
  }
  const path = pathOf(root, id);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`Feature path crosses symlink: ${id}`);
  return path;
};

export const validateFeature = (feature, state) => {
  if (!feature || feature.schemaVersion !== 1 || !idPattern.test(feature.id ?? "") || typeof feature.integrationBranch !== "string" || !feature.integrationBranch.trim() || !Array.isArray(feature.tasks)) throw new Error("Invalid feature manifest");
  const byId = new Map();
  for (const item of feature.tasks) {
    if (!idPattern.test(item?.id ?? "") || !Array.isArray(item.dependsOn) || new Set(item.dependsOn).size !== item.dependsOn.length || byId.has(item.id)) throw new Error(`Invalid feature task: ${item?.id}`);
    if (!state.tasks[item.id] && !state.archive?.[item.id]) throw new Error(`Unknown feature task: ${item.id}`);
    byId.set(item.id, item);
  }
  const visiting = new Set(); const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error(`Cyclic feature dependency: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id).dependsOn) {
      if (!byId.has(dep)) throw new Error(`Unknown feature dependency: ${id}/${dep}`);
      visit(dep);
    }
    visiting.delete(id); visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
  return feature;
};

export const loadFeature = (root, id, state) => {
  const path = safePath(root, id);
  return existsSync(path) ? validateFeature(JSON.parse(readFileSync(path, "utf8")), state) : undefined;
};
export const listFeatures = (root, state) => existsSync(directory(root)) ? readdirSync(directory(root)).filter((name) => name.endsWith(".json")).map((name) => loadFeature(root, name.slice(0, -5), state)) : [];
export const saveFeature = (root, feature, state) => {
  validateFeature(feature, state);
  const path = safePath(root, feature.id);
  mkdirSync(directory(root), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(feature, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
  return feature;
};
export const readyFeatureTasks = (feature, state) => {
  validateFeature(feature, state);
  const ready = []; const blocked = [];
  for (const item of feature.tasks) {
    const task = state.tasks[item.id] ?? state.archive?.[item.id];
    if (task.status === "done") continue;
    if (task.status === "closed" || task.status === "superseded") { blocked.push({ id: item.id, waitingOn: [], reason: `Task is ${task.status}` }); continue; }
    const waitingOn = item.dependsOn.filter((id) => (state.tasks[id] ?? state.archive?.[id])?.status !== "done");
    if (waitingOn.length) blocked.push({ id: item.id, waitingOn });
    else ready.push({ id: item.id, nextAction: state.tasks[item.id] ? nextAction(state.tasks[item.id]) : { classification: "terminal", outcome: task.status } });
  }
  return { id: feature.id, ready, blocked };
};
