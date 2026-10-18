# Agent skill for the Shiori CLI

`shiori/SKILL.md` teaches a coding agent (Claude Code, Codex, or anything
that reads skill/instruction files) how to drive the `shiori` CLI well:
context-first, anchor-by-quote, batched specs, and the retry contract.

It documents *workflow*, not the command contract — the CLI self-describes
via `shiori help <command> --agent` and `shiori help spec --agent`, so the
skill cannot drift from flags it never lists.

This folder is the only copy: edit `shiori/SKILL.md` here. It is published
at [`skills/shiori`](https://github.com/Nagi-ovo/shiori/tree/main/skills/shiori),
the same path it had before the source moved into this repository, so older
links keep working. `shiori/agents/openai.yaml` is the agent metadata, and
`shiori/LICENSE` keeps the MIT terms with the folder when it is copied on its
own.

## Install

- **Claude Code**: copy the `shiori/` folder to `~/.claude/skills/shiori/`
  (or a project's `.claude/skills/shiori/`).
- **Codex**: link or copy the folder to `~/.codex/skills/shiori/`.
- **Other agents**: point the agent at `shiori/SKILL.md` or include its
  instructions in the agent's supported user-level configuration.
