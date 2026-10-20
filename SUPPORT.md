# Getting help

- **Usage and setup:** [Q&A Discussions](https://github.com/Division4Studios/malt/discussions/categories/q-a).
- **Feature proposals:** [Ideas](https://github.com/Division4Studios/malt/discussions/categories/ideas); search existing issues first.
- **Reproducible bugs:** [issue forms](https://github.com/Division4Studios/malt/issues/new/choose).
- **Vulnerabilities:** [private reporting](SECURITY.md), never a public bug report.
- **Documentation:** [getting started](docs/getting-started.md), the [documentation index](docs/README.md), the [wiki](https://github.com/Division4Studios/malt/wiki), [architecture](docs/architecture.md), [operator console](docs/operator-console.md), [troubleshooting](docs/logging-and-troubleshooting.md).

Include the MALT commit, OS, Node version, native or container mode, expected result and a minimal reproduction. The output of `node src/cli.ts doctor` is a useful start for setup problems; it checks Node, Git, the provider CLIs and their logins, `gh`, the ports and `.malt`. State whether the failure concerns an attached MCP session, managed role, or browser operator session. Redact local paths as appropriate, pairing codes, tokens and transcripts; do not upload `.malt` or provider homes. A job ID and a short sanitized error are usually more useful than an entire log archive.

Support is community best effort. Do not post the same request repeatedly across channels. Sponsoring development does not create an SLA or guaranteed feature commitment.

For worktree or input questions, distinguish **Scratch terminals** (operator sessions you start explicitly under **Sessions → Workers & terminals**) from the captured logs of managed jobs; scratch output cannot satisfy delivery gates. Check the [terminal support contract](docs/interactive-terminals.md) and [current capability map](docs/current-status.md) before assuming a requested integration is implemented. Source merges and wiki updates do not redeploy your daemon.

To support continued development, see [sponsorship](SPONSORING.md). Donations do not create a support SLA or privileged security-reporting route.
