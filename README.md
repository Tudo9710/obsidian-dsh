# DSH for Obsidian

Embed **DSH (DeepSeek Harness)** as the **single AI agent** inside your Obsidian vault. Chat with your notes, have DSH read, search, and edit files directly in the vault — no copy-paste.

```
Your request
      │
      ▼
DSH (dsh --profile headless, vault as working directory)
      │  reads files / searches your knowledge base / produces Markdown
      ▼
<vault>/.dsh/sessions/conv-*.json   (session history, travels with your vault)
```

## Features

- **Chat panel** — open from the ribbon icon or the command palette; Enter to send (Shift+Enter for a new line).
- **Single agent** — every message runs `dsh --profile headless <task>` in the vault root. No other agents, no extra setup.
- **Live thinking** — while DSH works, a 🧠 panel streams its reasoning text and tool calls in real time (backed by DSH's JSONL event stream), then collapses into a summary you can expand anytime.
- **Toolbar selectors** — switch the **model** (e.g. deepseek-v4-flash / deepseek-v4-pro), **reasoning effort** (off / high / max) and **permission mode** (read-only / workspace-write / full access) right next to the send button. Choices are remembered per session.
- **Multi-session parallel** — start several conversations side by side; background runs keep going while you switch between sessions. Queue, interject and cancel are built in.
- **Session history** — conversations are stored in `<vault>/.dsh/sessions/`; browse, search, reopen or delete them from the history modal, or manage everything in the dedicated Session Manager view.
- **Note mentions** — type `@` to fuzzy-search your vault and insert `@[[Note Name]]`; the note's content is attached to the request. The active note is auto-attached as `@[[...]]` (toggle it off with one click).
- **Embedded chats** — drop a ```` ```agent-client ```` code block in any note to embed a live chat right there.
- **Export** — save any conversation as a Markdown note with frontmatter, manually or as a record of your work.
- **Model discovery** — scan your local DSH config (`~/.dsh/settings.yaml`) to populate the model list and defaults, with status feedback and a 10s timeout.
- **Plain JavaScript, no build step** — copy the folder into `.obsidian/plugins/` and enable.

## Requirements

- [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/dsh) installed locally (the `dsh` command or the `@deepseek-ai/dsh` package in the npx cache).
- A `~/.dsh/.credentials.yaml` with `DEEPSEEK_API_KEY` (or the DSH credentials service configured).
- Desktop Obsidian (the plugin spawns a local process; `isDesktopOnly: true`).

## Installation

1. Copy the `dsh-plugin/` folder to your vault's plugin directory:

   ```
   <your-vault>/.obsidian/plugins/dsh/
   ```

2. In Obsidian: Settings → Community plugins → enable **DSH**.
3. Click the robot icon in the ribbon, or run the command "Open DSH chat".

## Usage

- **Send a task** — just type it, e.g. "Summarize today's meeting notes" or "Research this topic from my vault".
- **Context** — open a note and it is auto-attached (`@[[Note]]`); mention more notes with `@`. The mention chip in the input box shows what will be attached; click it to toggle.
- **Sessions** — the history button in the header opens the history modal; the "Open DSH session manager" command opens the manager view.
- **Permission modes** — `workspace-write` (default) lets DSH read and write vault files; use `read-only` for questions only, or `danger-full-access` with care (maps to DSH's `DSH_PERMISSION_MODE`).
- **Export** — the save icon in the header writes the conversation to a Markdown note.

## Settings overview

| Setting | Description |
|---|---|
| Show thinking | Stream reasoning + tool calls live (default on); off falls back to a status line |
| Discover models | Scan `~/.dsh/settings.yaml` for the model catalog, fill the model list and defaults |
| Model list | Comma-separated options for the model selector |
| Default model / effort | New sessions start with these (provider is always `deepseek-official`) |
| DSH command / entry | Leave empty for auto-detect; or set a node entry (`…/lib/bin.js`), `.cmd` wrapper, or custom command |
| Node.js path | Leave empty for auto-detect (Obsidian's built-in Electron is **not** node) |
| DSH_HOME override | Leave empty to use `~/.dsh` (where `.credentials.yaml` lives) |
| Permission mode | Default for the chat selector: read-only / workspace-write / danger-full-access |
| Extra launcher args | Extra args passed to dsh, e.g. `--patch C:/path/extra.yml` |
| Custom prompt | Appended after the built-in system prompt |
| Timeout (seconds) | Per-task limit, default 600 |

## How it works

- Every message spawns `node <dsh entry> --profile headless <assembled task>` with the vault root as the working directory.
- The task text = system prompt (Obsidian conventions) + recent conversation turns + current request + context tags (`<linked_note>`, `<note_content>`).
- Sessions are stored as `conv-<timestamp>-<random>.json` with `title / createdAt / lastActivityAt / messages[]`.

## Development & self-tests (no Obsidian needed)

```bash
node scripts/build-plugin.js    # rebuild the single-file main.js after editing the template/provider
node test/load-test.js          # mock-Obsidian load tests
node test/provider-test.js      # provider chain tests
node --check dsh-plugin/main.js # syntax check
```

## Troubleshooting

If Obsidian reports "plugin failed to load":

1. Fully quit and restart Obsidian (or Ctrl+R to reload).
2. Open the developer console (Ctrl+Shift+I → Console), copy the red error, and report it.
3. Common causes: partial copy of the plugin folder (re-copy and restart), or restricted mode enabled (disable it).

## License

Apache-2.0. The visual design is adapted from [RAIT-09/obsidian-agent-client](https://github.com/RAIT-09/obsidian-agent-client) (Apache-2.0); the DSH backend integration and DSH-specific additions are original.
