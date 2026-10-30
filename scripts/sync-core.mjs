import { cpSync } from "node:fs";

cpSync("assets/aidlc/scripts/lib/store.mjs", "services/aidlc-coordination/src/lifecycle-core.mjs");
console.log("synced lifecycle core");
