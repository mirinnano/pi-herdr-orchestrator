import assert from "node:assert/strict";
import { test } from "node:test";
import herdrWorker from "../extensions/herdr-worker.ts";
import { executeHerdrWorkerAction } from "../extensions/herdr-orchestrator.ts";

const snapshot = {
  focused_workspace_id: "w1",
  focused_tab_id: "w1:t1",
  focused_pane_id: "w1:p1",
  workspaces: [{ workspace_id: "w1", label: "repo", number: 1, focused: true, tab_count: 1, pane_count: 2, agent_status: "idle" }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "work", number: 1, focused: true, pane_count: 2, agent_status: "idle" }],
  panes: [
    { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", label: "boss", focused: true, agent_status: "idle" },
    { pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", label: "worker", focused: false, agent_status: "working" },
  ],
  agents: [
    { name: "boss", agent: "pi", pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", focused: true, agent_status: "idle" },
    { name: "worker", agent: "pi", pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent_status: "working", tokens: { pi_supervisor: "w1:p1" } },
  ],
};
const snapshotJson = JSON.stringify(snapshot);
const success = (stdout = "") => ({ stdout, stderr: "", code: 0, killed: false });

function mockExec(responses) {
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({ command, args: [...args], options });
    const result = responses.shift();
    if (!result) throw new Error("unexpected command");
    return typeof result === "function" ? result({ command, args, options, calls }) : result;
  };
  return { exec, calls };
}

function replyForPrompt(prompt, body) {
  const partA = prompt.match(/part A '([a-f0-9]{16})'/)?.[1];
  const partB = prompt.match(/part B '([a-f0-9]{16})'/)?.[1];
  assert.ok(partA && partB);
  const marker = `HERDR-REPLY-${partA}-${partB}`;
  assert.equal(prompt.includes(marker), false);
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

test("worker identity shows only the current agent and its own model catalog", async () => {
  const mock = mockExec([success(snapshotJson)]);
  const result = await executeHerdrWorkerAction({ action: "identity" }, mock.exec, {
    herdrEnv: "1",
    currentPaneId: "w1:p2",
    currentModel: { provider: "openai-codex", id: "gpt-5.6" },
    availableModels: [{ provider: "openai-codex", id: "gpt-5.6" }, { provider: "anthropic", id: "claude-opus" }],
  });
  assert.equal(mock.calls.length, 1);
  const identity = JSON.parse(result.content[0].text);
  assert.equal(identity.role, "worker");
  assert.equal(identity.agent, "worker");
  assert.equal(identity.kind, "pi");
  assert.equal(identity.assignedSupervisorPaneId, "w1:p1");
  assert.deepEqual(identity.currentModel, { provider: "openai-codex", id: "gpt-5.6" });
  assert.equal(identity.availableModels.length, 2);
});

test("worker publishes concise progress/final reports with actual model and scoped files", async () => {
  const mock = mockExec([success(snapshotJson), success('{"result":{"type":"pane_updated"}}')]);
  const result = await executeHerdrWorkerAction({
    action: "report", status: "blocked", summary: "Need one API decision.",
    current_action: "Wait for route policy", active_files: ["server.go"], files: ["server.go"],
    last_action: "Read the handler", next_action: "Resume tests after clarification",
    checks: ["go test ./..."], blockers: ["Should this route be public?"],
    requested_model_provider: "openai-codex", requested_model_id: "gpt-5.6", notify_supervisor: false,
  }, mock.exec, { herdrEnv: "1", currentPaneId: "w1:p2", currentModel: { provider: "openai-codex", id: "gpt-5.6" } });
  assert.equal(mock.calls.length, 2);
  assert.deepEqual(mock.calls[1].args.slice(0, 3), ["pane", "report-metadata", "--source"]);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.published, true);
  assert.equal(body.responseExpected, false);
  assert.deepEqual(body.report, {
    role: "worker_report", status: "blocked", summary: "Need one API decision.",
    currentAction: "Wait for route policy", activeFiles: ["server.go"], files: ["server.go"],
    lastAction: "Read the handler", nextAction: "Resume tests after clarification",
    checks: ["go test ./..."], blockers: ["Should this route be public?"],
    requestedModel: { provider: "openai-codex", id: "gpt-5.6" },
    activeModel: { provider: "openai-codex", id: "gpt-5.6" }, modelMatchesRequest: true,
    updatedAt: body.report.updatedAt,
  });

  const mismatchMock = mockExec([success(snapshotJson), success()]);
  const mismatch = await executeHerdrWorkerAction({
    action: "report", status: "done", summary: "Completed.", notify_supervisor: false,
    requested_model_provider: "openai-codex", requested_model_id: "gpt-5.6",
  }, mismatchMock.exec, { herdrEnv: "1", currentPaneId: "w1:p2", currentModel: { provider: "anthropic", id: "claude-opus" } });
  assert.equal(JSON.parse(mismatch.content[0].text).report.modelMatchesRequest, false);
  const partial = await executeHerdrWorkerAction({
    action: "report", status: "done", summary: "Completed.", notify_supervisor: false, requested_model_provider: "openai-codex",
  }, mockExec([success(snapshotJson)]).exec, { herdrEnv: "1", currentPaneId: "w1:p2" });
  assert.equal(partial.isError, true);
  assert.match(partial.content[0].text, /requires both provider and model id/);
});

test("worker final report is delivered to an idle supervisor and awaits a correlated reply", async () => {
  const mock = mockExec([success(snapshotJson), success("metadata published"), success("accepted"), ({ calls }) => {
    const prompt = calls.find((call) => call.args[0] === "agent" && call.args[1] === "prompt").args[3];
    assert.match(prompt, /Structured report from worker worker/);
    assert.match(prompt, /modelMatchesRequest/);
    return success(replyForPrompt(prompt, "Report received; continue with the next task."));
  }]);
  const result = await executeHerdrWorkerAction({
    action: "report", target: "boss", status: "done", summary: "API review is complete.",
    current_action: "Return test findings", files: ["server.go"], timeout_ms: 5_000,
  }, mock.exec, { herdrEnv: "1", currentPaneId: "w1:p2", currentModel: { provider: "openai-codex", id: "gpt-5.6" } });
  assert.equal(mock.calls.length, 4);
  assert.deepEqual(mock.calls[2].args.slice(0, 3), ["agent", "prompt", "boss"]);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.action, "report");
  assert.equal(body.published, true);
  assert.equal(body.deliveredTo, "boss");
  assert.equal(body.responseExpected, true);
  assert.match(body.acknowledgement, /Report received; continue/);
});

test("worker send targets only its assigned supervisor and returns without waiting or reading", async () => {
  const workingSupervisor = structuredClone(snapshot);
  workingSupervisor.agents[0].agent_status = "working";
  workingSupervisor.panes[0].agent_status = "working";
  const mock = mockExec([success(JSON.stringify(workingSupervisor)), success("accepted")]);
  const result = await executeHerdrWorkerAction({ action: "send", message: "Build is green; continuing with UI tests." }, mock.exec, {
    herdrEnv: "1", currentPaneId: "w1:p2",
  });
  assert.equal(mock.calls.length, 2);
  assert.deepEqual(mock.calls[1].args, ["agent", "prompt", "boss", "Build is green; continuing with UI tests."]);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.status, "submitted");
  assert.equal(body.responseExpected, false);
  assert.match(body.note, /were not awaited/);

  const blockedSupervisor = structuredClone(snapshot);
  blockedSupervisor.agents[0].agent_status = "blocked";
  blockedSupervisor.panes[0].agent_status = "blocked";
  const blocked = mockExec([success(JSON.stringify(blockedSupervisor))]);
  const rejected = await executeHerdrWorkerAction({ action: "send", message: "Hello" }, blocked.exec, {
    herdrEnv: "1", currentPaneId: "w1:p2",
  });
  assert.equal(blocked.calls.length, 1);
  assert.match(rejected.content[0].text, /status is 'blocked'/);
});

test("worker asks one exact idle supervisor and returns its reply", async () => {
  const mock = mockExec([success(snapshotJson), success("accepted"), ({ calls }) => {
    const prompt = calls.find((call) => call.args[0] === "agent" && call.args[1] === "prompt").args[3];
    return success(replyForPrompt(prompt, "Use the existing API; keep the new route internal."));
  }]);
  const result = await executeHerdrWorkerAction({
    action: "ask", target: "boss", question: "Should the route be public?", timeout_ms: 5_000,
  }, mock.exec, { herdrEnv: "1", currentPaneId: "w1:p2" });
  assert.equal(mock.calls.length, 3);
  assert.deepEqual(mock.calls[1].args.slice(0, 3), ["agent", "prompt", "boss"]);
  assert.match(mock.calls[1].args[3], /Question from worker worker/);
  assert.deepEqual(mock.calls[1].args.slice(-3), ["--wait", "--timeout", "5000"]);
  assert.deepEqual(mock.calls[2].args, ["pane", "read", "w1:p1", "--source", "recent-unwrapped", "--lines", "80", "--format", "text"]);
  const response = JSON.parse(result.content[0].text).response;
  assert.match(response, /HERDR-REPLY-[a-f0-9]{16}-[a-f0-9]{16}/);
  assert.match(response, /Use the existing API; keep the new route internal/);
});

test("worker does not interrupt a working supervisor and does not retry", async () => {
  const busySnapshot = structuredClone(snapshot);
  busySnapshot.agents[0].agent_status = "working";
  busySnapshot.panes[0].agent_status = "working";
  const mock = mockExec([success(JSON.stringify(busySnapshot))]);
  const result = await executeHerdrWorkerAction({ action: "ask", target: "boss", question: "Need clarification" }, mock.exec, {
    herdrEnv: "1", currentPaneId: "w1:p2",
  });
  assert.equal(mock.calls.length, 1);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Supervisor 'boss' is 'working'/);

  const reportMock = mockExec([success(JSON.stringify(busySnapshot)), success("metadata published")]);
  const report = await executeHerdrWorkerAction({
    action: "report", target: "boss", status: "progress", summary: "Waiting for test results.",
    current_action: "Wait for test output", active_files: ["server.go"],
  }, reportMock.exec, { herdrEnv: "1", currentPaneId: "w1:p2" });
  assert.equal(reportMock.calls.length, 2);
  assert.equal(report.isError, undefined);
  const reportBody = JSON.parse(report.content[0].text);
  assert.equal(reportBody.published, true);
  assert.equal(reportBody.deliveredTo, null);
  assert.match(reportBody.note, /Progress is visible in Herdr metadata.*not interrupted/);
});

test("worker observes supervisor activity metadata without interrupting its turn", async () => {
  const observed = structuredClone(snapshot);
  observed.agents[0].agent_status = "working";
  observed.panes[0].agent_status = "working";
  observed.agents[0].tokens = { pi_activity: JSON.stringify({
    version: 1, role: "supervisor", status: "progress", summary: "Review the migration.",
    currentAction: "Inspect migration tests", activeFiles: ["migrations/001.sql"], changedFiles: [],
    lastAction: "Read schema changes", nextAction: "Assign a test review", updatedAt: new Date().toISOString(),
    activeModel: { provider: "openai-codex", id: "gpt-5.6" }, requestedModel: null, modelMatchesRequest: null,
  }) };
  const mock = mockExec([success(JSON.stringify(observed))]);
  const result = await executeHerdrWorkerAction({ action: "observe", target: "boss" }, mock.exec, {
    herdrEnv: "1", currentPaneId: "w1:p2",
  });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.status, "working");
  assert.equal(body.activity.currentAction, "Inspect migration tests");
  assert.deepEqual(body.activity.activeFiles, ["migrations/001.sql"]);
  assert.equal(mock.calls.length, 1);
});

test("worker cannot observe or message a recognized agent other than its assigned supervisor", async () => {
  const withOtherAgent = structuredClone(snapshot);
  withOtherAgent.panes.push({
    pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t1", label: "peer", focused: false, agent_status: "idle", agent: "pi",
  });
  withOtherAgent.agents.push({
    name: "peer", agent: "pi", pane_id: "w1:p3", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent_status: "idle",
  });
  const observe = await executeHerdrWorkerAction({ action: "observe", target: "peer", include_output: true }, mockExec([success(JSON.stringify(withOtherAgent))]).exec, {
    herdrEnv: "1", currentPaneId: "w1:p2",
  });
  assert.equal(observe.isError, true);
  assert.match(observe.content[0].text, /not this worker's assigned supervisor/);

  const ask = await executeHerdrWorkerAction({ action: "ask", target: "peer", question: "Can you review this?" }, mockExec([success(JSON.stringify(withOtherAgent))]).exec, {
    herdrEnv: "1", currentPaneId: "w1:p2",
  });
  assert.equal(ask.isError, true);
  assert.match(ask.content[0].text, /not this worker's assigned supervisor/);
});

test("worker extension registers only in Herdr and exposes subordinate-specific guidance", () => {
  const tools = [];
  const pi = { registerTool: (tool) => tools.push(tool) };
  withHerdrEnv(undefined, () => herdrWorker(pi));
  assert.equal(tools.length, 0);
  withHerdrEnv("1", () => herdrWorker(pi));
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "herdr_worker");
  assert.match(tools[0].description, /Worker\/subordinate/);
  assert.match(tools[0].description, /one-way message/);
  assert.match(tools[0].promptGuidelines.join(" "), /Do not start agents or re-delegate/);
  assert.match(tools[0].promptGuidelines.join(" "), /Observe the exact supervisor named in your assignment/);
});
