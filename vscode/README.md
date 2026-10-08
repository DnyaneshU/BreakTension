# BreakTension for VS Code

Your editor nags until you go outside. The photo is judged by Gemma running
on your own laptop — no account, no upload, no internet.

## Why an editor client

Someone driving an agent in Claude Code is the most sedentary person in the
building. You are not even typing; you are watching a model work. A browser
extension never sees that time.

## What it does not do

**It never touches your work.** No blocked saves, no intercepted edits, no
closed editors, no cancelled tasks. A modal appears, and if you dismiss it, it
comes back. That is the entire mechanism.

An editor holds work in progress. A break reminder that risks losing an
unsaved thought is worse than no reminder, because it gets uninstalled within
the hour. The friction here comes from persistence, not from taking anything
away. A test suite enforces this — it fails if anything that could disrupt
work is added.

## Setup

1. Start the verifier in the project directory:

   ```bash
   npm run server
   ```

2. Install this extension:

   ```bash
   code --install-extension breaktension-0.1.0.vsix
   ```

   Or, for development, open the `vscode/` folder in VS Code and press F5.

The status bar shows the desk time left. It is **shared with the browser
extension**: switching from Chrome to VS Code is not a break, so both clients
report into one 35-minute budget held by the server.

## Commands

| Command | What it does |
|---|---|
| `BreakTension: Show status` | Desk time left, and which clients are live |
| `BreakTension: Take a break now` | Trigger a break immediately |
| `BreakTension: Pause or resume` | Stop counting editor time |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `breaktension.serverUrl` | `https://localhost:8787` | The local verifier |
| `breaktension.enabled` | `true` | Count editor time |
| `breaktension.remindEveryMinutes` | `3` | How often the reminder returns |

## Skipping

Skipping asks twice, the same as the browser lock screen, and the second
prompt names what it costs. You get 2 skips a day and a skip resets your
streak.
