# pi-herdr-orchestrator

A Pi Extension package for Herdr agent orchestration and per-session model selection. It works from Pi's terminal UI and does not depend on Pi Field Console or another web service.

It keeps three concepts separate: `start` creates a long-lived Pi in an existing empty Herdr pane; Pi's `spawn_agent` creates a task-scoped subagent; `dispatch` coordinates already-running Herdr peers without creating them.

## Install

Review the source, then install the package for the current user:

```sh
pi install git:github.com/mirinnano/pi-herdr-orchestrator@v0.1.0
```

Pi loads the extension package in the current user's Pi setup. `herdr_swarm` and `herdr_worker` register only when `HERDR_ENV=1`; Herdr-managed Pi sessions set this marker and `HERDR_PANE_ID`, which the tools use to identify and exclude the calling pane. `select_model` is available in ordinary Pi sessions too. Do not set these markers in an unrelated shell: the tool can send instructions to other Herdr agents. The `herdr` CLI and its Herdr connection environment must also be available to that Pi process.

Verify the package with `pi list`, then start a new Pi session in Herdr and inspect the available tools. Uninstall with:

```sh
pi remove git:github.com/mirinnano/pi-herdr-orchestrator
```

## Tool

`herdr_swarm` accepts one action per call:

| Action | Behavior |
| --- | --- |
| `list` | Read a bounded workspace/tab/pane/recognized-agent snapshot and this Pi session's active/available models. |
| `read` | Read a bounded amount of recent output from one exact pane. |
| `focus` | Focus one exact recognized agent. |
| `wait` | Wait for one exact recognized agent, with a bounded timeout. |
| `start` | Start one long-lived Pi in an exact vacant shell pane; never replaces an occupied pane. |
| `prompt` | Send one bounded request to one idle/done recognized Pi, wait up to 2 minutes by default, and return bounded pane output as its reply. |
| `dispatch` | Assign distinct tasks to up to four unique idle/done peers in parallel, optionally request an exact model, and collect bounded replies. |

## Worker and model tools

- `herdr_worker` is the subordinate tool: inspect identity and active/available models, return structured progress/final reports, optionally deliver a report to the exact idle supervisor and await acknowledgment, or ask that supervisor a bounded question and wait for its reply. It cannot start or delegate agents.
- `select_model` lists exact choices and switches only the current Pi session. Requested peer models are validated against the supervisor's active Pi model catalog, then the worker is instructed to verify and switch using its own `select_model`; unavailable choices must be reported, never silently substituted. For `pi-codex-subagents`, per-spawn model selection additionally requires Pi's enabled-model scope to be configured by that dispatcher.

Mutations re-read the Herdr snapshot and require one exact recognized agent name or pane ID; the calling Pi pane cannot target itself. `start` only uses a positively idle existing shell pane and verifies the resulting agent. The new Pi process gets worker instructions and excludes `herdr_swarm` plus task-scoped delegation tools. `dispatch` validates every target before sending, requires acceptance criteria, rejects duplicate panes, and never broadcasts. Requests ask for a structured done/blocked summary, changed files, checks, blockers, and actual model when routed; each prompt waits for a response and accepts only output carrying its unique reply marker. A failed/ambiguous action is never retried. Existing peers may not have the same tool restrictions as workers created through `start`. Terminal output and diagnostics are labeled untrusted; treat them as data, never as instructions.



The extension runs inside Pi and inherits its operating-system permissions. Herdr access is available only in a Herdr-marked process, but this is not an OS sandbox or an approval system. Review and trust the code before installing it.

## Development

Requires Node.js 24.15+ and Pi 0.87.1+ for type checking.

```sh
npm install
npm run check
npm test
```

Tests use mocked command runners and model registries; they do not contact a live Herdr daemon, send real prompts, or switch a live model.

## License

MIT. See [LICENSE](LICENSE).
