/**
 * Project profiles and configuration. Loads `.agents/config.json`, validates
 * every nested section (loop, tracker, MCP, risk, context), and resolves the
 * effective configuration by merging built-in and local profiles.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { LOOP_PROVIDERS } from "./model.js";
import type { AgentId, CommandSpec, LoopConfig, LoopAgent, McpConfig, Profile, ProjectConfig, RiskLevel, StateMutationMode, TrackerConfig } from "./model.js";

const loopProviderNames = `${LOOP_PROVIDERS.slice(0, -1).join(", ")}, or ${LOOP_PROVIDERS[LOOP_PROVIDERS.length - 1]}`;
const isLoopProvider = (value: unknown): value is LoopAgent => typeof value === "string" && (LOOP_PROVIDERS as readonly string[]).includes(value);

const profile = (id: Profile["topology"], markers: string[] = []): Profile => ({
  schemaVersion: 1,
  id: `topology/${id}`,
  topology: id,
  discovery: { roots: ["."], workspaceMarkers: markers },
  specs: { roots: [] },
  commands: {},
  rules: { include: [] }
});

export const builtInProfiles: Readonly<Record<string, Profile>> = Object.freeze({
  "topology/generic": profile("generic"),
  "topology/single": profile("single"),
  "topology/workspace": profile("workspace", ["package.json", "pnpm-workspace.yaml", "lerna.json"]),
  "topology/git-submodules": profile("git-submodules", [".gitmodules"])
});

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};

/** Validates and normalizes a loop-execution configuration block. */
export const validateLoopConfig = (value: unknown): LoopConfig => {
  if (value === undefined) return { mode: "off" };
  const item = object(value, "config.loop");
  if (Object.keys(item).some((key) => !["mode", "agents"].includes(key)) || typeof item.mode !== "string" || !["off", "local", "fleet"].includes(item.mode)) throw new Error("config.loop requires a valid mode and only supported fields");
  if (item.agents === undefined) return { mode: item.mode as LoopConfig["mode"] };
  const agents = object(item.agents, "config.loop.agents");
  if (Object.keys(agents).some((key) => !["lead", "workers"].includes(key)) || !isLoopProvider(agents.lead)) throw new Error(`config.loop.agents.lead must be ${loopProviderNames}`);
  const workers = object(agents.workers, "config.loop.agents.workers");
  for (const [id, provider] of Object.entries(workers)) if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || !isLoopProvider(provider)) throw new Error(`config.loop.agents.workers must map worker IDs to ${loopProviderNames}`);
  return { mode: item.mode as LoopConfig["mode"], agents: { lead: agents.lead as LoopAgent, workers: workers as Record<string, LoopAgent> } };
};

const strings = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be a string array`);
  return value as string[];
};

const command = (value: unknown, label: string): CommandSpec => {
  const item = object(value, label);
  if (typeof item.command !== "string" || !item.command || isAbsolute(item.command)) throw new Error(`${label}.command must be a non-absolute executable name`);
  return { command: item.command, args: strings(item.args ?? [], `${label}.args`) };
};

const commands = (value: unknown, label: string): Record<string, CommandSpec> => {
  if (value === undefined) return {};
  return Object.fromEntries(Object.entries(object(value, label)).map(([key, item]) => [key, command(item, `${label}.${key}`)]));
};

const safeRelative = (path: string, label: string): string => {
  const cleaned = normalize(path);
  if (isAbsolute(cleaned) || cleaned === ".." || cleaned.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) throw new Error(`${label} must stay inside the project`);
  return cleaned;
};

const tracker = (value: unknown): TrackerConfig | undefined => {
  if (value === undefined) return undefined;
  const item = object(value, "config.tracker");
  if (item.enabled === false) return undefined;
  if (item.enabled !== true || item.provider !== "backlog" || typeof item.spaceUrl !== "string" || !/^https:\/\/[^/]+\/?$/.test(item.spaceUrl) || typeof item.project !== "string" || !item.project.trim() || typeof item.tokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.tokenEnv) || !["waterfall", "scrum"].includes(String(item.workflow))) throw new Error("config.tracker must be a complete enabled Backlog configuration");
  const mapping = object(item.mapping ?? {}, "config.tracker.mapping");
  const statuses = mapping.statuses === undefined ? undefined : object(mapping.statuses, "config.tracker.mapping.statuses");
  const statusValues = statuses ? Object.fromEntries(Object.entries(statuses).map(([phase, id]) => {
    if (!["clarify", "plan", "build", "wrap", "done"].includes(phase) || !Number.isInteger(id) || Number(id) < 1) throw new Error("config.tracker.mapping.statuses is invalid");
    return [phase, Number(id)];
  })) : undefined;
  if (mapping.gateFieldId !== undefined && (!Number.isInteger(mapping.gateFieldId) || Number(mapping.gateFieldId) < 1)) throw new Error("config.tracker.mapping.gateFieldId is invalid");
  return { enabled: true, provider: "backlog", spaceUrl: item.spaceUrl.replace(/\/$/, ""), project: item.project, tokenEnv: item.tokenEnv, workflow: item.workflow as TrackerConfig["workflow"], mapping: { ...(statusValues ? { statuses: statusValues } : {}), ...(mapping.gateFieldId === undefined ? {} : { gateFieldId: mapping.gateFieldId as number }) } };
};

const mcp = (value: unknown): McpConfig => {
  if (value === undefined) return { enabled: false };
  const item = object(value, "config.mcp");
  if (item.enabled === false) return { enabled: false };
  if (item.enabled !== true || typeof item.endpoint !== "string" || !/^https?:\/\//.test(item.endpoint) || typeof item.workspace !== "string" || !item.workspace.trim()) throw new Error("config.mcp.enabled requires endpoint and workspace");
  if (item.tokenEnv !== undefined && (typeof item.tokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.tokenEnv))) throw new Error("config.mcp.tokenEnv is invalid");
  if (item.pollMs !== undefined && (!Number.isInteger(item.pollMs) || Number(item.pollMs) < 1_000 || Number(item.pollMs) > 3_600_000)) throw new Error("config.mcp.pollMs must be an integer from 1000 to 3600000");
  const providers = item.providers === undefined ? undefined : strings(item.providers, "config.mcp.providers");
  if (providers?.some((provider) => !["jira", "trello", "github-issues"].includes(provider))) throw new Error("config.mcp.providers is invalid");
  return { enabled: true, endpoint: item.endpoint, workspace: item.workspace, ...(item.tokenEnv === undefined ? {} : { tokenEnv: item.tokenEnv }), ...(item.pollMs === undefined ? {} : { pollMs: Number(item.pollMs) }), ...(providers === undefined ? {} : { providers: providers as McpConfig["providers"] }) };
};

/** Validates a single profile file (built-in or local). */
export const validateProfile = (value: unknown, label = "profile"): Profile => {
  const item = object(value, label);
  if (item.schemaVersion !== 1 || typeof item.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(item.id) || typeof item.topology !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(item.topology)) throw new Error(`${label} has an unsupported schema, id, or topology`);
  const discovery = item.discovery === undefined ? undefined : object(item.discovery, `${label}.discovery`);
  const specs = item.specs === undefined ? undefined : object(item.specs, `${label}.specs`);
  const rules = item.rules === undefined ? undefined : object(item.rules, `${label}.rules`);
  return {
    schemaVersion: 1,
    id: item.id,
    extends: item.extends === undefined ? [] : strings(item.extends, `${label}.extends`),
    topology: item.topology as Profile["topology"],
    discovery: discovery ? {
      roots: strings(discovery.roots ?? [], `${label}.discovery.roots`).map((path) => safeRelative(path, `${label}.discovery.roots`)),
      workspaceMarkers: strings(discovery.workspaceMarkers ?? [], `${label}.discovery.workspaceMarkers`).map((path) => safeRelative(path, `${label}.discovery.workspaceMarkers`))
    } : undefined,
    specs: specs ? { roots: strings(specs.roots ?? [], `${label}.specs.roots`).map((path) => safeRelative(path, `${label}.specs.roots`)) } : undefined,
    commands: commands(item.commands, `${label}.commands`),
    rules: rules ? { include: strings(rules.include ?? [], `${label}.rules.include`).map((path) => safeRelative(path, `${label}.rules.include`)) } : undefined
  };
};

export const defaultConfig = (): ProjectConfig => ({
  $schema: "./aidlc/schemas/config.schema.json",
  schemaVersion: 2,
  extends: ["topology/single"],
  specs: { roots: [] },
  commands: {},
  rules: { include: [] },
  risk: { default: "normal" },
  context: { maxChars: 16_000 },
  agentState: {},
  mcp: { enabled: false },
  loop: { mode: "off" }
});

/** Loads and validates `.agents/config.json`, falling back to the default config when absent. */
export const loadProjectConfig = (root: string): ProjectConfig => {
  const path = join(resolve(root), ".agents/config.json");
  if (!existsSync(path)) return defaultConfig();
  const item = object(JSON.parse(readFileSync(path, "utf8")), ".agents/config.json");
  const risk = object(item.risk ?? {}, "config.risk");
  const context = object(item.context ?? {}, "config.context");
  const levels: RiskLevel[] = ["low", "normal", "high", "regulated"];
  const riskDefault = String(risk.default ?? "normal") as RiskLevel;
  if (![1, 2, 3].includes(Number(item.schemaVersion)) || !levels.includes(riskDefault)) throw new Error("Unsupported project config schema or risk level");
  const agentStateRaw = object(item.agentState ?? {}, "config.agentState");
  const agentState = Object.fromEntries(Object.entries(agentStateRaw).map(([id, mode]) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || (mode !== "native" && mode !== "scripted")) throw new Error("config.agentState must map adapter ids to native or scripted");
    return [id, mode as StateMutationMode];
  })) as Partial<Record<AgentId, StateMutationMode>>;
  const maxChars = Number(context.maxChars ?? 16_000);
  if (!Number.isInteger(maxChars) || maxChars < 4_000 || maxChars > 128_000) throw new Error("context.maxChars must be an integer from 4000 to 128000");
  let schema: string | undefined;
  if (item.$schema !== undefined) {
    if (typeof item.$schema !== "string" || item.$schema.length > 512) throw new Error("config.$schema must be a string of at most 512 characters");
    schema = item.$schema;
  }
  return {
    $schema: schema,
    schemaVersion: Number(item.schemaVersion) as 1 | 2 | 3,
    extends: strings(item.extends ?? ["topology/single"], "config.extends"),
    specs: { roots: strings(object(item.specs ?? {}, "config.specs").roots ?? [], "config.specs.roots").map((entry) => safeRelative(entry, "config.specs.roots")) },
    commands: commands(item.commands, "config.commands"),
    rules: { include: strings(object(item.rules ?? {}, "config.rules").include ?? [], "config.rules.include").map((entry) => safeRelative(entry, "config.rules.include")) },
    risk: { default: riskDefault },
    context: { maxChars },
    agentState,
    tracker: tracker(item.tracker),
    mcp: mcp(item.mcp),
    loop: validateLoopConfig(item.loop)
  };
};

const readLocalProfile = (root: string, id: string): Profile | undefined => {
  const path = join(resolve(root), ".agents/project/profiles", safeRelative(id, "profile id"), "profile.json");
  if (!existsSync(path)) return undefined;
  if (lstatSync(path).isSymbolicLink() || !realpathSync(path).startsWith(`${realpathSync(resolve(root))}${process.platform === "win32" ? "\\" : "/"}`)) throw new Error(`Profile escapes the project: ${id}`);
  return validateProfile(JSON.parse(readFileSync(path, "utf8")), id);
};

/** Resolves a list of profile ids into an ordered, cycle-free list of profiles. */
export const resolveProfiles = (root: string, ids: string[]): Profile[] => {
  const resolved: Profile[] = [];
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    const resolvedId = builtInProfiles[id] ? id : builtInProfiles[`topology/${id}`] ? `topology/${id}` : id;
    if (resolved.some((entry) => entry.id === resolvedId)) return;
    if (visiting.has(resolvedId)) throw new Error(`Profile cycle detected at ${resolvedId}`);
    visiting.add(resolvedId);
    const current = builtInProfiles[resolvedId] ?? readLocalProfile(root, resolvedId);
    if (!current) throw new Error(`Unknown profile: ${id}`);
    for (const parent of current.extends ?? []) visit(parent);
    visiting.delete(resolvedId);
    resolved.push(current);
  };
  ids.forEach(visit);
  return resolved;
};

const stable = (values: string[]): string[] => [...new Set(values)];
/** Merges built-in and local profiles with the project config into the effective configuration. */
export const resolveEffectiveConfig = (root: string, config: ProjectConfig) => {
  const profiles = resolveProfiles(root, config.extends);
  return {
    profiles,
    discovery: { roots: stable(profiles.flatMap((item) => item.discovery?.roots ?? ["."])), workspaceMarkers: stable(profiles.flatMap((item) => item.discovery?.workspaceMarkers ?? [])) },
    specs: { roots: stable([...profiles.flatMap((item) => item.specs?.roots ?? []), ...config.specs.roots]) },
    commands: Object.assign({}, ...profiles.map((item) => item.commands ?? {}), config.commands),
    rules: { include: stable([...profiles.flatMap((item) => item.rules?.include ?? []), ...config.rules.include]) },
    risk: config.risk,
    context: config.context,
    mcp: config.mcp,
    loop: config.loop ?? { mode: "off" }
  };
};

/** Expands rule include patterns into concrete markdown file paths inside the project. */
export const includedRuleFiles = (root: string, patterns: string[]): string[] => {
  const project = resolve(root);
  const realProject = realpathSync(project);
  const inside = (path: string): boolean => {
    if (lstatSync(path).isSymbolicLink()) return false;
    return realpathSync(path).startsWith(`${realProject}${process.platform === "win32" ? "\\" : "/"}`);
  };
  const files = new Set<string>();
  for (const pattern of patterns) {
    const safe = safeRelative(pattern, "rule include");
    if (safe.endsWith("/*.md")) {
      const directory = join(project, safe.slice(0, -5));
      if (existsSync(directory) && inside(directory)) for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (entry.endsWith(".md") && existsSync(path) && inside(path)) files.add(path);
      }
    } else {
      const target = join(project, safe);
      if (existsSync(target) && inside(target)) files.add(target);
    }
  }
  return [...files].filter((path) => dirname(path).startsWith(project) || path.startsWith(project)).sort();
};
