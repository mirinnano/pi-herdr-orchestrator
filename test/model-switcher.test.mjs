import assert from "node:assert/strict";
import { test } from "node:test";
import modelSwitcher from "../extensions/model-switcher.ts";

const model = (provider, id) => ({ provider, id, reasoning: true });
const theme = { fg: (_kind, text) => text, bold: (text) => text };

function setup({ mode = "tui", available = [], current = available[0], branch = [], setModel = async () => true } = {}) {
  const events = new Map();
  const commands = new Map();
  const tools = new Map();
  const notices = [];
  const entries = [];
  let dialog;
  const pi = {
    on: (name, fn) => events.set(name, fn),
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => tools.set(tool.name, tool),
    appendEntry: (type, data) => entries.push({ type, data }),
    setModel,
  };
  modelSwitcher(pi);
  const ctx = {
    mode, model: current,
    modelRegistry: { getAvailable: () => available },
    sessionManager: { getBranch: () => branch },
    ui: {
      notify: (message, level) => notices.push({ message, level }),
      custom: (factory) => new Promise((resolve) => {
        dialog = factory({ requestRender() {} }, theme, {}, resolve);
      }),
    },
  };
  events.get("session_start")({}, ctx);
  return { ctx, commands, tools, events, entries, notices, get dialog() { return dialog; } };
}

test("searches provider and selects only the chosen model for the session", async () => {
  const a = model("anthropic", "claude-a");
  const b = model("openai", "gpt-b");
  const selected = [];
  const state = setup({ available: [a, b], setModel: async (value) => { selected.push(value); return true; } });
  const pending = state.commands.get("model-switch").handler("", state.ctx);
  assert.ok(state.dialog);
  assert.match(state.dialog.render(70).join("\n"), /Switch model/);
  for (const key of "openai") state.dialog.handleInput(key);
  assert.match(state.dialog.render(70).join("\n"), /openai\/gpt-b/);
  state.dialog.handleInput("\r");
  await pending;
  assert.deepEqual(selected, [b]);
  assert.match(state.notices[0].message, /this session/);
});

test("cancel is non-mutating and selection errors are reported", async () => {
  const a = model("openai", "gpt-a");
  let calls = 0;
  const state = setup({ available: [a], setModel: async () => { calls++; return false; } });
  let pending = state.commands.get("model-switch").handler("", state.ctx);
  state.dialog.handleInput("\x1b");
  await pending;
  assert.equal(calls, 0);
  pending = state.commands.get("model-switch").handler("", state.ctx);
  state.dialog.handleInput("\r");
  await pending;
  assert.equal(calls, 1);
  assert.match(state.notices.at(-1).message, /authentication unavailable/);
});

test("model tool reports the active model and only available exact choices", async () => {
  const a = model("openai-codex", "gpt-5.6");
  const b = model("anthropic", "claude-opus");
  const state = setup({ available: [a, b], current: a });
  const tool = state.tools.get("select_model");
  assert.ok(tool);

  const all = JSON.parse((await tool.execute("list", { action: "list" }, undefined, undefined, state.ctx)).content[0].text);
  assert.deepEqual(all.current, { provider: "openai-codex", id: "gpt-5.6", ref: "openai-codex/gpt-5.6" });
  assert.equal(all.availableCount, 2);
  assert.equal(all.models[0].ref, "openai-codex/gpt-5.6");
  const filtered = JSON.parse((await tool.execute("filtered", { action: "list", query: "OPUS" }, undefined, undefined, state.ctx)).content[0].text);
  assert.deepEqual(filtered.models.map((item) => item.ref), ["anthropic/claude-opus"]);

  const selected = [];
  const switchState = setup({ available: [a, b], current: a, setModel: async (value) => { selected.push(value); return true; } });
  const switched = await switchState.tools.get("select_model").execute("switch", {
    action: "switch", provider: "anthropic", model_id: "claude-opus",
  }, undefined, undefined, switchState.ctx);
  assert.deepEqual(selected, [b]);
  assert.match(switched.content[0].text, /switched for this session/);
  const unavailable = await switchState.tools.get("select_model").execute("bad", {
    action: "switch", provider: "openai", model_id: "not-configured",
  }, undefined, undefined, switchState.ctx);
  assert.equal(unavailable.isError, true);
  assert.equal(selected.length, 1);
});

test("records recent model changes and does not open custom UI in RPC", async () => {
  const a = model("openai", "gpt-a");
  const state = setup({ mode: "rpc", available: [a] });
  state.events.get("model_select")({ model: a, source: "extension" });
  assert.deepEqual(state.entries[0].data, { provider: "openai", id: "gpt-a" });
  await state.commands.get("model-switch").handler("", state.ctx);
  assert.match(state.notices[0].message, /interactive terminal/);
  assert.equal(state.dialog, undefined);
});
