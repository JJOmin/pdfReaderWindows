# Working with Claude on this project

This is the workflow template. It is written for this project, but only the last section is
specific to it. To reuse it elsewhere, copy `CLAUDE.md`, `.claude/` and this file, then rewrite
the project parts.

## The loop

Every change, small or large, goes through the same five steps. Small changes do them in one
prompt. Large ones get a step each.

| Step      | What happens                                            | How to start it                      |
| --------- | ------------------------------------------------------- | ------------------------------------ |
| 1. Spec   | Say what should be true afterwards and how to check it. | `/spec`, or write it in docs/SPEC.md |
| 2. Plan   | Break it into steps that can each be verified.          | `/plan`, or plan mode (Shift+Tab)    |
| 3. Build  | One step at a time, test first for logic.               | `/build`                             |
| 4. Verify | Run the checks. Look at the real thing.                 | `npm run check`, `npm run test:e2e`  |
| 5. Review | Read the diff with fresh eyes before keeping it.        | `/code-review`, `/ponytail-review`   |

The step people skip is 1. A request such as "make headings work better" produces guesses. A
request such as "the block `2.1 Related Work` on page 3 of paper.pdf is read as body text, it
should be a heading, and the dump should show it" produces a fix.

The step Claude skips is 4. Ask "what did you run and what did it print" whenever a change is
reported as done. In this project speech and highlighting can only be confirmed by the e2e test.

## What is installed and why

Project settings live in [.claude/settings.json](../.claude/settings.json). Claude Code asks once
whether to trust the two plugins when you next open the folder.

**Ponytail** (plugin, pinned to v5.2.0). Pushes Claude toward the smallest solution: reuse what
exists, prefer the standard library and the platform, add no abstraction nobody asked for. It
activates itself at session start. Its hooks only read and write local files.

- `/ponytail lite|full|ultra` sets how hard it pushes. `full` is the default.
- `/ponytail-review` reviews a diff for bloat. `/ponytail-audit` does the same for the whole repo.
- "stop ponytail" turns it off for the session.

**Agent Skills** (plugin, pinned to 0.6.12). A set of engineering workflows as slash commands:
`/spec`, `/plan`, `/build`, `/test`, `/review`, `/code-simplify`, `/ship`. Each one is a Markdown
file that tells Claude which steps to follow and which shortcuts not to take. Read a few of them
in the plugin folder. They are the best examples of how to write your own.

Plugin commands can appear with a prefix in the menu, such as `/agent-skills:spec`.

The two pull in different directions on purpose. Agent Skills adds process, Ponytail removes code.
If a `/spec` or `/plan` grows larger than the change deserves, say so and cut it.

**Formatting hook** ([.claude/hooks/format.mjs](../.claude/hooks/format.mjs)). After every file
Claude writes or edits, Prettier formats it. This is a hook, not an instruction, because
instructions get forgotten and hooks do not. Review or disable it with `/hooks`.

**Allowed commands.** The check, test, build and dump scripts run without a permission prompt.
Everything else still asks.

**Project skills** in `.claude/skills/`. These hold knowledge that only this project has:

- `text-detection` How to fix a PDF that is read wrongly.
- `add-voice` How to add a speech model.

**Built in, no install needed:** `/code-review` (finds bugs in the current diff), `/simplify`
(cleans it up), `/security-review`, plan mode, and memory.

## What is not installed and why

**Graphify** builds a knowledge graph of a codebase so Claude can query structure without reading
files. Two reasons to wait. This repository is about twenty source files, which Claude reads faster
than it could query a graph. And it does not install on this machine: the only Python here is a
32-bit 3.15 build, and its dependencies ship no packages for that. To try it later, install
64-bit Python 3.12 or 3.13, then:

```
pip install graphifyy
graphify install --project
```

Then run `/graphify .` inside Claude Code. It adds its own hooks and a section in CLAUDE.md.

**OmniRoute** is not a skill. It is a local gateway that sends Claude Code's requests to other
model providers and holds your API keys for them. It does nothing for code quality, and every
prompt and file Claude reads would pass through it. Use it only if you want to run Claude Code on
other models, and decide first which providers you trust with this project's content.

## Habits that make the difference

- **Give Claude a way to check its own work.** The dump script exists for this. Without it, text
  detection could only be judged by listening.
- **One concern per session.** Start a new session (`/clear`) for a new task. Long sessions drift.
- **Correct the file, not the chat.** When Claude repeats a mistake, add one line to CLAUDE.md.
  When you repeat an explanation, turn it into a skill.
- **Read the diff.** Use `git diff` or the VS Code source control view before every commit.
  Commit small and often, so a bad change is cheap to throw away.
- **Ask for the reasoning on decisions, not on edits.** For a design choice ask for two options
  and a recommendation. For an edit just read the diff.

## Writing your own skill

A skill is a folder with a `SKILL.md`. The `description` in its header decides when Claude loads
it, so write it as "use when ...". The body is instructions to a capable colleague who does not
know this project: what to do, in which order, and how to tell that it worked. Keep it under a
page. The two skills in `.claude/skills/` are short on purpose. Copy one to start.

## A first exercise

The backlog in [SPEC.md](SPEC.md) starts with "do not read text inside figures". It is a good
first task to drive yourself:

1. `/spec` Describe the problem with a real page: `npm run dump -- paper.pdf 3`.
2. `/plan` Ask for two approaches and a recommendation.
3. `/build` Insist on a failing unit test in `tests/unit/layout.test.ts` first.
4. `npm run check`, then the dump again on the same page.
5. `/code-review`, then commit.
