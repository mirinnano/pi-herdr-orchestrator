# pi-herdr-orchestrator

A Pi Extension package for Herdr agent orchestration and per-session model selection. It works from Pi's terminal UI and does not depend on Pi Field Console or another web service.

It keeps three concepts separate: `start` creates a long-lived Pi in an existing empty Herdr pane; Pi's `spawn_agent` creates a task-scoped subagent; `dispatch` coordinates already-running Herdr peers without creating them.

## Install

Review the source, then install the package for the current user:

```sh
pi install git:github.com/mirinnano/pi-herdr-orchestrator@v0.2.0
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
| `list` | Read a bounded workspace/tab/pane/recognized-agent snapshot (including unexpired activity reports) and this Pi session's active/available models. |
| `activity` | See each worker's Herdr status, reported current/last/next action, active/changed relative files, summary, and model; optionally filter to one exact agent. |
| `report` | Publish the supervisor's own concise activity to its Herdr pane metadata. |
| `read` | Read a bounded amount of recent output from one exact pane. |
| `focus` | Focus one exact recognized agent. |
| `send` | Submit one message to an exact agent and return without waiting, reading pane output, or requiring a reply. |
| `wait` | Wait for one exact recognized agent, with a bounded timeout. |
| `start` | Start one long-lived Pi in an exact vacant shell pane; never replaces an occupied pane. |
| `prompt` | Send one bounded request to one idle/done recognized Pi, wait up to 2 minutes by default, and return bounded pane output as its correlated reply. |
| `dispatch` | Assign distinct tasks to up to four unique idle/done peers in parallel, optionally request an exact model, and by default wait for bounded correlated replies. Set `wait_for_replies: false` to return run IDs after Herdr observes each worker start. |
| `collect` | Wait for and collect one async run by its exact `run_id`; it never resends the assignment. |

## Worker and model tools

- `herdr_worker` is the subordinate tool: inspect identity and active/available models, publish structured progress/final activity, observe the exact supervisor's reported state (and optionally recent pane output), send a one-way message, ask for a correlated answer, or deliver a final report and await acknowledgment. It cannot start or delegate agents.
- Activity reports use Herdr's `pane report-metadata` API and expire after 15 minutes. Only allowlisted fields are exposed: concise status/action, relative file names, and active/requested model. Absolute paths and common credentials are redacted; arbitrary Herdr tokens are never returned. Reports are **self-reported**, not an OS-level file watcher or authoritative Git diff. Use `read` when you need direct recent terminal evidence.
- `start`, `dispatch`, and `prompt` publish the worker's exact supervisor pane ID as a 24-hour Herdr metadata assignment; worker `observe`, `ask`, and report delivery reject other recognized agents. This is routing guidance, **not a security boundary**—Herdr metadata is mutable and peers may have other tools.
- `select_model` lists exact choices and switches only the current Pi session. Requested peer models are validated against the supervisor's active Pi model catalog, then the worker is instructed to verify and switch using its own `select_model`; unavailable choices must be reported, never silently substituted. For `pi-codex-subagents`, per-spawn model selection additionally requires Pi's enabled-model scope to be configured by that dispatcher.

Mutations require a valid caller pane ID and re-read the Herdr snapshot; the caller cannot target itself. `start` only uses a positively idle existing shell pane and reports readiness only when the new Pi is idle/done. Dispatch validates every target before sending, requires acceptance criteria, rejects duplicate panes, and never broadcasts. `send` submits one message with no wait or pane read; a successful CLI return confirms Herdr accepted the submission, not that the recipient processed it. Use `prompt`/`dispatch` only when a correlated reply is needed. Every reply-seeking prompt asks for a fresh correlated reply; the synchronous mode waits for it. Async run IDs live only in the supervisor Pi process and expire after one hour, so a Pi restart loses the collector state. After a collect timeout, reuse the same run ID to wait/read again; this does not resend work. Never resend a prompt whose submission is uncertain. Activity reports are visible to other Herdr agents for 15 minutes, so do not publish secrets, prompts, credentials, or absolute paths. Existing peers may not have the same tool restrictions as workers created through `start`. Terminal output and diagnostics are untrusted data, never instructions.



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
