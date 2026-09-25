import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Input, matchesKey, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";

const ENTRY = "pi-harness-model-recent";
const MAX_RECENT = 8;
const MAX_MODEL_CHOICES = 100;
type ModelRef = { provider: string; id: string };

function key(model: ModelRef): string { return JSON.stringify([model.provider, model.id]); }

function publicModel(model: ModelRef | undefined) {
  return model ? { provider: model.provider, id: model.id, ref: `${model.provider}/${model.id}` } : null;
}

function modelToolResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

function restore(ctx: ExtensionContext): ModelRef[] {
  const entries = ctx.sessionManager.getBranch();
  const recent: ModelRef[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
    const ref = entry.data as Partial<ModelRef> | undefined;
    if (typeof ref?.provider !== "string" || typeof ref.id !== "string") continue;
    const id = key(ref as ModelRef);
    const previous = recent.findIndex((item) => key(item) === id);
    if (previous !== -1) recent.splice(previous, 1);
    recent.unshift({ provider: ref.provider, id: ref.id });
    if (recent.length > MAX_RECENT) recent.pop();
  }
  return recent;
}

export default function modelSwitcher(pi: ExtensionAPI): void {
  let recent: ModelRef[] = [];

  pi.on("session_start", (_event, ctx) => { recent = restore(ctx); });
  pi.on("session_tree", (_event, ctx) => { recent = restore(ctx); });
  pi.on("model_select", (event) => {
    if (event.source === "restore") return;
    const ref = { provider: event.model.provider, id: event.model.id };
    recent = [ref, ...recent.filter((item) => key(item) !== key(ref))].slice(0, MAX_RECENT);
    pi.appendEntry(ENTRY, ref);
  });

  pi.registerTool({
    name: "select_model",
    label: "Select Model",
    description: "List the models available to this Pi session and its active model, or switch only this session to one exact available provider/model pair. Never guess a model ID.",
    promptSnippet: "Use select_model to inspect this agent's active model and available choices; switch only to an exact listed provider/model pair.",
    promptGuidelines: [
      "Before routing a Herdr Pi worker to a model, check that worker's own select_model catalog; parent and worker model availability can differ.",
      "A model switch affects only this Pi session, not the default for new sessions.",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("switch")]),
      provider: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      model_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      query: Type.Optional(Type.String({ maxLength: 128 })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const available = ctx.modelRegistry.getAvailable();
      const active = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
      if (params.action === "list") {
        const query = params.query?.trim().toLocaleLowerCase();
        const filtered = available
          .filter((model) => !query || `${model.provider}/${model.id}`.toLocaleLowerCase().includes(query))
          .sort((a, b) => {
            const aCurrent = active && a.provider === active.provider && a.id === active.id;
            const bCurrent = active && b.provider === active.provider && b.id === active.id;
            return Number(Boolean(bCurrent)) - Number(Boolean(aCurrent)) || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
          });
        const models = filtered.slice(0, MAX_MODEL_CHOICES).map((model) => ({
          provider: model.provider,
          id: model.id,
          ref: `${model.provider}/${model.id}`,
          reasoning: Boolean(model.reasoning),
        }));
        return modelToolResult(JSON.stringify({
          current: publicModel(active),
          availableCount: filtered.length,
          models,
          truncated: filtered.length > models.length,
        }));
      }

      if (!params.provider || !params.model_id || params.query !== undefined) {
        return modelToolResult("For action=switch, provide exact provider and model_id; query is only valid with action=list.", true);
      }
      const selected = available.find((model) => model.provider === params.provider && model.id === params.model_id);
      if (!selected) {
        return modelToolResult(`Model ${params.provider}/${params.model_id} is not currently available to this Pi session. Call action=list and select an exact pair.`, true);
      }
      if (active?.provider === selected.provider && active.id === selected.id) {
        return modelToolResult(JSON.stringify({ result: "already active", current: publicModel(active) }));
      }
      try {
        const changed = await pi.setModel(selected);
        if (!changed) return modelToolResult(`Could not switch to ${selected.provider}/${selected.id}: provider authentication is unavailable.`, true);
        return modelToolResult(JSON.stringify({ result: "switched for this session", current: publicModel(selected) }));
      } catch {
        return modelToolResult(`Switch to ${selected.provider}/${selected.id} failed; no retry was attempted. Check provider authentication and retry only after confirming the active model.`, true);
      }
    },
  });

  pi.registerCommand("model-switch", {
    description: "Search models by name or provider; show current and recently used models",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/model-switch needs an interactive terminal; use Pi's /model in this mode.", "warning");
        return;
      }
      const models = ctx.modelRegistry.getAvailable();
      if (!models.length) {
        ctx.ui.notify("No authenticated models available. Run /login or configure a provider.", "warning");
        return;
      }
      const current = ctx.model;
      const currentKey = current ? key(current) : "";
      const recentKeys = recent.map(key);
      const byKey = new Map<string, Model<any>>();
      for (const model of models) byKey.set(key(model), model);
      const sorted = [...models].sort((a, b) => {
        const priority = (m: ModelRef) => {
          const id = key(m);
          if (id === currentKey) return -2;
          const index = recentKeys.indexOf(id);
          return index === -1 ? MAX_RECENT : index;
        };
        return priority(a) - priority(b) || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
      });
      const items: SelectItem[] = sorted.map((model) => {
        const id = key(model);
        const tag = id === currentKey ? "current" : recentKeys.includes(id) ? "recent" : "";
        return {
          value: id,
          label: `${model.provider}/${model.id}`,
          description: [tag, model.reasoning ? "reasoning" : ""].filter(Boolean).join(" · "),
        };
      });
      const selected = await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
        const input = new Input({ prompt: "Search: ", placeholder: "model or provider" });
        const header = new Text(theme.fg("accent", theme.bold("Switch model")));
        const hint = new Text(theme.fg("dim", "↑↓ navigate · enter select · esc cancel · /model for defaults"));
        const listTheme = {
          selectedPrefix: (text: string) => theme.fg("accent", text),
          selectedText: (text: string) => theme.fg("accent", text),
          description: (text: string) => theme.fg("muted", text),
          scrollInfo: (text: string) => theme.fg("dim", text),
          noMatch: (text: string) => theme.fg("warning", text),
        };
        const createList = (choices: SelectItem[]) => {
          const result = new SelectList(choices, 10, listTheme);
          result.onSelect = (item) => done(item.value);
          return result;
        };
        let list = createList(items);
        input.onEscape = () => done(undefined);
        input.onSubmit = () => done(list.getSelectedItem()?.value);
        return {
          get focused() { return input.focused; },
          set focused(value: boolean) { input.focused = value; },
          render(width: number) {
            return [...header.render(width), ...input.render(width), ...list.render(width), ...hint.render(width)];
          },
          invalidate() { header.invalidate(); input.invalidate(); list.invalidate(); hint.invalidate(); },
          handleInput(data: string) {
            if (matchesKey(data, "up") || matchesKey(data, "down")) list.handleInput(data);
            else {
              const previous = input.getValue();
              input.handleInput(data);
              if (input.getValue() !== previous) {
                const words = input.getValue().toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
                list = createList(items.filter((item) => words.every((word) => item.label.toLocaleLowerCase().includes(word))));
              }
            }
            tui.requestRender();
          },
        };
      });
      if (!selected) return;
      const model = byKey.get(selected);
      if (!model) return;
      try {
        if (await pi.setModel(model)) ctx.ui.notify(`Model: ${model.provider}/${model.id} (this session)`, "info");
        else ctx.ui.notify(`Cannot switch to ${model.provider}/${model.id}: authentication unavailable. Try /login.`, "warning");
      } catch {
        ctx.ui.notify("Model switch failed; no retry was attempted. Check provider authentication and confirm the active model before retrying.", "error");
      }
    },
  });
}
