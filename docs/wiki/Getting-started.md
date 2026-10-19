# Getting started

You need Node.js 24.15.0 or later in the 24.x line, npm, Git, and at least one of the Claude Code or Codex CLIs logged in with a subscription account. GitHub delivery also needs the GitHub CLI (`gh`).

```sh
git clone https://github.com/Division4Studios/malt.git
cd malt
npm ci --ignore-scripts
npm run build:web
node src/cli.ts doctor --project /absolute/path/to/a/disposable/project
node src/cli.ts ui --with-broker --project /absolute/path/to/a/disposable/project --port 4318
```

1. `doctor` reports **PASS**, **FAIL** or **FIX-IT** for Node.js, Git, the provider logins, `gh`, the ports and a writable project. It changes nothing.
2. `ui --with-broker` starts the broker and the console together and prints a pairing code.
3. Open `http://127.0.0.1:4318/` and enter the code. The **Get started** guide opens.
4. Choose a delivery mode: local (a protected hub in `.malt/`, no hosted service) or GitHub.
5. Save a factory policy with real test commands, set a spend cap, submit a small objective and start the factory.

On Windows, quote paths such as `"C:\work\sandbox"`. The pairing code is a credential; keep it out of public reports.

The full walk-through, including every `doctor` check, Docker, attached Claude Code and Codex sessions, upgrades and backups, is the [getting started guide](https://github.com/Division4Studios/malt/blob/main/docs/getting-started.md). To move to a real repository, read [Use MALT on your own project](https://github.com/Division4Studios/malt/blob/main/docs/using-malt-in-your-project.md).
