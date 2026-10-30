import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

rmSync("dist", { recursive: true, force: true });
const output = "dist/assets/.agents";
mkdirSync(output, { recursive: true });
cpSync("assets/aidlc", join(output, "aidlc"), { recursive: true });
cpSync("skills", join(output, "skills"), { recursive: true });
cpSync("services/aidlc-coordination", "dist/services/aidlc-coordination", { recursive: true, filter: (path) => !path.includes("node_modules") });
const rootVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
const servicePackagePath = "dist/services/aidlc-coordination/package.json";
const servicePackage = JSON.parse(readFileSync(servicePackagePath, "utf8"));
servicePackage.version = rootVersion;
writeFileSync(servicePackagePath, JSON.stringify(servicePackage, null, 2) + "\n");
const serviceLockPath = "dist/services/aidlc-coordination/package-lock.json";
try { const lock = JSON.parse(readFileSync(serviceLockPath, "utf8")); if (Object.prototype.hasOwnProperty.call(lock, "version")) lock.version = rootVersion; if (lock.packages && lock.packages[""] && Object.prototype.hasOwnProperty.call(lock.packages[""], "version")) lock.packages[""].version = rootVersion; writeFileSync(serviceLockPath, JSON.stringify(lock, null, 2) + "\n"); } catch {}
cpSync("assets/aidlc/scripts/lib/store.mjs", "dist/services/aidlc-coordination/src/lifecycle-core.mjs");
cpSync("dev/evaluator/assets", "dist/dev/evaluator/assets", { recursive: true });
