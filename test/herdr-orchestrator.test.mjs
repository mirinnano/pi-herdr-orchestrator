import assert from "node:assert/strict";
import { test } from "node:test";
import herdrOrchestrator, {
  buildHerdrCommand,
  buildHerdrStartCommand,
  executeHerdrAction,
  parseSnapshotOutput,
  resolveReadTarget,
  resolveRecognizedAgent,
  resolveRequestedModel,
  resolveStartPane,
  sanitizeSnapshot,
  sanitizeTerminalOutput,
} from "../extensions/herdr-orchestrator.ts";

const fixture = {
  type: "session_snapshot",
  snapshot: {
    version: "0.9.1",
    protocol: 22,
    focused_workspace_id: "w1",
    focused_tab_id: "w1:t1",
    focused_pane_id: "w1:p1",
    workspaces: [{
      workspace_id: "w1", number: 1, label: "project", focused: true,
      pane_count: 2, tab_count: 1, active_tab_id: "w1:t1", agent_status: "working",
      tokens: { HERDR_TOKEN: "workspace-token-secret" },
      worktree: { checkout_path: "/private/checkout", branch: "main" },
    }],
    tabs: [{
      tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "coding", focused: true,
      pane_count: 2, agent_status: "working",
    }],
    panes: [
      {
        pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "terminal-secret",
        focused: true, agent_status: "working", label: "review", cwd: "/private/project",
        tokens: { API_KEY: "pane-token-secret" },
        agent_session: { kind: "path", value: "/private/agent-session.jsonl", agent: "codex", source: "test" },
      },
      {
        pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "terminal-2",
        focused: false, agent_status: "idle", label: "shell", agent: null,
      },
    ],
    agents: [
      {
        name: "reviewer", agent: "codex", pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1",
        focused: true, agent_status: "working", interactive_ready: true,
        agent_session: { kind: "path", value: "/private/agent-session.jsonl", agent: "codex", source: "test" },
        tokens: { SESSION: "agent-token-secret" }, cwd: "/private/project",
      },
      {
        name: "unrecognized", agent: null, pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1",
        focused: false, agent_status: "unknown",
      },
    ],
    layouts: [],
  },
};

const snapshotJson = JSON.stringify(fixture);
function snapshotWithAgentStatus(status) {
  const value = structuredClone(fixture);
  value.snapshot.agents[0].agent_status = status;
  value.snapshot.panes[0].agent_status = status;
  return JSON.stringify(value);
}
const idleSnapshotJson = snapshotWithAgentStatus("idle");
function snapshotWithWorkers(firstStatus = "idle", secondStatus = "done") {
  const value = structuredClone(fixture);
  value.snapshot.agents[0].agent = "pi";
  value.snapshot.agents[0].agent_status = firstStatus;
  value.snapshot.panes[0].agent_status = firstStatus;
  value.snapshot.agents[1] = {
    name: "tester", agent: "pi", pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1",
    focused: false, agent_status: secondStatus,
  };
  value.snapshot.panes[1].agent = "pi";
  value.snapshot.panes[1].agent_status = secondStatus;
  return value;
}
function snapshotWithStartedWorker() {
  const value = snapshotWithWorkers("working", "idle");
  value.snapshot.agents[1].name = "worker2";
  value.snapshot.agents[1].agent_status = "idle";
  return JSON.stringify(value);
}
const success = (stdout = "") => ({ stdout, stderr: "", code: 0, killed: false });

function mockedExec(responses) {
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({ command, args: [...args], options });
    const response = responses.shift();
    if (!response) throw new Error("unexpected command");
    return typeof response === "function" ? response({ command, args, options, calls }) : response;
  };
  return { exec, calls };
}

function replyForPrompt(prompt, body) {
  const partA = prompt.match(/part A '([a-f0-9]{16})'/)?.[1];
  const partB = prompt.match(/part B '([a-f0-9]{16})'/)?.[1];
  assert.ok(partA && partB, "prompt includes unique reply marker parts");
  const marker = `HERDR-REPLY-${partA}-${partB}`;
  assert.equal(prompt.includes(marker), false, "complete marker is not present in the request");
  return `${marker}\n${body}\n${marker}`;
}

function withHerdrEnv(value, callback) {
  const previous = process.env.HERDR_ENV;
  if (value === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = value;
  try { return callback(); }
  finally {
    if (previous === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previous;
  }
}

test("parses direct and supported wrapped session snapshots, rejects malformed data", () => {
  assert.equal(parseSnapshotOutput(snapshotJson).panes.length, 2);
  assert.equal(parseSnapshotOutput(JSON.stringify({ result: fixture })).agents.length, 2);
  assert.equal(parseSnapshotOutput(JSON.stringify({ result: { type: "session_snapshot", snapshot: fixture.snapshot } })).workspaces.length, 1);
  assert.throws(() => parseSnapshotOutput("not json"), /invalid snapshot/i);
  assert.throws(() => parseSnapshotOutput('{"result":{}}'), /unsupported snapshot/i);
});

test("snapshot sanitizer allowlists layout metadata and excludes tokens, paths, and session internals", () => {
  const safe = sanitizeSnapshot(fixture.snapshot);
  const serialized = JSON.stringify(safe);
  assert.deepEqual(safe.workspaces[0], {
    id: "w1", label: "project", number: 1, focused: true, status: "working", tabs: 1, panes: 2,
  });
  assert.equal(safe.agents.length, 1);
  assert.equal(safe.agents[0].name, "reviewer");
  assert.equal(safe.panes[0].agent, "reviewer");
  const unsafeLabels = structuredClone(fixture.snapshot);
  unsafeLabels.tabs[0].label = "cwd=/private/agent-session.jsonl HERDR_ENV=1";
  assert.doesNotMatch(JSON.stringify(sanitizeSnapshot(unsafeLabels)), /agent-session\\.jsonl|HERDR_ENV=1/);
  for (const secret of [
    "workspace-token-secret", "pane-token-secret", "agent-token-secret", "/private/agent-session.jsonl",
    "/private/project", "/private/checkout", "terminal-secret", "API_KEY",
  ]) assert.equal(serialized.includes(secret), false, `unexpected leaked field: ${secret}`);
});

test("allowlist accepts one exact pane or recognized agent, never fuzzy or unrecognized targets", () => {
  assert.deepEqual(resolveRecognizedAgent(fixture.snapshot, "reviewer"), {
    cliTarget: "reviewer", paneId: "w1:p1", agentName: "reviewer", agentKind: "codex", status: "working",
  });
  assert.deepEqual(resolveRecognizedAgent(fixture.snapshot, "w1:p1"), {
    cliTarget: "reviewer", paneId: "w1:p1", agentName: "reviewer", agentKind: "codex", status: "working",
  });
  assert.deepEqual(resolveReadTarget(fixture.snapshot, "w1:p2"), { paneId: "w1:p2", agent: null });
  assert.throws(() => resolveRecognizedAgent(fixture.snapshot, "unrecognized"), /not a recognized agent/i);
  assert.throws(() => resolveRecognizedAgent(fixture.snapshot, "review"), /not a recognized agent/i);
  assert.throws(() => resolveReadTarget(fixture.snapshot, "w1:p404"), /not present/i);
  assert.throws(() => resolveRecognizedAgent(fixture.snapshot, "reviewer; herdr agent list"), /exact/i);
});

test("new long-lived Pi creation targets only a vacant Herdr shell pane", () => {
  assert.deepEqual(resolveStartPane(fixture.snapshot, "w1:p2", "worker2"), { paneId: "w1:p2", name: "worker2" });
  assert.throws(() => resolveStartPane(fixture.snapshot, "w1:p1", "worker2"), /already contains/i);
  assert.throws(() => resolveStartPane(fixture.snapshot, "w1:p2", "reviewer"), /already in use/i);
  const busy = structuredClone(fixture.snapshot);
  busy.panes[1].agent_status = "working";
  assert.throws(() => resolveStartPane(busy, "w1:p2", "worker2"), /positively idle.*working/);
  const unknown = structuredClone(fixture.snapshot);
  delete unknown.panes[1].agent_status;
  assert.throws(() => resolveStartPane(unknown, "w1:p2", "worker2"), /positively idle.*unknown/);
  const startCommand = buildHerdrStartCommand("worker2", "w1:p2");
  assert.equal(startCommand.command, "herdr");
  assert.deepEqual(startCommand.args.slice(0, 8), ["agent", "start", "worker2", "--kind", "pi", "--pane", "w1:p2", "--timeout"]);
  assert.equal(startCommand.args[8], "30000");
  assert.deepEqual(startCommand.args.slice(9, 11), ["--", "--exclude-tools"]);
  assert.match(startCommand.args[11], /herdr_swarm,spawn_agent.*interrupt_agent/);
  assert.equal(startCommand.args[12], "--append-system-prompt");
  assert.match(startCommand.args[13], /Role: Herdr worker/);
  assert.equal(startCommand.timeout, 40_000);
});

test("model requests are exact, available, and restricted to Pi workers", () => {
  const models = [{ provider: "openai-codex", id: "gpt-5.6" }];
  assert.deepEqual(resolveRequestedModel("openai-codex", "gpt-5.6", "pi", models), models[0]);
  assert.throws(() => resolveRequestedModel("openai", "unknown", "pi", models), /not available/);
  assert.throws(() => resolveRequestedModel("openai-codex", "gpt-5.6", "codex", models), /only for Pi peers/);
  assert.throws(() => resolveRequestedModel("openai-codex", undefined, "pi", models), /requires both/);
});

test("command construction uses fixed Herdr argv and bounds all user-controlled values", () => {
  const agent = resolveRecognizedAgent(fixture.snapshot, "reviewer");
  assert.deepEqual(buildHerdrCommand("list", { action: "list" }), {
    command: "herdr", args: ["api", "snapshot"], timeout: 15_000,
  });
  assert.deepEqual(buildHerdrCommand("read", { action: "read", lines: 12 }, { paneId: "w1:p2" }).args, [
    "pane", "read", "w1:p2", "--source", "recent-unwrapped", "--lines", "12", "--format", "text",
  ]);
  assert.deepEqual(buildHerdrCommand("focus", { action: "focus" }, agent).args, ["agent", "focus", "reviewer"]);
  const promptCommand = buildHerdrCommand("prompt", { action: "prompt", prompt: "-- review the patch" }, agent);
  assert.equal(promptCommand.args[0], "agent");
  assert.equal(promptCommand.args[1], "prompt");
  assert.equal(promptCommand.args[2], "reviewer");
  assert.match(promptCommand.args[3], /^Request:\n-- review the patch\n\nReply protocol:/);
  assert.match(promptCommand.args[3], /first and last lines/);
  assert.ok(promptCommand.replyMarker);
  assert.equal(promptCommand.args[3].includes(promptCommand.replyMarker), false);
  assert.deepEqual(promptCommand.args.slice(4), ["--wait", "--timeout", "120000"]);
  assert.equal(promptCommand.args.includes("--"), false);
  assert.equal(promptCommand.timeout, 130_000);
  assert.deepEqual(buildHerdrCommand("wait", { action: "wait", timeout_ms: 5_000 }, agent).args, [
    "agent", "wait", "reviewer", "--timeout", "5000",
  ]);
  assert.throws(() => buildHerdrCommand("read", { action: "read", lines: 81 }, { paneId: "w1:p2" }), /between 1 and 80/);
  assert.throws(() => buildHerdrCommand("wait", { action: "wait", timeout_ms: 0 }, agent), /between 1000/);
  assert.throws(() => buildHerdrCommand("prompt", { action: "prompt", prompt: "x".repeat(2_401) }, agent), /characters/);
});

test("terminal output strips control sequences, redacts environment lines, warns via data, and is capped", () => {
  const safe = sanitizeTerminalOutput("hello\u001b[31m red\u001b[0m\nHERDR_ENV=1\nAPI_KEY=secret\nnormal text");
  assert.match(safe.text, /hello red/);
  assert.doesNotMatch(safe.text, /\u001b|HERDR_ENV=1|API_KEY=secret/);
  assert.equal(safe.environmentRedacted, true);
  assert.match(sanitizeTerminalOutput("declare -x ACCESS_TOKEN=secret").text, /environment variable redacted/);
  const envJson = sanitizeTerminalOutput('{"PATH":"/private","HOME":"/private/home","HERDR_ENV":"1"}');
  assert.match(envJson.text, /suppressed/);
  assert.equal(envJson.environmentRedacted, true);
  const long = sanitizeTerminalOutput("x".repeat(7_000));
  assert.equal(long.truncated, true);
  assert.ok(long.text.length < 6_100);
});

test("list uses only the read-only snapshot command and reports sanitized data", async () => {
  const mock = mockedExec([success(snapshotJson)]);
  const result = await executeHerdrAction({ action: "list" }, mock.exec, {
    herdrEnv: "1", cwd: "/repo",
    currentModel: { provider: "openai-codex", id: "gpt-5.6" },
    availableModels: [{ provider: "openai-codex", id: "gpt-5.6" }, { provider: "anthropic", id: "claude-opus" }],
  });
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].command, "herdr");
  assert.deepEqual(mock.calls[0].args, ["api", "snapshot"]);
  const text = result.content[0].text;
  assert.match(text, /reviewer/);
  assert.match(text, /modelCatalog/);
  assert.match(text, /openai-codex\/gpt-5\.6/);
  assert.doesNotMatch(text, /workspace-token-secret|agent-session\.jsonl|agent-token-secret/);
});

test("boss starts one vacant Pi pane and verifies the new long-lived agent", async () => {
  const mock = mockedExec([success(snapshotJson), success("started"), success(snapshotWithStartedWorker())]);
  const result = await executeHerdrAction({ action: "start", target: "w1:p2", name: "worker2", kind: "pi" }, mock.exec, {
    herdrEnv: "1", currentPaneId: "w1:p1", currentModel: { provider: "openai-codex", id: "gpt-5.6" },
  });
  assert.equal(mock.calls.length, 3);
  assert.deepEqual(mock.calls[1].args, buildHerdrStartCommand("worker2", "w1:p2").args);
  const started = JSON.parse(result.content[0].text);
  assert.equal(started.action, "start");
  assert.equal(started.name, "worker2");
  assert.equal(started.result, "new Pi worker ready");
  assert.match(started.role, /herdr_swarm and task-scoped delegation tools are disabled/);
  assert.match(mock.calls[1].args[11], /herdr_swarm,spawn_agent/);

  const self = mockedExec([success(snapshotJson)]);
  const rejected = await executeHerdrAction({ action: "start", target: "w1:p2", name: "worker2" }, self.exec, {
    herdrEnv: "1", currentPaneId: "w1:p2",
  });
  assert.equal(self.calls.length, 1);
  assert.match(rejected.content[0].text, /current Pi pane/i);
});

test("accepted starts with failed verification are uncertain and never invite an automatic retry", async () => {
  const mock = mockedExec([success(snapshotJson), success("started"), { stdout: "", stderr: "snapshot unavailable", code: 1, killed: false }]);
  const result = await executeHerdrAction({ action: "start", target: "w1:p2", name: "worker2" }, mock.exec, {
    herdrEnv: "1", currentPaneId: "w1:p1",
  });
  assert.equal(mock.calls.length, 3);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /accepted the start request.*may already be running/i);
  assert.match(result.content[0].text, /inspect it before any retry/);
});

test("boss dispatches unique independent workers in parallel and collects bounded replies", async () => {
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({ command, args: [...args], options });
    if (args[0] === "api") return success(JSON.stringify(snapshotWithWorkers()));
    if (args[0] === "agent" && args[1] === "prompt") return success("accepted");
    if (args[0] === "pane" && args[1] === "read") {
      const target = args[2] === "w1:p1" ? "reviewer" : "tester";
      const prompt = calls.find((call) => call.args[0] === "agent" && call.args[1] === "prompt" && call.args[2] === target)?.args[3];
      return success(prompt ? replyForPrompt(prompt, `reply from ${args[2]}`) : "unmatched read");
    }
    throw new Error("unexpected command");
  };
  const result = await executeHerdrAction({
    action: "dispatch",
    timeout_ms: 3_000,
    assignments: [
      { target: "reviewer", task: "Inspect the API surface.", acceptance_criteria: "List risks and evidence." },
      { target: "tester", task: "Review test gaps.", acceptance_criteria: "Name at least one concrete gap or confirm none with evidence.", model_provider: "openai-codex", model_id: "gpt-5.6" },
    ],
  }, exec, {
    herdrEnv: "1",
    currentPaneId: "w9:p9",
    availableModels: [{ provider: "openai-codex", id: "gpt-5.6" }],
  });
  assert.equal(calls.length, 5);
  assert.equal(calls[0].args[0], "api");
  const prompts = calls.filter((call) => call.args[0] === "agent" && call.args[1] === "prompt");
  assert.deepEqual(prompts.map((call) => call.args[2]).sort(), ["reviewer", "tester"]);
  assert.equal(prompts.some((call) => call.args[3].includes("select_model")), true);
  assert.equal(prompts.some((call) => call.args[3].includes("Acceptance criteria")), true);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.agents.length, 2);
  assert.deepEqual(body.agents.map((agent) => agent.status), ["replied", "replied"]);
  assert.ok(body.agents.every((agent) => agent.reply.includes("HERDR-REPLY-")));
  assert.deepEqual(body.agents.map((agent) => agent.reply.includes("reply from")).sort(), [true, true]);
  const modelRequest = body.agents.find((agent) => agent.target === "tester");
  assert.equal(modelRequest.modelRequested, "openai-codex/gpt-5.6");
  assert.match(modelRequest.modelVerification, /worker-reported/);
});

test("dispatch validates every target before sending and never duplicates a pane", async () => {
  const duplicate = mockedExec([success(JSON.stringify(snapshotWithWorkers()))]);
  const result = await executeHerdrAction({
    action: "dispatch",
    assignments: [
      { target: "reviewer", task: "one", acceptance_criteria: "one" },
      { target: "w1:p1", task: "two", acceptance_criteria: "two" },
    ],
  }, duplicate.exec, { herdrEnv: "1" });
  assert.equal(duplicate.calls.length, 1);
  assert.match(result.content[0].text, /different agent pane/);

  const wrongModel = mockedExec([success(idleSnapshotJson)]);
  const invalid = await executeHerdrAction({
    action: "dispatch",
    assignments: [{ target: "reviewer", task: "one", acceptance_criteria: "one", model_provider: "openai", model_id: "gpt-5.6" }],
  }, wrongModel.exec, { herdrEnv: "1", availableModels: [{ provider: "openai", id: "gpt-5.6" }] });
  assert.equal(wrongModel.calls.length, 1);
  assert.match(invalid.content[0].text, /only for Pi peers/);
});

test("read re-fetches snapshot, selects one pane, and returns bounded sanitized output", async () => {
  const mock = mockedExec([success(snapshotJson), success("agent output\u001b[2J\nAWS_SECRET_ACCESS_KEY=secret")]);
  const result = await executeHerdrAction({ action: "read", target: "w1:p1", lines: 8 }, mock.exec, { herdrEnv: "1", cwd: "/repo" });
  assert.equal(mock.calls.length, 2);
  assert.deepEqual(mock.calls[0].args, ["api", "snapshot"]);
  assert.deepEqual(mock.calls[1].args, ["pane", "read", "w1:p1", "--source", "recent-unwrapped", "--lines", "8", "--format", "text"]);
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.target, "w1:p1");
  assert.equal(data.agent, "reviewer");
  assert.match(data.output, /agent output/);
  assert.doesNotMatch(data.output, /AWS_SECRET_ACCESS_KEY=secret|\u001b/);
  assert.match(data.warning, /untrusted/i);
});

test("mutating actions validate a fresh recognized target; prompts wait and return the agent reply", async () => {
  for (const [params, snapshot, expected] of [
    [{ action: "focus", target: "reviewer" }, snapshotJson, ["agent", "focus", "reviewer"]],
    [{ action: "prompt", target: "reviewer", prompt: "Inspect only the selected change." }, idleSnapshotJson, ["agent", "prompt", "reviewer"]],
    [{ action: "wait", target: "w1:p1", timeout_ms: 3_000 }, snapshotJson, ["agent", "wait", "reviewer", "--timeout", "3000"]],
  ]) {
    const responses = params.action === "prompt"
      ? [success(snapshot), success('{"result":{"type":"ok"}}'), ({ calls }) => {
        const prompt = calls.find((call) => call.args[0] === "agent" && call.args[1] === "prompt").args[3];
        return success(replyForPrompt(prompt, "Concise review: no issues found."));
      }]
      : [success(snapshot), success('{"result":{"type":"ok"}}')];
    const mock = mockedExec(responses);
    const result = await executeHerdrAction(params, mock.exec, { herdrEnv: "1", cwd: "/repo" });
    assert.equal(mock.calls.length, params.action === "prompt" ? 3 : 2);
    assert.deepEqual(mock.calls[0].args, ["api", "snapshot"]);
    assert.deepEqual(mock.calls[1].args.slice(0, expected.length), expected);
    if (params.action === "prompt") {
      assert.match(mock.calls[1].args[3], /^Request:\nInspect only the selected change/);
      assert.match(mock.calls[1].args[3], /Reply protocol/);
      assert.deepEqual(mock.calls[1].args.slice(-3), ["--wait", "--timeout", "120000"]);
    }
    assert.equal(mock.calls[1].command, "herdr");
    assert.doesNotMatch(JSON.stringify(mock.calls), /bash|sh -c/);
    assert.equal(result.isError, undefined);
    if (params.action === "prompt") {
      assert.deepEqual(mock.calls[2].args, ["pane", "read", "w1:p1", "--source", "recent-unwrapped", "--lines", "80", "--format", "text"]);
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.result, "reply retrieved and correlated");
      assert.match(data.reply, /^HERDR-REPLY-[a-f0-9]{16}-[a-f0-9]{16}\nConcise review: no issues found\.\nHERDR-REPLY-/);
      assert.match(data.warning, /untrusted/i);
    }
  }
});

test("stale pane output is not accepted as a correlated reply", async () => {
  const mock = mockedExec([success(idleSnapshotJson), success("accepted"), success("an old reply without the fresh marker")]);
  const result = await executeHerdrAction({ action: "prompt", target: "reviewer", prompt: "do the task" }, mock.exec, { herdrEnv: "1" });
  assert.equal(mock.calls.length, 3);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /no matching reply markers/);
  assert.match(result.content[0].text, /inspect the pane/);
});

test("a completed prompt is never resent when retrieving the pane reply fails", async () => {
  const mock = mockedExec([
    success(idleSnapshotJson),
    success('{"result":{"type":"ok"}}'),
    { stdout: "", stderr: "pane read unavailable", code: 1, killed: false },
  ]);
  const result = await executeHerdrAction({ action: "prompt", target: "reviewer", prompt: "do the task" }, mock.exec, { herdrEnv: "1" });
  assert.equal(mock.calls.length, 3);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /accepted the prompt.*reply retrieval failed/i);
  assert.match(result.content[0].text, /Do not resend/);
  assert.match(result.content[0].text, /pane read unavailable/);
});

test("mutating actions reject the current pane by exact ID and recognized agent name", async () => {
  for (const action of ["focus", "prompt", "wait"]) {
    for (const target of ["reviewer", "w1:p1"]) {
      const mock = mockedExec([success(snapshotJson)]);
      const result = await executeHerdrAction({
        action, target, prompt: action === "prompt" ? "check" : undefined,
        timeout_ms: action === "wait" ? 3_000 : undefined,
      }, mock.exec, { herdrEnv: "1", currentPaneId: "w1:p1" });
      assert.equal(mock.calls.length, 1, `${action} ran a command against the calling pane`);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /current Pi pane/i);
    }
  }
});

test("unknown targets, busy agents, and failed prompts are never retried; safe CLI diagnostics are retained", async () => {
  const unknown = mockedExec([success(snapshotJson)]);
  const rejected = await executeHerdrAction({ action: "focus", target: "missing-agent" }, unknown.exec, { herdrEnv: "1" });
  assert.equal(unknown.calls.length, 1);
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /not a recognized agent/i);

  const busy = mockedExec([success(snapshotJson)]);
  const busyResult = await executeHerdrAction({ action: "prompt", target: "reviewer", prompt: "do the task" }, busy.exec, { herdrEnv: "1" });
  assert.equal(busy.calls.length, 1);
  assert.equal(busyResult.isError, true);
  assert.match(busyResult.content[0].text, /status 'working'/);

  const failed = mockedExec([success(idleSnapshotJson), {
    stdout: "", stderr: "agent_blocked: prompt was rejected\nAPI_KEY=secret\n/Users/mirin/private.txt",
    code: 1, killed: false,
  }]);
  const failedPrompt = await executeHerdrAction({ action: "prompt", target: "reviewer", prompt: "do the task" }, failed.exec, { herdrEnv: "1" });
  assert.equal(failed.calls.length, 2);
  assert.equal(failedPrompt.isError, true);
  assert.match(failedPrompt.content[0].text, /agent_blocked/);
  assert.match(failedPrompt.content[0].text, /whether it completed is unknown/);
  assert.match(failedPrompt.content[0].text, /No retry was attempted/);
  for (const secret of ["API_KEY", "secret", "/Users/mirin", "private.txt"]) {
    assert.equal(failedPrompt.content[0].text.includes(secret), false, `CLI diagnostic leaked ${secret}`);
  }

  const timedOut = mockedExec([success(idleSnapshotJson), { stdout: "", stderr: "API_KEY=private details", code: 1, killed: true }]);
  const ambiguous = await executeHerdrAction({ action: "prompt", target: "reviewer", prompt: "do the task" }, timedOut.exec, { herdrEnv: "1" });
  assert.equal(timedOut.calls.length, 2);
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.content[0].text, /unknown.*No retry was attempted/i);
  assert.doesNotMatch(ambiguous.content[0].text, /private details/);
});

test("extension registers exactly one tool only in Herdr and explains a missing runtime environment", async () => {
  const tools = [];
  const pi = { registerTool: (tool) => tools.push(tool) };
  withHerdrEnv(undefined, () => herdrOrchestrator(pi));
  assert.equal(tools.length, 0);

  withHerdrEnv("1", () => herdrOrchestrator(pi));
  assert.deepEqual(tools.map((tool) => tool.name), ["herdr_swarm"]);
  const mock = mockedExec([]);
  const unavailable = await withHerdrEnv(undefined, () => tools[0].execute("call", { action: "list" }, undefined, undefined, {
    cwd: "/repo",
    model: { provider: "openai-codex", id: "gpt-current" },
    modelRegistry: { getAvailable: () => [] },
  }));
  assert.equal(mock.calls.length, 0);
  assert.equal(unavailable.isError, true);
  assert.match(unavailable.content[0].text, /HERDR_ENV=1/);
});
