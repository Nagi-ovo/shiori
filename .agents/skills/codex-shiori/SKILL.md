---
name: codex-shiori
description: >-
  Delegate work to the Codex CLI with Shiori's gates and conventions (bun +
  cargo, the git commit flow); prefer it over the generic `codex` skill in this
  repo. Use for bounded, well-specified changes Codex can grind through (a bug
  with a reproduction, a mechanical refactor, a multi-file sweep), for an
  independent review of a diff, or to map unfamiliar code. Triggers on
  "让 codex 做", "交给 codex", "codex review", "codex 看看". Holds the headless
  invocation that does not hang, the file-boundary rule, and the hand-back
  protocol (Claude reads the diff, re-runs the gates, seals; Codex never
  commits).
allowed-tools: Bash(codex *), Bash(nohup codex *), Bash(pkill *), Bash(tail *), Bash(wc *), Bash(grep *)
---

# Codex, from inside Shiori

Written against **codex-cli 0.146.0** (2026-07-31); when a flag here and
`codex --help` / `codex exec --help` disagree, the help output wins. Division of labour:
Claude plans, judges design, and owns version control; Codex implements and
audits. Codex is faster at grinding through a specified change than Claude is,
and it is a genuinely independent reader when reviewing Claude's own diff.

## The three modes

| | `impl` | `review` | `ask` |
|---|---|---|---|
| sandbox | `-s workspace-write` | `-s read-only` | `-s read-only` |
| for | a bug with a reproduction, a mechanical refactor, a multi-file sweep | auditing a diff Claude just wrote, a release gate, a security pass | mapping unfamiliar code, "where does X happen", "what calls Y" |
| leaves behind | a dirty working tree + a report | a report | an answer |
| Claude then | reads the diff, runs gates, seals | verifies each finding before acting | continues its own work |

## Invocation

**Launch it as a tracked background task** — Bash with `run_in_background:
true` — not with `nohup … &`. A `nohup` process is invisible to the harness:
nothing announces that it finished, so Claude waits on a run that ended minutes
ago and the user has to ask "卡了？". A tracked task re-invokes Claude on exit,
which is the signal to go read the log and the diff.

```bash
# Bash, run_in_background: true
codex -a never -s workspace-write exec "$(cat "$PROMPT")" \
  < /dev/null > "$LOG" 2>&1
```

Keep the redirect to `$LOG` even though the task is tracked: the completion
notification carries only a tail, and the hand-back protocol needs the whole
run. If some harness genuinely cannot track background shells, fall back to
`nohup codex … &` **and** arm a separate tracked wait in the same turn
(`while pgrep -f "codex.*exec" > /dev/null; do sleep 10; done`), so the finish
still announces itself.

Every part of the command below is load-bearing:

- **`< /dev/null` is mandatory.** Without it `codex exec` blocks forever on
  `Reading additional input from stdin...` — the process stays alive, burns no
  CPU, writes nothing, and looks exactly like a hung model call. Two runs were
  lost to this before it was diagnosed. If a run shows 0 bytes of output after
  30 seconds, this is the first thing to check.
- **Outside a git repo, add `--skip-git-repo-check` — and it goes AFTER `exec`.**
  Codex refuses to start in an untrusted directory with
  `Not inside a trusted directory and --skip-git-repo-check was not specified.`
  and exits in under a second with a ~115-byte log. That looks nothing like the
  stdin hang above, so check the log's *contents* before assuming `< /dev/null`
  is the problem — an empty-ish log can mean either. Placement is not optional:
  `codex … --skip-git-repo-check exec` fails with
  `error: unexpected argument`; `codex … exec --skip-git-repo-check` is correct.
  The repo itself is fine; this bites when the workspace is a session scratchpad
  or a throwaway clone unpacked outside version control.
- **Redirect to a log file; never pipe into `tail`/`head`.** A pipe buffers
  until the process exits, so a working run is indistinguishable from a dead
  one. With a log file, `tail -20 "$LOG"` shows progress at any moment. A
  healthy run writes tens of KB within the first half-minute.
- **`-a never`** (a top-level flag, before `exec`) disables approval prompts;
  `--full-auto` no longer exists in current builds. Leaving approvals on is a second way to hang headless.
- **Pass the prompt as an argument from a file** (`"$(cat …)"`), not by piping
  it in — piping conflicts with the `< /dev/null` above.
- Model selection: omit `-m` unless the user asks. A named model the account
  cannot use fails with `400 … is not supported when using Codex with a ChatGPT
  account`, and that error only surfaces at the end of the log.

Put prompts and logs in the session scratchpad, one file each per run, so a
long prompt can be edited and re-sent without re-typing it.

## Following up on an existing session

Resume the same session when Codex needs review feedback, new evidence, or a
bounded second pass. Headless delegation uses `codex exec resume`; plain
`codex resume` opens the interactive TUI and does not belong in this workflow.

```bash
# Bash, run_in_background: true — same tracking rule as a new run
codex -a never -s read-only exec resume \
  "$SESSION_ID" "$(cat "$PROMPT")" \
  < /dev/null > "$LOG" 2>&1
```

Use the mode's sandbox (`workspace-write` for `impl`, `read-only` for
`review`/`ask`) and pass `-a`/`-s` again on every resume; do not assume the old
run's execution policy carries forward. Keep `< /dev/null`, use a new prompt
file and log file for each turn, and wait until the prior turn in that session
has finished before resuming it. Run the resume from the same repo/workspace;
if the work moved, say so explicitly in the follow-up prompt.

Prefer an explicit session UUID. `exec resume --last` is acceptable only when
no other Codex session could have become newer; never use it while runs are
concurrent.

The session keeps its conversation, but its description of the working copy
may be stale. A follow-up prompt should contain the delta instead of repeating
the entire original prompt:

1. What changed since the previous turn (commits, files, user decisions).
2. The new evidence or review finding being answered.
3. The exact next action and acceptance condition.
4. A freshly computed file boundary from `git status --short`.
5. The gates, no-commit rule, and report format if they still apply.

## What every prompt must contain

Codex goes off the rails in predictable ways. Six sections prevent all of
them; leave one out and expect the corresponding failure.

1. **File boundary.** Which files are Codex's, and which are off limits
   because Claude is editing them right now. Compute the off-limits list from
   the working copy — `git status --short` lists exactly what Claude has touched
   — and name those paths explicitly: *"Do NOT change `src/…`; another agent
   is editing it."* Two agents writing one file in one checkout is how the
   working tree gets corrupted.
2. **Method, for anything diagnostic.** Require a falsifiable root-cause
   sentence *before* any patch, and require that temporary instrumentation be
   removed before it finishes. Otherwise Codex stacks speculative fixes and
   reports the last one as the cause. Say plainly: *"'Probably X' is not an
   answer — name the frame."*
3. **Gates.** `bun run verify` (build, lint, full tests, site), plus
   `bun run test:core` when the change touches `crates/` and
   `. "$HOME/.cargo/env" && cargo check --manifest-path src-tauri/Cargo.toml`
   when it touches `src-tauri/`.
4. **No commits.** *"Leave the working tree dirty and report what you
   changed."* Sealing is Claude's job — one fix per commit, with a message
   that explains the why (see "Version control" in AGENTS.md).
5. **Report format.** Mechanism → fix → files touched → how it was verified.
   Ask for the mechanism in one paragraph so its reasoning can be checked
   rather than trusted.
6. **Minimal change, few tests (Jesse, 2026-10-06).** Left alone, Codex
   writes a test grid per bug and tidies code on the way. Say it in capitals
   and spell it out for `impl`:
   - the smallest diff that fixes it; no refactors, renames, new
     abstractions or drive-by cleanups;
   - at most one test per bug, only for user-visible behavior, preferably
     one more assertion or step in an existing case; no new test files or
     harnesses; past ~15 lines of scaffolding, fix without a test and say so;
   - forbidden by name: tombstone, tautological, change-detector and
     over-testing (several cases for one bug, re-covering an existing test);
     a tautological test it finds gets deleted, not repaired;
   - report the lines added to test files, so the budget can be checked.

For `review`, add the repo's own standards to the prompt — the platform matrix
(web / macOS / Windows / Linux / iOS / Android), `t()` for every user-visible
string, coordinates in PDF user space — otherwise the review reads like a
generic lint pass.

## Watching a run

The finish announces itself if the run was launched as a tracked task (see
**Invocation**). Use `Monitor` on the log only when progress lines matter
mid-run; a bare `tail -f` is wrong for a one-shot completion, since it never
exits on its own.

Checking in by hand mid-run:

```bash
wc -c < "$LOG"          # tens of KB within 30s means it is working
tail -20 "$LOG"         # its plan and current step
git status --short      # which files it has actually touched
```

A run that is genuinely stuck shows: no growth in the log, no new file
modifications, and near-zero accumulated CPU (`ps -eo etime,time -p <pid>`).
Kill with `pkill -f "codex.*exec"`.

## Hand-back protocol

When Codex reports done, Claude does all of this before anything is sealed:

1. **Read the diff, not the report.** `git diff HEAD` over the files it
   owned (staged and unstaged), plus every new file `git status --short`
   lists as `??`, which no diff shows. The report describes intent; the diff
   is what shipped.
2. **Re-run every gate.** Do not take "all tests pass" on trust — and note
   the two timing-sensitive UI tests AGENTS.md names, which flake under CPU
   contention: re-run a lone failure in its own file before believing it.
3. **Hunt for leftovers.** Temporary logging, debug overlays, commented-out
   experiments, a dependency array quietly widened to silence a warning.
4. **Verify runtime claims with the user.** Codex reads code, which is intent,
   not behavior. Anything platform-dependent — rendering, native menus, IPC,
   drag-and-drop — needs a human to look at the running app before it counts
   as fixed.
5. **Seal it.** One commit per fix, described in Claude's own words, with
   `Found in review of <short-hash>` when it came out of a review pass.

## When NOT to delegate

- **Design and visual judgement.** Icon shapes, spacing, motion, copy. Codex
  will produce something defensible and characterless.
- **Anything in a file Claude is mid-edit.** Finish and seal first, then hand
  over a clean boundary.
- **Work whose acceptance test is "does it feel right".** That needs the
  user's eye, and a round-trip through Codex only adds latency.
- **Version control.** Under this delegation Codex never runs `git`;
  Claude seals. (Codex driven directly by the user may still `git commit`.)
