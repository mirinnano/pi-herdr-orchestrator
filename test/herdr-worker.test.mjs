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
    { name: "worker", agent: "pi", pane_id: "w1:p2", workspace_id: "w1", tab_id: "w1:t1", focused: false, agent_status: "working" },
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
  assert.deepEqual(identity.currentModel, { provider: "openai-codex", id: "gpt-5.6" });
  assert.equal(identity.availableModels.length, 2);
});

test("worker returns concise structured progress and final reports without shell commands", async () => {
  const mock = mockExec([]);
  const result = await executeHerdrWorkerAction({
    action: "report", status: "blocked", summary: "Need one API decision.",
    files: ["server.go"], checks: ["go test ./..."], blockers: ["Should this route be public?"],
    requested_model_provider: "openai-codex", requested_model_id: "gpt-5.6",
  }, mock.exec, { herdrEnv: "1", currentModel: { provider: "openai-codex", id: "gpt-5.6" } });
  assert.equal(mock.calls.length, 0);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    role: "worker_report", status: "blocked", summary: "Need one API decision.",
    files: ["server.go"], checks: ["go test ./..."], blockers: ["Should this route be public?"],
    requestedModel: { provider: "openai-codex", id: "gpt-5.6" },
    activeModel: { provider: "openai-codex", id: "gpt-5.6" },
    modelMatchesRequest: true,
  });

  const mismatch = await executeHerdrWorkerAction({
    action: "report", status: "done", summary: "Completed.",
    requested_model_provider: "openai-codex", requested_model_id: "gpt-5.6",
  }, mock.exec, { herdrEnv: "1", currentModel: { provider: "anthropic", id: "claude-opus" } });
  assert.equal(JSON.parse(mismatch.content[0].text).modelMatchesRequest, false);
  const partial = await executeHerdrWorkerAction({
    action: "report", status: "done", summary: "Completed.", requested_model_provider: "openai-codex",
  }, mock.exec, { herdrEnv: "1" });
  assert.equal(partial.isError, true);
  assert.match(partial.content[0].text, /requires both provider and model id/);
});

test("worker can deliver a bounded structured report and wait for supervisor acknowledgment", async () => {
  const mock = mockExec([success(snapshotJson), success("accepted"), ({ calls }) => {
    const prompt = calls.find((call) => call.args[0] === "agent" && call.args[1] === "prompt").args[3];
    assert.match(prompt, /Structured report from worker worker/);
    assert.match(prompt, /modelMatchesRequest/);
    return success(replyForPrompt(prompt, "Report received; continue with the next task."));
  }]);
  const result = await executeHerdrWorkerAction({
    action: "report", target: "boss", status: "progress", summary: "API review is halfway done.", timeout_ms: 5_000,
  }, mock.exec, { herdrEnv: "1", currentPaneId: "w1:p2", currentModel: { provider: "openai-codex", id: "gpt-5.6" } });
  assert.equal(mock.calls.length, 3);
  assert.deepEqual(mock.calls[1].args.slice(0, 3), ["agent", "prompt", "boss"]);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.action, "report");
  assert.equal(body.deliveredTo, "boss");
  assert.match(body.acknowledgement, /Report received; continue/);
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

  const reportMock = mockExec([success(JSON.stringify(busySnapshot))]);
  const report = await executeHerdrWorkerAction({
    action: "report", target: "boss", status: "progress", summary: "Waiting for test results.",
  }, reportMock.exec, { herdrEnv: "1", currentPaneId: "w1:p2" });
  assert.equal(reportMock.calls.length, 1);
  assert.equal(report.isError, true);
  assert.match(report.content[0].text, /Keep the report in your current\/final reply/);
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
  assert.match(tools[0].promptGuidelines.join(" "), /Do not start agents or re-delegate/);
  assert.match(tools[0].promptGuidelines.join(" "), /with the exact supervisor target/);
});
