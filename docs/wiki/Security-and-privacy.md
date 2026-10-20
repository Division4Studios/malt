# Security and privacy

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/Division4Studios/malt/security/advisories/new), never in a public issue. Do not include live secrets or attach a `.malt/` archive. The [security policy](https://github.com/Division4Studios/malt/blob/main/SECURITY.md) describes the process. If a credential was exposed, revoke and rotate it first.

## Keep local state private

- Keep `.malt/`, provider credential folders, `.env` files, private keys and backups out of source, images, exports and public logs. MALT Git-ignores `.malt/` and refuses to dispatch when the index contains it.
- Pair only with a console you started. Keep the pairing code private and rotate it with `pairing-code --rotate` if it may have leaked. Do not expose the console or broker ports beyond loopback.
- Review the project's commands and role permissions before dispatch. Developers run native commands under your OS account, and `full-access` lifts the worktree restriction.
- Secrets in **Project → Secrets** are sealed with AES-256-GCM and reach only the role types you grant. The key lives in `.malt/`, so a backup of `.malt/` contains it.
- Treat third-party skills and tools as untrusted until you review their license, provenance and behavior. Approving a skill applies to one exact revision.
- Ignoring a file does not remove it from Git history. Scan the history before publishing and rotate anything that leaked.

## Supply chain

The browser app has no npm packages. The backend has three runtime packages (Zod, the MCP SDK and `node-pty`), pinned exactly, installed with scripts disabled, audited at every severity and limited to MIT-compatible licenses on every pull request. See the [dependency policy](https://github.com/Division4Studios/malt/blob/main/docs/dependency-policy.md).

The repository's required checks, scanning and the temporary solo-maintainer review exception are recorded in [GitHub controls](https://github.com/Division4Studios/malt/blob/main/docs/github-controls.md). The project uses the OpenSSF Baseline as a review framework and claims no badge or certification; see the [release-readiness ledger](https://github.com/Division4Studios/malt/blob/main/docs/open-source-readiness.md).
