# Current implementation and remaining work

Audited on **2026-10-15** against main [0325f63](https://github.com/Division4Studios/malt/tree/0325f63). All **95 initially open issues** were examined individually: **27 implemented scopes**, **22 partial scopes**, and **46 queued scopes**. See the [complete issue audit](Issue-audit-2026-10-15) and [live Project](https://github.com/users/Division4Studios/projects/10). This is a dated snapshot, not a completion claim for the entire product.

Documentation Stack #151 subsequently merged at e925bb5, completing #45 and parent #40. The final audit retains #28 for an actual admission-sampling redraw regression and #51 until its state-machine guide correction merges. No historical approval is invented.

## Implemented

- Durable project-local MCP communication, SQLite claims/instructions and restart recovery; idle roles have no model process.
- Managed subscription CLI delivery, owned worktrees/processes, two QA roles, defect return, expected-head merge and actual-main verification.
- All-objective queue visibility, durable ordering/focus, existing-delivery clearance and actionable blocker/size-exception decisions.
- Backward event **API**, durable handoff provenance, observed quota windows/freshness and owned process telemetry.
- Atomic planning up to 100 meaningful children, focused per-stage skills, lead-reviewed tier/effort metadata and risk/rework floors.
- GitHub Project URL form, v2 tracker/source records, typed-key migration, capability policy **store**, recommendation **store/classifier**, and terminal **fixture/frames/buffer**.

## Partial or queued

| Feature                                                                           | Remaining boundary                                                                            |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [Activity history #12](https://github.com/Division4Studios/malt/issues/12)        | Client paging model and older-page UI; API alone does not provide browsing                    |
| [Handoffs #17](https://github.com/Division4Studios/malt/issues/17)                | Unified report/message feed and meaningful Mission previews                                   |
| [Subscription capacity #21](https://github.com/Division4Studios/malt/issues/21)   | Legacy Claude windows and subscription-first presentation                                     |
| [Parallel capacity #27](https://github.com/Division4Studios/malt/issues/27)       | Admission redraw/focus repair, complete admission UI and deferred-supervisor overlap fixtures |
| [Model policy #32](https://github.com/Division4Studios/malt/issues/32)            | Revisioned allowed provider/model/effort combinations, enforcement and editor                 |
| [Project management #50](https://github.com/Division4Studios/malt/issues/50)      | Observed issue corpus, human decision routes/pane, intake/execution/notifications             |
| [Project connectors #72](https://github.com/Division4Studios/malt/issues/72)      | Discovery, universal capability enforcement, labels/milestones/views, real Jira               |
| [Interactive terminals #101](https://github.com/Division4Studios/malt/issues/101) | Real PTY host/service, routes, browser screen/input and platform e2e                          |

The complete main check passed **236 tests**, strict types/lint/format and web build. The merged stack passed Windows/Linux/macOS, actual Docker/MCP/PWA restart smoke and security/CodeQL checks. Regression inference/GitHub are fixtures; no paid agent was launched for this audit. The pinned official container reports Node **24.22.0 LTS**; the browser has zero production npm dependencies.

A complete live protected-review delivery, installed-PWA lifecycle/accessibility audit and integrated PTY/provider support remain unverified. A merged PR, passed fixture, closed issue or published wiki does not deploy the running daemon. Use [Operations](Operations) for safe queue/recovery/restart behavior.
