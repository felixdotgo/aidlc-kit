import { cpSync } from "node:fs";

cpSync("assets/aidlc/scripts/lib/store.mjs", "services/aidlc-coordination/src/lifecycle-core.mjs");
cpSync("assets/aidlc/scripts/lib/store-sqlite.mjs", "services/aidlc-coordination/src/store-sqlite.mjs");
console.log("synced lifecycle core");
