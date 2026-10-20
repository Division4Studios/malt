# Contributing and finding your way

Search open and relevant closed issues before proposing work. Ask setup questions in [Q&A](https://github.com/Division4Studios/malt/discussions/categories/q-a), discuss larger proposals in [Ideas](https://github.com/Division4Studios/malt/discussions/categories/ideas), file reproducible defects with the [issue forms](https://github.com/Division4Studios/malt/issues/new/choose), and report vulnerabilities privately. Never include credentials, model transcripts or private runtime state in a public example.

## Make a change

1. Agree on one verifiable scope. Name genuine prerequisites; keep independent slices separate.
2. Branch from current main and implement with regression tests and updated docs.
3. Run `npm ci --ignore-scripts` and `npm run check`, the same gate CI runs on Windows, Linux and macOS.
4. Open a focused pull request with a Conventional Commit title. `CHANGELOG.md` is generated from those titles.
5. Refresh onto current main and get a fresh review when the source or base changes.

Do not add runtime npm packages. The backend keeps exactly three and the browser has none.

The [contribution guide](https://github.com/Division4Studios/malt/blob/main/CONTRIBUTING.md) has the full process, console text rules and CI behavior. The [community operations guide](https://github.com/Division4Studios/malt/blob/main/docs/community-operations.md) explains labels, issue forms and Discussion categories.

No donation is needed to contribute. [Sponsorship](https://github.com/Division4Studios/malt/blob/main/SPONSORING.md) funds subscription access, verification and security work, and does not buy a support SLA or a roadmap.
