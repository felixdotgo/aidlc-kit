/* Installed-workflow manifest: the managed-file inventory recorded by install and upgrade. */
import type { AgentId } from "./lifecycle-enums.js";

export interface ManifestInventoryItem {
  hash: string;
  owner: string;
  strategy: "replace" | "managed-block";
}

export interface WorkflowManifest {
  schemaVersion: 2;
  packageVersion: string;
  workflow: "AI-DLC";
  source: "local-package-assets";
  remoteUpdates: false;
  managedBy: "aidlc-kit" | "aidlc-workflow";
  adapters: AgentId[];
  files: Record<string, ManifestInventoryItem>;
}
