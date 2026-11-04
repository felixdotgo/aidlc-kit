/** Render foreground loop progress to stderr without polluting stdout JSON. */
export function streamLog(event) {
  if (!event || typeof event.type !== "string") return;
  switch (event.type) {
    case "turn_start":
      process.stderr.write(`\n━━ turn ${Number(event.iteration ?? 0) + 1} · phase ${event.phase ?? "?"} · agent ${event.agent ?? "?"} ━━\n`);
      break;
    case "turn_end":
      process.stderr.write(`━━ turn done ━━\n`);
      break;
    case "agent_text":
      process.stderr.write(`${event.text ?? ""}\n`);
      break;
    case "agent_tool":
      process.stderr.write(`  › tool: ${event.tool ?? "?"}\n`);
      break;
    case "lifecycle_command":
      process.stderr.write(`  › command ${event.status ?? "?"} (exit ${event.exitCode ?? "?"})\n`);
      break;
    case "gate":
      process.stderr.write(`\n${event.gateView ?? `Gate ${event.gate ?? "?"} reached — approve from the trusted terminal.`}\n`);
      break;
    default:
      break;
  }
}
