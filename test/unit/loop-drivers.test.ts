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
    assert.deepEqual(calls[0]!.slice(0, 2), ["exec", "--json"]);
    assert.equal(calls[0]![calls[0]!.indexOf("--sandbox") + 1], "workspace-write");
    assert.equal(calls[1]![calls[1]!.indexOf("resume") + 1], "thread-123");
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
    assert.deepEqual(calls[0]!.slice(0, 6), ["-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json"]);
    assert.ok(!calls.flat().includes("phase"));
    assert.equal(calls[0]![calls[0]!.indexOf("--permission-mode") + 1], "acceptEdits");
    assert.equal(calls[1]![calls[1]!.indexOf("--resume") + 1], "session-123");
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


test("command events carry only a redacted command summary; output never leaks", { skip: process.platform === "win32" }, async () => {
  await fixture("codex", `console.log(JSON.stringify({type:'thread.started',thread_id:'thread-error'})); console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'echo API_KEY=arbitrarycredential',exit_code:1,status:'failed',aggregated_output:'privatevalue'}})); console.log(JSON.stringify({type:'turn.completed'}));`, async (root) => {
    const { runAgentTurn } = await load();
    const events: unknown[] = [];
    const result = await runAgentTurn({ agent: "codex", root, prompt: "x", timeoutMs: 2000, onEvent: (event: unknown) => events.push(event) });
    assert.match(result.diagnostics.join(" "), /commandFailed exitCode=1/);
    assert.doesNotMatch(JSON.stringify({ events, diagnostics: result.diagnostics }), /arbitrarycredential|privatevalue/);
    assert.deepEqual(events.find((event: any) => event.type === "lifecycle_command"), { type: "lifecycle_command", exitCode: 1, status: "failed", summary: "echo API_KEY=[REDACTED]" });
    assert.ok(result.diagnostics.every((entry) => entry.length <= 512));
  });
  await fixture("claude", `console.log(JSON.stringify({type:'system',session_id:'session-error'})); console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'tool-1',name:'Bash',input:{command:'echo API_KEY=arbitrarycredential'}}]}})); console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool-1',is_error:true,content:'privatevalue'}]}})); console.log(JSON.stringify({type:'result',session_id:'session-error',result:'blocked'}));`, async (root) => {
    const { runAgentTurn } = await load();
    const events: unknown[] = [];
    const result = await runAgentTurn({ agent: "claude", root, prompt: "x", timeoutMs: 2000, onEvent: (event: unknown) => events.push(event) });
    assert.match(result.diagnostics.join(" "), /commandFailed exitCode=1/);
    assert.doesNotMatch(JSON.stringify({ events, diagnostics: result.diagnostics }), /arbitrarycredential|privatevalue/);
    assert.deepEqual(events.find((event: any) => event.type === "lifecycle_command"), { type: "lifecycle_command", exitCode: 1, status: "failed", summary: "echo API_KEY=[REDACTED]" });
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
    assert.deepEqual(calls[0]!.slice(0, 5), ["run", "--format", "json", "--standalone", "--auto"]);
    assert.equal(calls[0]![calls[0]!.indexOf("--model") + 1], "opencode-go/gpt-6-luna");
    assert.equal(calls[0]!.at(-1), "phase");
    assert.ok(!calls[0]!.includes("--session"));
    assert.equal(calls[1]![calls[1]!.indexOf("--session") + 1], "session-open");
    assert.equal(calls[1]!.at(-1), "resume");
    assert.ok(!calls.flat().some((arg) => arg.includes("AIDLC_OPENCODE_MODEL")));
    assert.equal(readFileSync(`${argsPath}.pwd`, "utf8"), root);
    delete process.env.FAKE_ARGS_PATH;
  });
});

test("OpenCode surfaces provider errors from the error event", { skip: process.platform === "win32" }, async () => {
  await fixture("opencode", `console.log(JSON.stringify({type:'step_start',sessionID:'session-open'})); console.log(JSON.stringify({type:'error',sessionID:'session-open',error:{type:'provider.no-route',message:'Model unavailable: opencode-go/flint-40b-free'}})); process.exit(1);`, async (root) => {
    const { runAgentTurn } = await load();
    await assert.rejects(runAgentTurn({ agent: "opencode", root, prompt: "x", timeoutMs: 2000, env: { ...process.env, AIDLC_OPENCODE_MODEL: "opencode-go/gpt-6-luna" } }), /Model unavailable: opencode-go\/flint-40b-free/);
  });
});

test("OpenCode streams text and tool activity to onEvent", { skip: process.platform === "win32" }, async () => {
  await fixture("opencode", `console.log(JSON.stringify({type:'step_start',sessionID:'session-open'})); console.log(JSON.stringify({type:'tool_use',sessionID:'session-open',part:{type:'tool',tool:'grep'}})); console.log(JSON.stringify({type:'text',sessionID:'session-open',part:{type:'text',text:'found matches'}})); console.log(JSON.stringify({type:'step_finish',sessionID:'session-open',part:{type:'step_finish',reason:'stop'}}));`, async (root) => {
    const { runAgentTurn } = await load();
    const events: Array<{ type: string }> = [];
    await runAgentTurn({ agent: "opencode", root, prompt: "x", timeoutMs: 2000, env: { ...process.env, AIDLC_OPENCODE_MODEL: "opencode-go/gpt-6-luna" }, onEvent: (event: { type: string }) => events.push(event) });
    assert.ok(events.some((event: any) => event.type === "agent_tool" && event.tool === "grep"));
    assert.ok(events.some((event: any) => event.type === "agent_text" && event.text === "found matches"));
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

test("summarize redacts secrets, collapses whitespace, and caps at 240 characters", async () => {
  const { summarize, toolSummary, MAX_SUMMARY_CHARS }: any = await import(modulePath);
  assert.equal(MAX_SUMMARY_CHARS, 240);
  const text = summarize("API_KEY=abc FOO_TOKEN=x  ghp_xxx\n sk_xxx curl -H 'Authorization: Bearer abc.def' sk-ant-0123456789abcdefXYZ");
  for (const secret of ["abc", "=x", "ghp_xxx", "sk_xxx", "abc.def", "sk-ant-0123456789abcdefXYZ"]) assert.ok(!text.includes(secret), `${secret} must be redacted: ${text}`);
  assert.match(text, /^API_KEY=\[REDACTED\] FOO_TOKEN=\[REDACTED\] \[REDACTED\] \[REDACTED\] curl/);
  assert.doesNotMatch(text, /\s{2}|\n/);
  const leaks: Array<[string, string]> = [
    ["AWS_SECRET_ACCESS_KEY=abcd1234 aws s3 ls", "abcd1234"],
    ["psql postgres://admin:hunter2@db/prod", "hunter2"],
    ["curl -u alice:s3cret https://example.test", "s3cret"],
    ["curl -H 'Authorization: Basic dXNlcjpwYXNz' x", "dXNlcjpwYXNz"],
    ["curl -H 'x-api-key: abc123zz' x", "abc123zz"],
    ["mysql -u root -phunter2 db", "hunter2"],
    ["export DB_PASS=topsecret", "topsecret"],
    ["tool --password hunter2", "hunter2"],
    ["tool --token=tok3n", "tok3n"],
    ["npm publish npm_abcdefghijklmnopqrstuvwxyz12", "npm_abcdefghijklmnopqrstuvwxyz12"],
    ["glpat-abcdefghijklmnop1234", "glpat-abcdefghijklmnop1234"],
    ["xoxb-1234567890-abcdef", "xoxb-1234567890-abcdef"],
    ["AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP"],
  ];
  for (const [input, secret] of leaks) assert.ok(!summarize(input).includes(secret), `${secret} must be redacted from ${input}: ${summarize(input)}`);
  for (const plain of ["npm test", "mkdir -p src/ui && ls", "git diff HEAD -- src", "sed -n 1,20p notes.md"]) assert.equal(summarize(plain), plain);
  for (const flagged of ["kubectl get secret my-secret -o yaml"]) assert.match(summarize(flagged), /my-secret/, "a flag-like word inside a name is not a flag");
  const blob = "echo " + Buffer.alloc(300 * 1024, 7).toString("base64url").replace(/(.{40})/g, "$1-");
  const started = Date.now();
  assert.ok(summarize(blob).length <= 240);
  assert.ok(Date.now() - started < 500, "redaction stays fast on huge single-token inputs");
  const long = summarize("x".repeat(1000));
  assert.equal(long.length, 240);
  assert.ok(long.endsWith("…"));
  assert.equal(summarize(""), undefined);
  assert.equal(summarize(undefined), undefined);
  assert.equal(toolSummary("Bash", { command: "npm test", description: "run" }), "npm test");
  assert.equal(toolSummary("Edit", { file_path: "src/a.ts", old_string: "SECRET_TOKEN=1" }), "src/a.ts");
  assert.equal(toolSummary("Grep", { pattern: "ghp_secretvalue", path: "src" }), "src");
  assert.equal(toolSummary("WebSearch", { query: "API_KEY=zzz" }), 'WebSearch ["query"]');
  assert.equal(toolSummary("TodoWrite", undefined), "TodoWrite");
});

test("Claude emits a summarized agent_tool for every tool_use and the command on lifecycle_command", { skip: process.platform === "win32" }, async () => {
  await fixture("claude", `console.log(JSON.stringify({type:'system',session_id:'session-1'})); console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'t1',name:'Bash',input:{command:'API_KEY=abc FOO_TOKEN=x npm test --token ghp_xxx sk_xxx'}},{type:'tool_use',id:'t2',name:'Edit',input:{file_path:'src/ui/server.ts',old_string:'a',new_string:'b'}},{type:'tool_use',id:'t3',name:'Read',input:{file_path:'README.md'}},{type:'tool_use',id:'t4',name:'Glob',input:{pattern:'**/*.ts'}}]}})); console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'t1',content:'privateoutput'},{type:'tool_result',tool_use_id:'t2',content:'ok'}]}})); console.log(JSON.stringify({type:'result',session_id:'session-1',result:'done'}));`, async (root) => {
    const { runAgentTurn } = await load();
    const events: any[] = [];
    await runAgentTurn({ agent: "claude", root, prompt: "x", timeoutMs: 2000, onEvent: (event: unknown) => events.push(event) });
    const command = "API_KEY=[REDACTED] FOO_TOKEN=[REDACTED] npm test --token [REDACTED] [REDACTED]";
    assert.deepEqual(events.filter((event) => event.type === "agent_tool"), [
      { type: "agent_tool", tool: "Bash", summary: command },
      { type: "agent_tool", tool: "Edit", summary: "src/ui/server.ts" },
      { type: "agent_tool", tool: "Read", summary: "README.md" },
      { type: "agent_tool", tool: "Glob", summary: 'Glob ["pattern"]' },
    ]);
    assert.deepEqual(events.filter((event) => event.type === "lifecycle_command"), [
      { type: "lifecycle_command", exitCode: 0, status: "completed", summary: command },
    ], "only shell tools map to lifecycle commands");
    assert.ok(!events.some((event) => event.type === "agent_event"), "raw provider events are no longer forwarded");
    assert.doesNotMatch(JSON.stringify(events), /abc|ghp_xxx|sk_xxx|privateoutput/);
  });
});

test("Codex emits agent_tool and lifecycle_command summaries for commands and file changes", { skip: process.platform === "win32" }, async () => {
  await fixture("codex", `console.log(JSON.stringify({type:'thread.started',thread_id:'thread-1'})); console.log(JSON.stringify({type:'item.started',item:{type:'command_execution',command:'npm test'}})); console.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'FOO_TOKEN=x npm test',exit_code:0,status:'completed',aggregated_output:'privateoutput'}})); console.log(JSON.stringify({type:'item.completed',item:{type:'file_change',changes:[{path:'src/a.ts',kind:'update'},{path:'src/b.ts',kind:'add'}],status:'completed'}})); console.log(JSON.stringify({type:'turn.completed'}));`, async (root) => {
    const { runAgentTurn } = await load();
    const events: any[] = [];
    await runAgentTurn({ agent: "codex", root, prompt: "x", timeoutMs: 2000, onEvent: (event: unknown) => events.push(event) });
    assert.deepEqual(events.filter((event) => event.type === "agent_tool" || event.type === "lifecycle_command"), [
      { type: "agent_tool", tool: "shell", summary: "FOO_TOKEN=[REDACTED] npm test" },
      { type: "lifecycle_command", exitCode: 0, status: "completed", summary: "FOO_TOKEN=[REDACTED] npm test" },
      { type: "agent_tool", tool: "file_change", summary: "src/a.ts, src/b.ts" },
    ]);
    assert.ok(!events.some((event) => event.type === "agent_event"));
    assert.doesNotMatch(JSON.stringify(events), /privateoutput/);
  });
});

test("OpenCode summarizes tool input and shell commands", { skip: process.platform === "win32" }, async () => {
  await fixture("opencode", `console.log(JSON.stringify({type:'step_start',sessionID:'s'})); console.log(JSON.stringify({type:'tool_use',sessionID:'s',part:{tool:'shell',state:{status:'completed',input:{command:'API_KEY=abc make build'},output:'privateoutput',metadata:{metadata:{exit:0}}}}})); console.log(JSON.stringify({type:'tool_use',sessionID:'s',part:{tool:'edit',state:{status:'completed',input:{filePath:'src/x.ts',oldString:'a',newString:'b'}}}})); console.log(JSON.stringify({type:'tool_use',sessionID:'s',part:{tool:'list',state:{status:'completed',input:{path:'src'}}}})); console.log(JSON.stringify({type:'step_finish',sessionID:'s',part:{reason:'stop'}}));`, async (root) => {
    const { runAgentTurn } = await load();
    const events: any[] = [];
    await runAgentTurn({ agent: "opencode", root, prompt: "x", timeoutMs: 2000, env: { ...process.env, AIDLC_OPENCODE_MODEL: "opencode-go/gpt-6-luna" }, onEvent: (event: unknown) => events.push(event) });
    assert.deepEqual(events.filter((event) => event.type === "agent_tool" || event.type === "lifecycle_command"), [
      { type: "agent_tool", tool: "shell", summary: "API_KEY=[REDACTED] make build" },
      { type: "lifecycle_command", exitCode: 0, status: "completed", summary: "API_KEY=[REDACTED] make build" },
      { type: "agent_tool", tool: "edit", summary: "src/x.ts" },
      { type: "agent_tool", tool: "list", summary: "src" },
    ]);
    assert.doesNotMatch(JSON.stringify(events), /abc|privateoutput/);
  });
});
