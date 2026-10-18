---
name: jj
description: >-
  Version control for the Shiori repo. Load before running any jj or git
  command here, including commits you start yourself: seal-as-you-go means most
  commits have no user request behind them. Covers sealing, status/log/diff,
  bookmarks, rebase, split, squash, absorb, push, fetch, undo, tags, release
  hand-off and parallel-agent workspaces. Triggers on 提交, 封一下, 定稿, 改完了,
  撤销, 回滚, 推上去, 发版, 看看改了什么; commit, seal, undo, roll back, push, what
  changed, rebase, workspace. The gates and traps live in the body.
allowed-tools: Bash(jj *)
---

# Jujutsu (jj) — Shiori workflow

Verified against **jj 0.41.0**. When a command's flags look off, `jj help <cmd>`
is the source of truth, not this file. Update the version banner if you re-verify
on a newer jj.

## 0. Agent-safety (always)

These three rules prevent the agent from hanging or mis-reading state:

1. **`--no-pager` on anything that prints.** A bare `jj log`/`jj diff`/`jj show`
   can open `less` and hang the session. Always `jj --no-pager log`, etc.
2. **Inline `-m` for messages.** `jj describe -m "…"`, never bare `jj describe`
   (opens `$EDITOR` and blocks). Same for `commit`/`squash -m`.
3. **Re-read after every mutation.** After `split`/`squash`/`rebase`/`abandon`/
   `restore`, run `jj --no-pager st` (and `jj --no-pager log` if the graph moved)
   to confirm what actually happened. Never assert repo state from memory.

`jj diff` defaults to a "color-words" format — paired old/new line-number columns
(e.g. `   1    1: line CHANGED`) with changed words highlighted inline instead of
`+`/`-` gutters. That is **normal, not corruption**. Use `jj --no-pager diff --git`
for the familiar unified diff.

## 1. Mental model (for a git native)

- **The working copy IS a commit, `@`.** No staging area, no `git add`, no stash.
  Every edit is auto-snapshotted into `@` at the start of *every* jj command —
  including edits made by Codex or Jesse out-of-band. This is the single most
  useful property here (see §3).
- **An undescribed `@` is the natural "uncommitted" state.** Letting work pile
  up on `@` is safe and is *not* sealing history. Giving `@` a description (and
  moving on with `jj new`/`jj commit`) is the act that finalizes a commit — call
  this **sealing**. Sealing is the gated step (§2), snapshotting never is.
- **Two IDs.** *change-id* (stable across rewrites — use it everywhere) vs
  *commit-id* (the git SHA, changes on every rewrite — never key tooling on it).
- **Mutable vs immutable.** By default jj freezes `trunk() | tags() |
  untracked_remote_bookmarks()` — here effectively `origin/main`'s ancestors plus
  all tags. A normal `jj git fetch` *tracks* remote bookmarks, so an ordinary
  fetched branch is NOT immutable unless it's an ancestor of `trunk()`. jj refuses
  to rewrite anything immutable unless you pass `--ignore-immutable`; that refusal
  is the guardrail against rewriting pushed history — don't reflexively override it.
- **Op log = repo-wide undo.** `jj undo` reverts the last operation; `jj op log` +
  `jj op restore <op>` time-travel the whole repo. Cheap, total safety net (§5).
- Revsets you actually need: `@` (working copy), `@-` (its parent),
  `trunk()..@` (your unpushed stack), `mutable()`.

## 2. House rules — Jesse's commit discipline

These override generic jj advice.

1. **Seal as you go (agreed with Jesse 2026-06-10).** When a fix is
   complete and the gates (rule 2) are green, seal it immediately —
   `jj commit -m`, or describe + `jj new` — and move to the next fix. No
   per-fix greenlight needed. Prefer the native stack flow for multi-fix
   sessions: `jj new` BEFORE starting each fix, `jj describe -m` when it lands,
   and `jj absorb` to route follow-up tweaks into the change that owns those
   lines — so the history shapes itself and end-of-session splitting never
   happens. The acts that still wait for Jesse's explicit go: **pushing** (§6)
   and **rewriting an already-sealed change** (rule 6).
2. **Stay green before sealing.** Before sealing a change that touched source,
   `bun run build`, `bun run lint` **and `bun run test`** must pass — or
   `bun run verify`, which runs all three plus the `site/` build and lint. For
   `src-tauri/` changes also `. "$HOME/.cargo/env" && bun run tauri build`.
   **Build and lint alone do not cover the suite**: `tsconfig.app.json` excludes
   `*.test.ts`, so a renamed string or a changed signature breaks assertions
   while both stay green — that shipped seven green-gated commits with six red
   render tests on 2026-08-02. If checks fail, keep iterating on `@` — do not
   seal. "What builds" is exactly the working copy; there is no index to get out
   of sync.
3. **One fix per change.** Each distinct bug fix is its own change. If several
   unrelated fixes piled onto `@`, split them before sealing — do NOT seal a fat
   change and do NOT `jj squash` unrelated fixes together:
   ```bash
   jj split path/to/onefix.ts other/related.ts   # those files → first change; rest stays on @
   ```
   `jj split` is non-interactive when you name filesets (0.41) — name the files
   for one fix, repeat for the next.
4. **Visual-nudge exception.** During rapid back-and-forth on one element ("up a
   bit", "smaller", "too much"), keep editing the *same* `@` across all nudges —
   do NOT `jj new` between tweaks. jj auto-amends `@`, so the sequence collapses
   into one commit, sealed once at the final "ok". During an active nudge loop,
   don't even raise sealing — skip the usual stop-to-report (§2.1) and keep
   iterating until the terminal "ok"/"好了"; offering to commit after each tweak is
   itself the mistake Jesse flagged ("不要着急 commit"). If nudges got split across
   changes, `jj squash` them back into one before sealing.
5. **Bundle the knowledge with the fix.** A noteworthy pitfall's `docs/POSTMORTEMS.md`
   entry, and the changelog edits, belong on the *same* change as the fix they
   describe — included on `@` before the single seal. The changelog is FOUR files
   kept in correspondence: the three user-facing trimmed files
   `docs/changelog/{zh,en,ja}.md` (these are what `ChangelogModal.tsx` bundles via
   `?raw`) plus the maintainer `CHANGELOG.md` (zh, full detail with SHAs — NOT
   bundled). Do NOT mistake root `CHANGELOG.md` for the in-app zh copy. The
   user-facing files must be sealed *before* any release build (they're bundled
   into the app at build time).
6. **Forward-only history.** Freely amend the working-copy `@` — re-describe,
   squash, restore — while it's still un-sealed (you haven't moved off it via
   `jj new`/`jj commit`, and it isn't pushed). Once a change is sealed (finalized
   and moved on) or pushed, do NOT rewrite it (`jj squash`/`abandon`/`edit`/
   `describe`) — create a follow-up change instead. Never rewrite pushed changes
   without an explicit ask. The immutable-protection refusal is on your side here.
7. **Manager mode.** When Jesse says "后面让 Codex 来做", perform only read /
   verify / seal jj operations — never edit source. Codex's edits are already on
   `@` via auto-snapshot; verify with `jj --no-pager diff`, run the green checks,
   summarize, and seal when the gates are green (rule 1).
8. **Refactors are their own change, proposed first.** A shared-abstraction
   refactor is a separate, clearly-described change from any bug fix. Propose the
   plan before sealing — never seal a speculative refactor then offer to revert.
   jj makes "try on a fresh change, `jj abandon` if vetoed" cheap, but the call
   is Jesse's, surfaced before sealing.

### Commit-message style (when you do seal)

English, imperative, **subject ≤ 72 chars**, body explains the *why*. jj's first
description line is the subject — keep it tight. When sealing work Codex
implemented, preserve attribution in the body:

```
Co-authored-by: codex <codex@users.noreply.github.com>
```

## 3. Parallel editing — the killer property here

Codex (run by Jesse, or delegated via the `codex-shiori` skill) and Jesse both
edit and commit in the same working copy *during* the conversation. Earlier reads go stale within
minutes.

- **Re-derive state every turn before asserting anything.** `jj --no-pager st`
  and `jj --no-pager log -r '::@' -n 15`. jj auto-snapshots external edits on
  every command, so this is always live and authoritative — lean on it instead of
  trusting an earlier read. Never cache a repo-state claim across turns.
- **Codex run directly by Jesse may commit via git** (under `codex-shiori`
  delegation it never does — Claude seals). In this colocated repo, jj
  auto-imports git commits on every command, so after a Codex run just run
  `jj --no-pager log` (the log command itself does the import) to see them.
- **Concurrent ops → reconcile, never clobber.** If an external process mutated
  the repo, jj may record a divergent operation. Inspect with `jj op log`; if
  needed `jj op restore`/`jj op revert` — never force-overwrite another actor's
  change.
- Code-read ≠ runtime. When a change's effect depends on WebView/platform
  behavior, flag it for Jesse to verify rather than asserting it from the diff.

### Parallel agents: one workspace each

Two agents in one checkout corrupt each other's commits: jj snapshots the whole
tree on every command, so one agent's half-written files land in the other's
`@` (it produced empty commits and misplaced descriptions). Each concurrently
running agent therefore gets its own `jj workspace`, and the workspace decides
the role:

- **`default` (the main checkout, the only git-colocated one) is the integrator.**
  It advances `main`, pushes, and integrates the other workspaces' commits.
- **An added workspace (`../shiori-ws2`, …) is a worker.** jj only (plain
  `git` does not work there); it commits its own work and leaves `main` alone.

All workspaces share one `.jj/repo`, so a worker's commit shows up in every
`jj log` at once; there is no push or pull between them. The loop:

```bash
jj workspace add ../shiori-ws2 --name ws2       # then: cd ../shiori-ws2/site && bun install
# worker edits and seals in ws2 (jj commit -m …)
jj rebase -r <worker change> -d <integrator's latest sealed change>   # from default
jj rebase -r @ -d <worker change>               # default's @ on top of it
jj workspace forget ws2 && rm -rf ../shiori-ws2 # once ws2's jj st is clean
```

After a rebase elsewhere, a workspace reports itself stale; `jj workspace
update-stale` refreshes it. Each workspace needs its own `bun install` and
Rust `target/` (8–21 GB for `src-tauri/target`), so keep only the slots an
agent is actually using.

## 4. Everyday loop

```bash
jj --no-pager st                       # where am I, what changed, any conflicts
jj --no-pager log                      # graph of the mutable stack
jj --no-pager diff --git               # @ vs parent, unified
jj --no-pager show <change-id>         # one commit

# describe-first is optional, not mandatory:
jj describe -m "subject"               # set @'s message; @ seals once you move on (jj new/commit) (§2.1)
jj new                                 # start a fresh empty change on top of @
jj commit -m "subject"                 # seal @ AND open the next change (gated)
jj edit <change-id>                    # make an existing commit the working copy
```

**Trap — `describe` does not move you off `@`.** `jj describe` only sets a
message; `@` stays the working copy. Edit again without `jj new` and those edits
snapshot into the *same* change, and the next `jj describe` **silently replaces**
the message you just wrote — two fixes fused into one change with only the
second's subject, no warning. It looks like the first commit vanished. Recover
with `jj op log` → `jj op restore <the describe op>`, then `jj new` and redo.

For a run of sequential commits prefer **`jj commit -m`**: it seals and opens the
next change in one call, so the gap where this trap lives never exists. Reach for
`describe` + `jj new` when you want to name `@` before deciding it is finished —
and treat the `jj new` as part of the same step, never a later one.

Shaping changes (all non-interactive forms shown):

```bash
jj split <files>                       # named files → first/parent change, rest stays on @ (child); NOT siblings, -p for that (§2)
jj squash                              # fold @ into its parent (only for related work)
jj squash --from <id> --into <id> <f>  # move specific file's changes between commits
jj absorb [paths]                      # auto-distribute @'s hunks into the ancestors
                                       #   that last touched those lines (fixup-everywhere)
jj restore <paths>                     # discard an edit in @ (restore from parent)
jj abandon <change-id>                 # drop a change; descendants reparent
```

## 5. Recovery (memorize)

```bash
jj undo                  # revert the last operation — first reflex after any mistake
jj --no-pager op log     # every operation, with IDs
jj op restore <op>       # snap the WHOLE repo back to that op (destructive replace)
jj op revert <op>        # invert one specific past op, keep later work (additive)
jj --at-op=<op> st       # inspect a past state without changing anything
```

Note: there is **no `jj op undo`** in 0.41 (it errors). Top-level `jj undo` is the
undo; the op-namespace verb is `jj op revert`.

## 6. Bookmarks & pushing

Bookmarks ARE git branches (jj renamed branch → bookmark). The trap: **bookmarks
do NOT auto-advance when you commit** — you move them yourself before pushing.

```bash
jj bookmark set main -r @-              # point/update a bookmark (create-or-update)
jj --no-pager bookmark list --all-remotes  # see local + all remote bookmarks
jj git fetch                            # fetch (rebase your stack after: jj rebase -d main)
jj git push --bookmark main             # push that bookmark
jj git push -c @                        # push @ under an auto-named push-<id> bookmark
```

- `jj git push` is **force-with-lease by default** — it rewrites the remote
  bookmark when your local moved, refusing only if the remote diverged from your
  last fetch. Treat it as a force push; don't run it on shared branches without an
  ask (§2.1, §2.6).
- **Fork-PR pushes stay on plain git.** After `gh pr checkout <N>` the branch's
  pushRemote is the fork while `origin` is upstream. Use a **bare `git push`** —
  NOT `jj git push --remote origin` and NOT `git push origin <branch>`, both of
  which hit upstream and create a stray branch. jj's named-remote push reproduces
  exactly the failure mode the fork-PR rule above warns against. If a
  stray upstream branch slipped through: `git push origin --delete <branch>` then
  a bare `git push` to recover.

## 7. Tags & releases — this part stays git

**jj 0.41 cannot push tags.** `jj git push` has no `--tags`; `jj tag` has only
`set`/`list`/`delete`. jj tags are lightweight-only (no annotated tags). So:

- A jj bookmark/change is **not** a git tag and will not trigger Shiori CI.
- App CI (`release.yml`) fires **only** on a real git tag matching `v*` pushed
  to `origin` (Nagi-ovo/shiori). The CLI has its own `cli-v*` tags, which run
  `cli-release.yml`; pushing one publishes the CLI (see `cli/README.md`). The tag must point at the bump commit *after* it is
  already on `origin/main` — sealing the bump does NOT advance `main` (§6:
  bookmarks don't auto-advance), so push the bookmark first, verify, then tag with
  **git**:
  ```bash
  jj bookmark set main -r @- && jj git push --bookmark main   # bump commit → origin/main
  git merge-base --is-ancestor HEAD origin/main && echo "on origin/main — safe to tag"
  git tag -a vX.Y.Z -m "Shiori vX.Y.Z" && git push origin vX.Y.Z
  ```
  In this colocated repo git refs export automatically, so plain `git tag` /
  `git push` work as before. If `merge-base` fails, the tag would fire CI against a
  commit `origin/main` never saw — fix before tagging.
- **The tag is only step 1.** It triggers Windows/Linux/Android DRAFT builds.
  Users cannot auto-update until the local signed macOS build
  (`./scripts/build-signed.sh`), the `gh-pages` updater manifest
  (`alpha/latest.json` + `notes/<version>.json`), and a green updater verifier are
  all done. **Do not treat tagging as "released."**
- For any release, **hand off to the `shiori-release` skill** — it owns the full
  flow and the updater-signing gate. This skill only ensures the version-bump
  change (package.json, site/package.json, src-tauri/tauri.conf.json,
  src-tauri/Cargo.toml + Cargo.lock, lockstep) and the trilingual changelog are sealed and pushed to `origin/main`
  *before* the tag points at that commit.

## 8. Conflicts

jj never stops mid-operation on a conflict — merges/rebases always complete and
the conflict is recorded inside the commit. Resolve by either editing the
conflicted file directly (jj clears the conflict when the markers are gone, on the
next command) or `jj resolve` for a 3-way tool. `jj --no-pager resolve --list`
shows conflicted paths.

## Quick reference

| Action | Command |
|--------|---------|
| Status / log / diff | `jj --no-pager st` · `jj --no-pager log` · `jj --no-pager diff --git` |
| Seal (gated!) | `jj describe -m "…"` then `jj new`, or `jj commit -m "…"` |
| Start next change | `jj new` |
| One fix per change | `jj split <files-of-one-fix>` |
| Fold related work | `jj squash` / `jj squash --from <id> --into <id>` |
| Auto-fixup ancestors | `jj absorb [paths]` |
| Discard an edit | `jj restore <paths>` |
| Undo last op | `jj undo` |
| Repo time-travel | `jj op log` → `jj op restore <op>` |
| Move bookmark | `jj bookmark set <name> -r @-` |
| Push branch | `jj git push --bookmark <name>` (fork PRs: bare `git push`) |
| Tag a release | `git tag -a vX.Y.Z -m …` + `git push origin vX.Y.Z` (git, not jj; only after bump is on origin/main) |
| See Codex's git commits | any jj command auto-imports — just `jj --no-pager log` |
