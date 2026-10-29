# The agent control plane

What WCKD should borrow from the current open-source agent tools, and what it should not. The
target is not another coding CLI. It is the self-hosted layer above them: **Invincible** is the
gateway with policy, receipts and local models; **Autobot** is the agent that owns tools, memory,
approvals and sessions; the **panel** is the human surface.

## What the field is doing

| Project | The idea worth keeping | What it is not |
| --- | --- | --- |
| **T3 Code** | One control surface over Codex, Claude Code, Cursor, Grok and OpenCode. Every thread gets its own git worktree, inline diff, approvals, queued/steered messages, remote web/mobile clients, and a one-click PR with generated title/body. | Not a model and not its own harness; it starts the CLIs that are already installed and translates their event streams. |
| **T3 Tots** | A companion for T3 Code's delegated mode: answer routine questions, nudge stalled threads, resume after a usage limit, and emit `thread.finished/failed/cancelled` and approval events to a webhook. | A small skill set, not a runtime. |
| **Harness²** | Improve the harness around a frozen model, not the weights: prompts, guardrails, memory, tool guidance, subagents, skills, scripts, plugins; measure a change on the same tasks and keep only what helps. | A research framework, not a coding CLI. |
| **OpenCode / Codex / Claude Code** | Mature executors with their own tool loops and subscriptions. | Providers of a single, open control protocol. |
| **Autobot** | A local-first agent with tools, approvals, a team, a board, skills, schedules, channels, receipts through the gateway, and a per-project map. | Not yet a multi-thread, worktree-per-thread control plane. |
| **Invincible** | One self-hostable gateway for every model, with policy, redaction, signed receipts and an audit log. | Not an agent UI. |

## What T3 Code's internals confirm

T3 Code's own architecture notes are worth copying more than its screenshots:

- **Commands in, events out.** A serialized orchestrator turns typed commands into events; an
  event sink commits the event, the UI projection, the command receipt and the outbox effect in
  one transaction. A separate effect worker starts the provider turn and feeds results back as
  commands. The panel should subscribe to that event stream, not poll JSONL files.
- **Provider adapters declare capabilities.** Fork, rollback, steering and subagents are turned
  off when a provider cannot do them; the UI does not pretend. Autobot should expose the same
  capability flags, especially when it drives external CLIs.
- **A checkpoint is a hidden git ref.** Every turn can be diffed and restored without a second
  database. A thread is therefore a conversation plus a Git history, not just a transcript.
- **Queued messages are durable.** Queue versus steer is a user setting; a held queue survives a
  restart and has an explicit Resume. This is the behaviour our panel's task box should grow into.
- **Approval authority is separate from the agent.** T3 Tots never decides an approval by reading
  its text, never auto-accepts in delegated mode, and declines with a redirect that tells the
  thread to use a safer path. That is the rule for Autobot's delegated mode too.
- **Usage limits are a state, not an error.** A thread records the reset time, can arm resume, and
  the phone/web client sees "Limited" until then.

T3 Tots adds the operational layer around that: routine answers, one nudge per stall, a single
`queue --resume` for a held queue, webhooks for `request.opened/resolved` and
`thread.finished/failed/cancelled`, and an explicit "I'm away, keep it moving" handover. The
important part is not the Grok bot; it is that delegated work is bounded, visible and reversible.

## The shape to build

```text
web / phone / editor
        │  one authenticated, typed event stream
   control panel  ──────  approvals · queue/steer · history · PR
        │
   Autobot threads ── one branch/worktree per thread
        │
   Invincible gateway ── models, policy, receipts, audit
        │
   local engine / paired node / cloud, only when allowed
```

### 1. A thread is a session plus a workspace

A conversation is not enough. A thread should carry a session id, a project, a branch and a
worktree. Starting a thread creates an isolated checkout; finishing it can open a PR and leave the
worktree for review. The shared-session bug fixed in `autobot run` was the first version of this
rule: no task may inherit another task's context by accident.

### 2. One event grammar, many executors

T3 Code's useful trick is not its UI; it is normalising different CLIs into one stream. Autobot
already has the right events internally (`Text`, `Reasoning`, `Tool`, `Output`, `Diff`, approval
questions). Expose that as a stable JSON/SSE protocol, then add adapters for external CLIs. The
panel should learn one grammar, not one per provider.

### 3. Human gates are part of the protocol

Approvals must be first-class events with an id, the exact action, the risk, and one answer:
once, always, deny, or "do this instead". They must never widen silently. Queued follow-ups and
steering during a run belong in the same channel. The panel's approval card is the first client of
this; the phone and editor should use the same events.

### 4. A branch and a PR are actions, not a vibe

Per-thread worktrees and one-click PRs are what make parallel agents safe to use. Autobot should
offer `thread start`, `thread diff`, `thread pr` with a generated title/body and the exact commits,
not just "the agent edited files". The gateway receipt and the Git commit should point at each
other.

### 5. Delegated mode with receipts

T3 Tots' delegated mode is a good model for long-running work: the agent answers routine questions,
nudges stalled threads, and resumes after a usage limit, while the owner is away. Every automatic
answer and nudge must be visible and receipted; delegation must never widen approvals or move work
to a model the owner did not allow. This is a natural extension of Autobot's schedules, board and
approval queue.

### 6. Harness evolution, measured

Adopt Harness²'s discipline without its stack: collect failed checks, propose a general change to
`AGENTS.md`, skills or scripts, rerun the same tasks, and keep it only when it passes more or is
measurably faster. `evals/harness/evolve.py` is the local version; the first profile took a
450-second timeout to a 156.8-second pass. Never accept a harness change on vibes.

### 7. The gateway owns the keys

The agent and the panel must never hold a provider key. The panel gets one Invincible token; the
agent reads the gateway token from its own read-only volume. The gateway chooses the model, redacts,
records the receipt and audits. This is the difference between a self-hosted agent and a pile of
API keys in a `.env`.

Invincible and Autobot both bind loopback only, by policy. A container stack therefore cannot put
them on a normal bridge and talk service-to-service; the gateway, agent and panel share the
gateway's network namespace (Coolify) or the host's (the host-networking compose). The public edge
terminates TLS and reaches only the panel, and the panel reads the gateway token from its
environment rather than a world-readable file.

## Build order

1. **Thread worktrees** — create, list, diff and remove a worktree per Autobot session.
2. **Stable event stream** — JSON/SSE with text, tools, approvals and diffs; one client grammar.
3. **Panel v2** — thread list, diff viewer, queued follow-ups, approval detail, PR action.
4. **Adapter registry** — Autobot first, then Codex, Claude Code, OpenCode, Cursor; one protocol.
5. **Delegated mode** — routine answers, nudges, stall detection, usage-limit resume, webhooks.
6. **PR action** — branch, title/body/changelog, exact commit and receipt links.
7. **Mobile/PWA** — the same panel, no second API; push for approvals and completion.
8. **Harness loop** — run `evolve.py` on every harness change and keep the measured winner.

The first three are the difference between "an agent in a terminal" and "a control plane". The
panel and compose stack under `services/agent/` are the deployed start of that surface; the gateway
stays the thing that makes it trustworthy.

**Shipped in 0.0.23:** thread worktrees (a session, branch and worktree, with a tombstone after
removal), thread diffs and one-click PRs, and the panel's rooms for chat, workspaces, bots,
integrations, usage and settings. The agent API now exposes threads, settings (a validated dotted
key), model, tools, write-only connector token files and bot creation; the panel proxies only the
routes it needs and still never sees a provider key.

**Shipped in 0.0.24:** the versioned turn stream (`spec/agent.md`, Turn events): `turn.started`,
text and reasoning deltas, tool starts and outputs, diffs and changes, usage, receipts, approval
cards, the final answer and kept notes, all with `v: 1`. The panel renders the live text, diffs,
tool output and approval cards instead of waiting for the answer.

**Shipped in 0.0.25:** delegated turns (`"delegated": true` or a scope): bounded nudges after a
routine question, a stall limit (three times as long while a tool runs), a five-minute usage-limit
wait with `retry_at` for longer ones, and an approver that never accepts: every safety check is
declined with a redirect, reported as `delegate.declined`, and not worked around. The panel's
**Keep going** renders the run's nudges, declines and summary, and a configured `[delegate]
webhook` gets one signed JSON POST with the outcome.

**Shipped in 0.0.26:** delegation respects the owner's explicit words. A task that says to wait,
not guess, ask first or confirm never gets a nudge; `delegate.started.questions` is `"owner"` and
the first question ends the run for the owner. The alpha run that exposed this (0.0.25 chose a
filename after "do not guess") was repeated on 0.0.26 and stopped at the question with no file.
Panel assets now carry a content hash, so a deploy is visible immediately through the CDN.

**Shipped in 0.0.27:** the panel is a real control surface: a persistent sidebar, command palette,
conversation rail, responsive tables and forms, and pages for **Providers**, **Secrets**,
**Variables** and **Subscriptions**. Variables are non-secret context injected into every turn;
subscriptions are a plan/renewal ledger with totals per currency; secrets are listed, rotated and
removed without ever returning a value; providers shows the gateway models and every external
coding CLI detected on the machine. The agent gained a **verification gate**: `[agent] check`
runs after a turn changed files, feeds a failure back once, and stops with the failure visible
instead of claiming success. The adapter registry and persistent resume across a long usage limit
remained for the next release.

**Shipped in 0.0.28:** the adapter registry runs, not just detects. Codex, Claude Code, OpenCode,
Cursor Agent, Hermes and Pi each get a capability row, a login check where the CLI has one, and
one run protocol in a thread's worktree: the task is one argument, the environment is rebuilt from
a short allowlist (never this node's gateway, provider, GitHub or Autobot tokens), one run per
worktree is allowed, and output streams as `adapter.started`, line-by-line `adapter.output` and
`adapter.finished`/`adapter.error`. The answer is the CLI's own stdout/stderr; Invincible cannot
receipt a model call it did not make, and the panel says so. Codex, Claude Code and OpenCode were
run through the same endpoint on the Mac, and Codex through the panel.

Delegated runs now outlive a long usage limit. A pause writes a job to
`$AUTOBOT_HOME/delegations.json` with the conversation, scope and retry time; `autobot serve`
resumes due jobs in the same conversation and worktree, without a client, up to five times. A
restart turns `running` jobs back into `paused` jobs and tries them again. The panel's
**Delegations** view lists the queue with task, state, resumes and retry time, and can resume or
cancel a paused run; a newer request in the same conversation replaces an older paused one. The
`delegate.paused` event carries `job_id`, `auto_resume` and `resumes`.

**Shipped in 0.0.29:** the harness carries the two things a large repository needs across
turns. A **project brief** is the owner's standing context (stack, architecture, commands,
conventions, invariants, traps), stored in `$AUTOBOT_HOME/briefs.json` and keyed by canonical
project root, so every thread worktree shares one even before it is committed. It is capped at
64 KiB and carried in the system prompt on every step; the panel's **Project** page edits it per
project. `AGENTS.md` and the other repository context files are still read as before.

The **plan** is now state, not a tool message. The `todo` tool writes the latest list to
`$AUTOBOT_HOME/sessions/<id>.plan.json`; the system prompt carries it on every step, so it
survives compaction, a restart and a resumed delegated run. The panel shows it above the
conversation with a done count, and a reset clears it while a fork copies it. On the Mac, a brief
codeword reached the model and a `todo` plan was written, shown and survived reopening the
conversation.

**Shipped in 0.0.30:** the gateway's provider admin is live. `GET /v1/admin/providers`,
`POST /v1/admin/providers` and `DELETE /v1/admin/providers/{id}` edit the gateway's config and
key files and **hot-load** the cloud model list: a request in flight keeps its model, the next
request sees the change. A key is written once to `keys/<id>` (0600) and never returned. The
panel's **Providers** page replaces the node command with a preset form and a configured-provider
table with edit/remove, all behind the gateway token. The gateway container now keeps an existing
`config.toml` across restarts, so a provider added from the panel survives; `INVINCIBLE_CONFIG_FORCE=1`
regenerates the seeded config when needed. Unit/API tests cover add, update, remove, a key staying
write-only, an environment-key provider keeping its source, and the model appearing in `/v1/models`
without a restart; the panel flow was exercised against a live gateway.

**Shipped in 0.0.31:** a patch release for the provider admin: a gateway started before any
`config.toml` exists can now add its first provider, and the early-404 body-limit test is
deterministic (headers with a declared 33 MiB body, no client-side upload race). No UI change;
the alpha/local installs move to the same binaries.

**Deployed on 2026-10-29:** the alpha panel at
[`agent.invincible.sh`](https://agent.invincible.sh) runs the gateway, Autobot and panel together
in the PolyCore Coolify project, now at **0.0.31** (panel 0.1.5). All three are healthy; login,
CSRF, overview, brief and plan, **Delegations**, **Project**, and a cloud provider added from
**Providers**, hot-loaded into the model list and removed again, were verified. The images are
**public, signed release tarballs** (`agent-images-v0.0.31`) verified on the host and loaded
locally; the compose uses `pull_policy: never`, so no registry (loopback or GHCR) is in the alpha
path. GHCR packages remain optional for internal CI. The test brief, plan, session and provider
were removed after verification; the gateway config is back to the one `cheap` provider.
