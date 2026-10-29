import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

const modulePath = resolve("dist/assets/.agents/aidlc/scripts/lib/loop-drivers.mjs");
const load = async (): Promise<{ runAgentTurn: (args: Record<string, unknown>) => Promise<{ sessionId: string; resultText: string; diagnostics: string[] }> }> => import(modulePath);
const executable = (root: string, name: string, body: string) => {
  const path = join(root, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
};
const fixture = async (name: string, body: string, run: (root: string) => Promise<void>) => {
  const root = mkdtempSync(join(tmpdir(), `aidlc-loop-${name}-`));
  const oldPath = process.env.PATH;
  try {
    executable(root, name, body);
    process.env.PATH = `${root}${delimiter}${oldPath ?? ""}`;
    await run(root);
  } finally {
    process.env.PATH = oldPath;
    delete process.env.FAKE_ARGS_PATH;
    rmSync(root, { recursive: true, force: true });
  }
};

test("agent adapter registration and provider preflight are explicit and fail closed", async () => {
  const { registerAgentAdapter, preflightAgentAdapter }: any = await import(modulePath);
  assert.throws(() => registerAgentAdapter("codex", {}), /duplicate/);
  assert.throws(() => registerAgentAdapter("bad/name", {}), /invalid/);
  await assert.rejects(preflightAgentAdapter("codex", { env: { PATH: "/nonexistent-aidlc-bin" } }), /unavailable/);
  await assert.rejects(preflightAgentAdapter("unknown-provider"), /Unknown agent/);
  registerAgentAdapter("trusted-test", { command: "testcli", arguments: () => [], parse: async () => {} });
  assert.throws(() => registerAgentAdapter("trusted-test", {}), /duplicate/);
});

test("Codex captures exact thread ID before completion and resumes by ID", { skip: process.platform === "win32" }, async () => {
  await fixture("codex", `const fs=require('node:fs'); fs.appendFileSync(process.env.FAKE_ARGS_PATH,JSON.stringify(process.argv.slice(2))+'\\n'); console.log(JSON.stringify({type:'thread.started',thread_id:'thread-123'})); console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'node .agents/aidlc/scripts/state.mjs task next demo',exit_code:0,status:'completed'}})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}})); console.log(JSON.stringify({type:'turn.completed'}));`, async (root) => {
    const argsPath = join(root, "args.jsonl"); process.env.FAKE_ARGS_PATH = argsPath;
    const { runAgentTurn } = await load(); const ids: string[] = []; const events: Array<{ type: string }> = [];
    const first = await runAgentTurn({ agent: "codex", root, prompt: "phase", timeoutMs: 2000, onSessionId: (id: string) => ids.push(id), onEvent: (event: { type: string }) => events.push(event) });
    assert.equal(first.sessionId, "thread-123"); assert.equal(first.resultText, "done"); assert.deepEqual(ids, ["thread-123"]);
    assert.ok(events.some((event) => event.type === "lifecycle_command"));
    const second = await runAgentTurn({ agent: "codex", root, sessionId: first.sessionId, prompt: "resume", timeoutMs: 2000 });
    assert.equal(second.sessionId, "thread-123");
    const calls = readFileSync(argsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls[0].slice(0, 2), ["exec", "--json"]);
    assert.equal(calls[0][calls[0].indexOf("--sandbox") + 1], "workspace-write");
    assert.equal(calls[1][calls[1].indexOf("resume") + 1], "thread-123");
    assert.ok(!calls.flat().includes("phase"));
    assert.ok(!calls.flat().includes("--last"));
    assert.ok(!calls.flat().includes("--dangerously-bypass-approvals-and-sandbox"));
    delete process.env.FAKE_ARGS_PATH;
  });
});

test("Claude captures session, reports Bash completion, and resumes by ID", { skip: process.platform === "win32" }, async () => {
  await fixture("claude", `const fs=require('node:fs'); fs.appendFileSync(process.env.FAKE_ARGS_PATH,JSON.stringify(process.argv.slice(2))+'\\n'); console.log(JSON.stringify({type:'system',subtype:'init',session_id:'session-123'})); console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'tool-1',name:'Bash',input:{command:'node .agents/aidlc/scripts/state.mjs task next demo'}}]}})); console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool-1',content:'ok'}]}})); console.log(JSON.stringify({type:'result',session_id:'session-123',result:'done',is_error:false}));`, async (root) => {
    const argsPath = join(root, "args.jsonl"); process.env.FAKE_ARGS_PATH = argsPath;
    const { runAgentTurn } = await load(); const ids: string[] = []; const events: Array<{ type: string }> = [];
    const first = await runAgentTurn({ agent: "claude", root, prompt: "phase", timeoutMs: 2000, onSessionId: (id: string) => ids.push(id), onEvent: (event: { type: string }) => events.push(event) });
    assert.deepEqual(ids, ["session-123"]); assert.equal(first.resultText, "done");
    assert.ok(events.some((event) => event.type === "lifecycle_command"));
    await runAgentTurn({ agent: "claude", root, sessionId: first.sessionId, prompt: "resume", timeoutMs: 2000 });
    const calls = readFileSync(argsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls[0].slice(0, 6), ["-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json"]);
    assert.ok(!calls.flat().includes("phase"));
    assert.equal(calls[0][calls[0].indexOf("--permission-mode") + 1], "acceptEdits");
    assert.equal(calls[1][calls[1].indexOf("--resume") + 1], "session-123");
    assert.ok(!calls.flat().includes("--dangerously-skip-permissions"));
    delete process.env.FAKE_ARGS_PATH;
  });
});

test("drivers reject malformed output and missing session IDs", { skip: process.platform === "win32" }, async () => {
  for (const agent of ["codex", "claude"]) {
    await fixture(agent, `console.log('not json');`, async (root) => {
      const { runAgentTurn } = await load();
      await assert.rejects(runAgentTurn({ agent, root, prompt: "x", timeoutMs: 2000 }), /malformed JSONL/);
    });
  }
  await fixture("codex", `console.log(JSON.stringify({type:'turn.completed'}));`, async (root) => {
    const { runAgentTurn } = await load();
    await assert.rejects(runAgentTurn({ agent: "codex", root, prompt: "x", timeoutMs: 2000 }), /explicit captured session ID/);
  });
  await fixture("claude", `console.log(JSON.stringify({type:'result',result:'done'}));`, async (root) => {
    const { runAgentTurn } = await load();
    await assert.rejects(runAgentTurn({ agent: "claude", root, prompt: "x", timeoutMs: 2000 }), /explicit captured session ID/);
  });
});

test("driver timeout stops the child and bounds redacted stderr", { skip: process.platform === "win32" }, async () => {
  await fixture("codex", `console.error('API_TOKEN=supersecret sk_fixturesecret '+ 'x'.repeat(10000)); setInterval(()=>{},1000);`, async (root) => {
    const { runAgentTurn } = await load();
    await assert.rejects(runAgentTurn({ agent: "codex", root, prompt: "x", timeoutMs: 100 }), /timed out/);
  });
  await fixture("codex", `console.error('API_TOKEN=supersecret sk_fixturesecret '+ 'x'.repeat(10000)); process.exit(2);`, async (root) => {
    const { runAgentTurn } = await load();
    await assert.rejects(runAgentTurn({ agent: "codex", root, prompt: "x", timeoutMs: 2000 }), (error: unknown) => {
      const message = String(error); assert.ok(message.length < 700); assert.doesNotMatch(message, /supersecret|sk_fixturesecret/); assert.match(message, /REDACTED/); return true;
    });
  });
});

test("lease loss aborts a running agent turn", { skip: process.platform === "win32" }, async () => {
  await fixture("codex", `console.log(JSON.stringify({type:'thread.started',thread_id:'thread-abort'})); setInterval(()=>{},1000);`, async (root) => {
    const { runAgentTurn } = await load();
    const controller = new AbortController();
    const running = runAgentTurn({ agent: "codex", root, prompt: "x", timeoutMs: 5000, signal: controller.signal, onSessionId: () => controller.abort() });
    await assert.rejects(running, /turn aborted/);
  });
});


test("command events and failure diagnostics never contain command or output", { skip: process.platform === "win32" }, async () => {
  await fixture("codex", `console.log(JSON.stringify({type:'thread.started',thread_id:'thread-error'})); console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'echo arbitrarycredential',exit_code:1,status:'failed',aggregated_output:'privatevalue'}})); console.log(JSON.stringify({type:'turn.completed'}));`, async (root) => {
    const { runAgentTurn } = await load();
    const events: unknown[] = [];
    const result = await runAgentTurn({ agent: "codex", root, prompt: "x", timeoutMs: 2000, onEvent: (event: unknown) => events.push(event) });
    assert.match(result.diagnostics.join(" "), /commandFailed exitCode=1/);
    assert.doesNotMatch(JSON.stringify({ events, diagnostics: result.diagnostics }), /arbitrarycredential|privatevalue/);
    assert.deepEqual(events.find((event: any) => event.type === "lifecycle_command"), { type: "lifecycle_command", exitCode: 1, status: "failed" });
    assert.ok(result.diagnostics.every((entry) => entry.length <= 512));
  });
  await fixture("claude", `console.log(JSON.stringify({type:'system',session_id:'session-error'})); console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'tool-1',name:'Bash',input:{command:'echo arbitrarycredential'}}]}})); console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool-1',is_error:true,content:'privatevalue'}]}})); console.log(JSON.stringify({type:'result',session_id:'session-error',result:'blocked'}));`, async (root) => {
    const { runAgentTurn } = await load();
    const events: unknown[] = [];
    const result = await runAgentTurn({ agent: "claude", root, prompt: "x", timeoutMs: 2000, onEvent: (event: unknown) => events.push(event) });
    assert.match(result.diagnostics.join(" "), /commandFailed exitCode=1/);
    assert.doesNotMatch(JSON.stringify({ events, diagnostics: result.diagnostics }), /arbitrarycredential|privatevalue/);
    assert.deepEqual(events.find((event: any) => event.type === "lifecycle_command"), { type: "lifecycle_command", exitCode: 1, status: "failed" });
  });
});

test("provider prompts are delivered through stdin without appearing in argv", { skip: process.platform === "win32" }, async () => {
  for (const agent of ["codex", "claude"]) {
    await fixture(agent, `let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', x => input += x); process.stdin.on('end', () => { const fs=require('node:fs'); fs.writeFileSync(process.env.FAKE_ARGS_PATH,JSON.stringify({args:process.argv.slice(2),input})); ${agent === "codex" ? "console.log(JSON.stringify({type:'thread.started',thread_id:'thread-123'})); console.log(JSON.stringify({type:'turn.completed'}));" : "console.log(JSON.stringify({type:'result',session_id:'session-123',result:'done',is_error:false}));"} });`, async (root) => {
      const capture = join(root, "capture.json"); process.env.FAKE_ARGS_PATH = capture;
      const { runAgentTurn } = await load();
      await runAgentTurn({ agent, root, prompt: "private requirement", timeoutMs: 2000 });
      const data = JSON.parse(readFileSync(capture, "utf8"));
      assert.ok(!JSON.stringify(data.args).includes("private requirement"));
      if (agent === "codex") assert.equal(data.input, "private requirement");
      else assert.equal(JSON.parse(data.input).message.content, "private requirement");
      delete process.env.FAKE_ARGS_PATH;
    });
  }
});

test("the shared provider enumeration is frozen and reusable by every gate", async () => {
  const { LOOP_PROVIDERS, LOOP_PROVIDER_LIST, isLoopProvider }: any = await import(modulePath);
  assert.deepEqual([...LOOP_PROVIDERS], ["codex", "claude", "opencode"]);
  assert.equal(Object.isFrozen(LOOP_PROVIDERS), true);
  assert.equal(LOOP_PROVIDER_LIST, "codex, claude, or opencode");
  assert.equal(isLoopProvider("opencode"), true);
  assert.equal(isLoopProvider("unknown"), false);
  assert.equal(isLoopProvider(undefined), false);
});

test("adapter capability flags are validated explicitly", async () => {
  const { registerAgentAdapter }: any = await import(modulePath);
  assert.throws(() => registerAgentAdapter("bad-capability", { command: "testcli", arguments: () => [], parse: async () => {}, completesOnExit: "yes" }), /requires a command/);
  registerAgentAdapter("trusted-capability", { command: "testcli", arguments: () => [], parse: async () => {}, completesOnExit: false });
});

test("OpenCode requires an explicit model and forwards session, model, and prompt in argv", { skip: process.platform === "win32" }, async () => {
  await fixture("opencode", `const fs=require('node:fs'); fs.appendFileSync(process.env.FAKE_ARGS_PATH, JSON.stringify(process.argv.slice(2))+'\\n'); fs.writeFileSync(process.env.FAKE_ARGS_PATH+'.pwd', String(process.env.PWD)); console.log(JSON.stringify({type:'step_start',sessionID:'session-open'})); console.log(JSON.stringify({type:'text',sessionID:'session-open',part:{type:'text',text:'done'}})); console.log(JSON.stringify({type:'step_finish',sessionID:'session-open',part:{type:'step_finish',reason:'stop'}}));`, async (root) => {
    const argsPath = join(root, "args.jsonl"); process.env.FAKE_ARGS_PATH = argsPath;
    const { runAgentTurn } = await load();
    const env = { ...process.env, AIDLC_OPENCODE_MODEL: "opencode-go/gpt-6-luna" };
    const first = await runAgentTurn({ agent: "opencode", root, prompt: "phase", timeoutMs: 2000, env });
    assert.equal(first.sessionId, "session-open");
    assert.equal(first.resultText, "done");
    const second = await runAgentTurn({ agent: "opencode", root, sessionId: first.sessionId, prompt: "resume", timeoutMs: 2000, env });
    assert.equal(second.sessionId, "session-open");
    const calls = readFileSync(argsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls[0].slice(0, 5), ["run", "--format", "json", "--standalone", "--auto"]);
    assert.equal(calls[0][calls[0].indexOf("--model") + 1], "opencode-go/gpt-6-luna");
    assert.equal(calls[0].at(-1), "phase");
    assert.ok(!calls[0].includes("--session"));
    assert.equal(calls[1][calls[1].indexOf("--session") + 1], "session-open");
    assert.equal(calls[1].at(-1), "resume");
    assert.ok(!calls.flat().some((arg) => arg.includes("AIDLC_OPENCODE_MODEL")));
    assert.equal(readFileSync(`${argsPath}.pwd`, "utf8"), root);
    delete process.env.FAKE_ARGS_PATH;
  });
});

test("OpenCode fails closed without a valid AIDLC_OPENCODE_MODEL", { skip: process.platform === "win32" }, async () => {
  await fixture("opencode", `console.log(JSON.stringify({type:'text',sessionID:'session-open',part:{type:'text',text:'should not run'}}));`, async (root) => {
    const { runAgentTurn } = await load();
    const exact = (error: unknown) => error instanceof Error && error.message === "opencode provider requires AIDLC_OPENCODE_MODEL";
    for (const model of [undefined, "", "invalid", "provider/", "provider/model#", "provider/model extra"]) {
      const env: Record<string, string | undefined> = { ...process.env, AIDLC_OPENCODE_MODEL: model };
      if (model === undefined) delete env.AIDLC_OPENCODE_MODEL;
      await assert.rejects(runAgentTurn({ agent: "opencode", root, prompt: "x", timeoutMs: 2000, env }), exact);
    }
  });
});

test("OpenCode maps text, shell exits, and stop events to the shared turn contract", { skip: process.platform === "win32" }, async () => {
  await fixture("opencode", `console.log(JSON.stringify({type:'step_start',sessionID:'session-open'})); console.log(JSON.stringify({type:'text',sessionID:'session-open',part:{type:'text',text:'first'}})); console.log(JSON.stringify({type:'tool_use',sessionID:'session-open',part:{type:'tool_use',tool:'shell',state:{status:'completed',metadata:{metadata:{exit:1}}}}})); console.log(JSON.stringify({type:'text',sessionID:'session-open',part:{type:'text',text:'second'}})); console.log(JSON.stringify({type:'step_finish',sessionID:'session-open',part:{type:'step_finish',reason:'stop'}}));`, async (root) => {
    const { runAgentTurn } = await load();
    const events: Array<{ type: string }> = [];
    const result = await runAgentTurn({ agent: "opencode", root, prompt: "x", timeoutMs: 2000, env: { ...process.env, AIDLC_OPENCODE_MODEL: "opencode-go/gpt-6-luna" }, onEvent: (event: { type: string }) => events.push(event) });
    assert.equal(result.sessionId, "session-open");
    assert.equal(result.resultText, "second");
    assert.deepEqual(events.find((event) => event.type === "lifecycle_command"), { type: "lifecycle_command", exitCode: 1, status: "completed" });
    assert.match(result.diagnostics.join(" "), /commandFailed exitCode=1/);
  });
});

test("OpenCode shell error status maps to a failed lifecycle command", { skip: process.platform === "win32" }, async () => {
  await fixture("opencode", `console.log(JSON.stringify({type:'step_start',sessionID:'session-open'})); console.log(JSON.stringify({type:'tool_use',sessionID:'session-open',part:{type:'tool_use',tool:'shell',state:{status:'error',metadata:{metadata:{}}}}})); console.log(JSON.stringify({type:'step_finish',sessionID:'session-open',part:{type:'step_finish',reason:'stop'}}));`, async (root) => {
    const { runAgentTurn } = await load();
    const events: Array<{ type: string }> = [];
    const result = await runAgentTurn({ agent: "opencode", root, prompt: "x", timeoutMs: 2000, env: { ...process.env, AIDLC_OPENCODE_MODEL: "opencode-go/gpt-6-luna" }, onEvent: (event: { type: string }) => events.push(event) });
    assert.deepEqual(events.find((event) => event.type === "lifecycle_command"), { type: "lifecycle_command", exitCode: null, status: "failed" });
    assert.match(result.diagnostics.join(" "), /commandFailed exitCode=unknown status=failed/);
  });
});

test("adapters that complete on exit accept a clean turn without a completion event", { skip: process.platform === "win32" }, async () => {
  await fixture("opencode", `console.log(JSON.stringify({type:'step_start',sessionID:'session-open'})); console.log(JSON.stringify({type:'text',sessionID:'session-open',part:{type:'text',text:'done'}}));`, async (root) => {
    const { runAgentTurn } = await load();
    const result = await runAgentTurn({ agent: "opencode", root, prompt: "x", timeoutMs: 2000, env: { ...process.env, AIDLC_OPENCODE_MODEL: "opencode-go/gpt-6-luna" } });
    assert.equal(result.sessionId, "session-open");
    assert.equal(result.resultText, "done");
  });
  await fixture("codex", `console.log(JSON.stringify({type:'thread.started',thread_id:'thread-123'}));`, async (root) => {
    const { runAgentTurn } = await load();
    await assert.rejects(runAgentTurn({ agent: "codex", root, prompt: "x", timeoutMs: 2000 }), /without a completion event/);
  });
  await fixture("opencode", `console.log(JSON.stringify({type:'step_start',sessionID:'session-open'})); process.exit(1);`, async (root) => {
    const { runAgentTurn } = await load();
    await assert.rejects(runAgentTurn({ agent: "opencode", root, prompt: "x", timeoutMs: 2000, env: { ...process.env, AIDLC_OPENCODE_MODEL: "opencode-go/gpt-6-luna" } }), /exited 1/);
  });
});
