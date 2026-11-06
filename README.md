# pi-extensions

Small extensions for the [pi coding agent](https://pi.dev). One repo, one pi package; every extension lives in `extensions/<name>/index.ts` and is loaded automatically.

中文说明见 [README.zh-CN.md](README.zh-CN.md).

## Install

```bash
pi install git:github.com/szxypi/pi-extensions
```

Load only some of them with a package filter in `~/.pi/agent/settings.json`:

```json
{ "source": "git:github.com/szxypi/pi-extensions", "extensions": ["extensions/session-autoname/index.ts"] }
```

## Extensions

### session-autoname

Pi does not name sessions by itself. This extension sends the first request to a model in the background and sets a short title with `pi.setSessionName()`, so `/resume`, the footer and the terminal title show what the session is about.

- Runs once per session, in parallel with the first run. It never delays the agent.
- Never overwrites a name from `/name`, `--name` or another extension.
- Falls back to the first line of the prompt when the model call fails.
- Skips print/json mode and pi-subagents child processes.
- `/autoname` regenerates the title; `/autoname status` shows config.

Config `~/.pi/agent/session-autoname.json` (all optional):

```json
{ "enabled": true, "model": "provider/model-id", "maxLength": 40, "timeoutMs": 20000 }
```

`model` defaults to the session's current model. A small fast model keeps naming cheap. The first request (up to 2,000 characters) is sent to that model.

### terminal-status

Shows pi's run state on the terminal tab, modelled on Claude Code.

| State | Tab title | OSC 9;4 (Windows Terminal ring / taskbar) |
|---|---|---|
| working | `◐`/`◑` alternating every 960 ms | indeterminate |
| blocked (dialog waits for you) | `⏸` | warning (yellow) |
| done | `✓` until you press a key | cleared |
| error | `✗` until you press a key | error (red) |
| idle | `✳` | cleared |

The title is `<icon> <session name> · <directory>`.

Pi already reports these states with [OSC 7501](https://www.superlogical.com/rex/docs/build/program-status) on terminals that answer its support query (Ghostty and others). Windows Terminal does not support OSC 7501 yet, so this extension renders the same states with OSC 9;4 and the title.

- OSC 9;4 is on by default only where it renders: Windows Terminal (`WT_SESSION`, also forwarded into WSL), ConEmu, Ghostty ≥ 1.2, iTerm2 ≥ 3.6.6. It is skipped inside tmux/screen/zellij. If pi's own `terminal.showTerminalProgress` is on, this extension leaves OSC 9;4 to pi.
- `/terminal-status` shows what was detected.

Config `~/.pi/agent/terminal-status.json`: `{ "progress": "auto" | "on" | "off", "title": true }`. `PI_TERMINAL_STATUS=0` turns the extension off.

### image-paste

Paste a clipboard image into the prompt as `[Image #1]`, like Claude Code.

- `Ctrl+V` (`Alt+V` in a native Windows console) reads the clipboard image through pi's own code. On WSL, pi tries `wl-paste` and then PowerShell.
- The input box shows `[Image #N]` instead of a temporary file path. Backspace and the arrow keys treat the placeholder as one unit.
- Submit sends the image to the model as an attachment. The placeholder stays in the message text.
- Bash mode (`!`) keeps the temporary file path, because the text runs as a shell command.
- Numbering restarts at 1 when you clear the input.
- A placeholder recalled from history attaches no image.
- `PI_IMAGE_PASTE=0` turns the extension off.

### claude-synced-skills

Claude Code syncs claude.ai skills into `~/.claude/skills/synced/<bucket>/`, one bucket per claude.ai account. When several accounts sync, the same skill exists in several buckets with different versions. Pi scans that tree and prints a `[Skill warnings] ... collision` line for each duplicate name. It keeps the first bucket in alphabetical order, which is often the oldest version.

This extension replaces that scan. On `resources_discover` (startup and `/reload`) it reads each bucket's `manifest.json` and returns one `SKILL.md` file path per skill name. You maintain no bucket IDs, and new buckets are picked up on the next start or `/reload`.

- Newest `updatedAt` wins. A tie goes to the bucket with the larger `lastUpdated`, then to the larger bucket directory name.
- A manifest entry whose `SKILL.md` is missing is skipped, so a bucket in the middle of a sync does not hide the skill. A missing or broken manifest skips that bucket.
- Skipped by default (they need claude.ai connectors or memory tools that pi does not have): `skill-creator`, `docs`, `google-workspace`, `import-memory`, `morning`, `setup-writing-style`.

Use it together with an ignore rule. Add this line to `~/.claude/skills/.gitignore` so pi's own scan skips the tree:

```
/synced/
```

Without that line, pi still loads the whole tree and the collisions stay. Claude Code does not read this file.

Config `~/.pi/agent/claude-synced-skills.json` (optional). `skip` replaces the default skip list. An empty list loads everything. Invalid JSON or a wrong type falls back to the default list.

```json
{ "skip": ["skill-creator", "docs"] }
```

## Develop

```bash
npm test                          # unit tests (node --test, no install needed)
pi -e ./extensions/<name>/index.ts  # try one extension without installing
```

Pure logic sits next to each `index.ts` without pi imports, so tests run on plain Node 22.6+ with type stripping.

## License

MIT
