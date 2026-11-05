export const legacyV021Hashes: Readonly<Record<string, string>> = Object.freeze({
  ".agents/aidlc/conventions.md": "fa807e4430fcd1a0d21621c783becda61f8e61e9df9ab2e164e3ce0decc380db",
  ".agents/aidlc/orchestrator.md": "b5d38c1a4031f2a1cb5b58f2fdf2965a34c5ff86699f6af103cd0d97587b9f44",
  ".agents/aidlc/phase-build.md": "8384d67747acebfa87b06f0e11c58a0f2c661584d7d584ab8c382b6308263e29",
  ".agents/aidlc/phase-clarify.md": "a31e69c68a924c689933f5dff69cd94ee09b587171f838458ee7dbb6dd4eacf6",
  ".agents/aidlc/phase-index.md": "7473192914e44b39ce02a60ed79051a1827656305556ffa684ca7e3388827373",
  ".agents/aidlc/phase-plan.md": "242da8e20e099889c7f05ac7c582902515b86ea62c159e02202231051f7ac5f9",
  ".agents/aidlc/phase-wrap.md": "e2d108aa80a9fcee2e4a43b6ac53e451f18d4b26aee42728ca4788bba8883ef8",
  ".agents/aidlc/rules/gate-check.md": "b542365d1698f179f12128d3932743e4799378a1475d89400c294f30b2cecd1d",
  ".agents/aidlc/rules/stack-runtime.md": "023900a35372668fd69d23e11332ecc78f43df9ef9e75a86bdda2e7c442a0731",
  ".agents/aidlc/templates/board.md": "caedf04fa8b19790549ec53238fce4f5a96492d12f367dff930ed9d9f6a8c593",
  ".agents/aidlc/templates/design.md": "35849fb13083942eb32f201f86520961fe1c9971bc7e8d4ee9dd6921b32fcfaa",
  ".agents/aidlc/templates/intent.md": "a55c97b3babebd18b07ce50fdba5326bbb11ca7cf4cf2e5b8eae7f84304cce78",
  ".agents/aidlc/templates/lesson.md": "1ac7b7f5f2ed937084cb42d069d0a0f764ee7a71868f6d4fb3437231a81789ac",
  ".agents/aidlc/templates/workplan.md": "2ad82fecd04cc87a211d5e8b2a813d1c1243180ee13544b0a5db58d2755c2b7b",
  ".agents/skills/aidlc-build/SKILL.md": "4f9221a5a80a561406b1ae54cd7731c6543fb509bb9b38b1a2a4639e2842f552",
  ".agents/skills/aidlc-clarify/SKILL.md": "6b481d5bf87d476d2bd09c1d627d85203da87e3bbb640851e34d32cf086f80f1",
  ".agents/skills/aidlc-index/SKILL.md": "dedb6b91f666bc32f39a51e6f378760d0718ccfd8edbe01a667898e6e18599be",
  ".agents/skills/aidlc-plan/SKILL.md": "141b3abd065562f95f249fcf2509ceb095d554a8ccc62fd45de214ab82a4b387",
  ".agents/skills/aidlc-wrap/SKILL.md": "51e06614d074c8ed008575bb099fe97f0d402633c37225f4874b5408a5382be8"
});

const instruction = (agent: string): string => [
  `# AI-DLC for ${agent}`,
  "",
  "Read `.agents/aidlc/orchestrator.md` and `.agents/data/state/BOARD.md` before starting non-trivial work. Use phase skills under `.agents/skills/`; do not fetch remote workflow content. Respect more-specific instructions already present in this repository.",
  ""
].join("\n");

/** Frozen v0.2.1 baseline payload — intentionally does NOT reuse managed-content markers: this string is a historical fact that must not track future marker-format changes. */
const block = (owner: string, body: string): string => `<!-- aidlc-installer:${owner} -->\n${body}`;

export const legacyV021AdapterContents: Readonly<Record<string, string>> = Object.freeze({
  "CLAUDE.md": block("claude", instruction("Claude Code")),
  ".claude/skills/aidlc/SKILL.md": block("claude", instruction("Claude Code")),
  "AGENTS.md": block("codex", instruction("Codex")),
  ".cursor/rules/aidlc.mdc": block("cursor", `---\ndescription: AI-DLC workflow\nalwaysApply: true\n---\n\n${instruction("Cursor")}`),
  ".agents/rules/aidlc.md": block("antigravity", instruction("Google Antigravity")),
  ".kiro/steering/aidlc.md": block("kiro", instruction("Kiro")),
  ".agents/aidlc/adapters/generic-instructions.md": block("generic", instruction("compatible agent"))
});
