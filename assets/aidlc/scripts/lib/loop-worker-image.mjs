import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isLoopProvider } from "./loop-drivers.mjs";

/** Image tag must satisfy the same shape the Docker worker invocation accepts. */
const IMAGE_TAG = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/;

/** Deterministic default tag for a provider: `aidlc-worker-<provider>:local`. */
export const defaultWorkerImageTag = (provider) => `aidlc-worker-${provider}:local`;

/** Validate an explicit image tag the way `workerDockerInvocation` will. */
export const validWorkerImageTag = (tag) => typeof tag === "string" && IMAGE_TAG.test(tag);

/** Resolve the shipped Dockerfile for a provider inside an installed project. */
export const workerDockerfilePath = (root, provider) => join(root, ".agents", "aidlc", "docker", `Dockerfile.${provider}`);

const dockerEnv = (env = process.env) => ({ PATH: env.PATH ?? "/usr/bin:/bin" });

/** True when a local image with that tag already exists in the Docker daemon. */
export function dockerImageExists(image, env = process.env) {
  try {
    execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", image], { env: dockerEnv(env), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

/** Build a worker image from the shipped Dockerfile. Streams progress to the
 * terminal (stdio inherit) and returns the built tag. Never accepts a shell. */
export function buildWorkerImage({ root, provider, image, env = process.env, onEvent = () => {} }) {
  if (!isLoopProvider(provider)) throw new Error(`provider must be codex, claude, or opencode`);
  if (!validWorkerImageTag(image)) throw new Error("Explicit Docker image is required");
  const dockerfile = workerDockerfilePath(root, provider);
  if (!existsSync(dockerfile)) throw new Error(`Worker Dockerfile is missing: ${dockerfile}`);
  onEvent({ type: "worker_image_build", provider, image });
  execFileSync("docker", ["build", "-f", dockerfile, "-t", image, join(root, ".agents", "aidlc", "docker")], { env: dockerEnv(env), stdio: "inherit" });
  return image;
}

/** Build the image only when it is missing; otherwise return the existing tag. */
export function ensureWorkerImage({ root, provider, image, env = process.env, onEvent = () => {} }) {
  if (dockerImageExists(image, env)) return image;
  return buildWorkerImage({ root, provider, image, env, onEvent });
}

/** Persist the built tag into `config.loop.workerImage[provider]` so the local
 * supervisor can reuse it without a manual `export`. No-op when the project
 * config does not exist yet; credentials are never persisted. */
export function recordWorkerImage({ root, provider, image }) {
  if (!isLoopProvider(provider) || !validWorkerImageTag(image)) throw new Error("Cannot record an invalid worker image");
  const configPath = join(root, ".agents", "config.json");
  if (!existsSync(configPath)) return;
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (!config || typeof config !== "object" || Array.isArray(config)) return;
  const loop = (config.loop && typeof config.loop === "object" && !Array.isArray(config.loop)) ? config.loop : {};
  const workerImage = (loop.workerImage && typeof loop.workerImage === "object" && !Array.isArray(loop.workerImage)) ? loop.workerImage : {};
  if (workerImage[provider] === image) return;
  workerImage[provider] = image;
  loop.workerImage = workerImage;
  config.loop = loop;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
