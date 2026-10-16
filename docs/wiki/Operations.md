# Operations and recovery

Project setup verifies repository identity, GitHub access and intended Project. Keep subscription authentication in the provider's supported store and configure actual validation commands. Admission uses provider cooldown/verified utilization plus local CPU, memory and process policy. Unknown subscription quota must remain unknown; diagnostic token counts are not API credits.

Logical roles are not permanent model processes. The supervisor waits without spending model tokens; roles start only for bounded eligible assignments. Stop or cancel only owned jobs through the console. Never blanket-kill PowerShell, Node, Codex or Claude processes.

```mermaid
flowchart LR
  Ready[Eligible durable work] --> Admit{Capacity and resource gates}
  Admit -->|Available| Claim[Transactional claim]
  Claim --> Run[Bounded native assignment]
  Run --> Save[Persist result and evidence]
  Save --> Retire[Retire owned processes]
  Retire --> Ready
  Admit -->|Limited| Park[Park without model process]
  Park --> Admit
```

Use Mission for overview/Activity, Workflow for delivery state, Workers for actual logs/handoffs and Project for connection, policy and learning decisions. Workers also has a separate **Scratch terminals** mode: explicitly start an enabled native provider in an owned worktree, capture keyboard or apply/fit geometry, reconnect output or close the session. This is not a managed developer/QA attachment. An unchanged page can mean genuine dependency, capacity or approval waiting; inspect the recorded blocker rather than manufacturing work.

Scratch terminal defaults are one live process session, five minutes without operator input and thirty minutes total, sharing the real broker-wide admission pool. Windows applies configured Job ceilings; native POSIX process groups provide cleanup without equivalent hard CPU/memory ceilings. Escape releases capture, Tab follows browser focus, and dedicated buttons send native Tab/Escape. Hidden/offline/rescoped views stop input/readers; reconnect never resends input.

Terminal transcripts stay in bounded redacted RAM, while metadata/counters survive in private project SQLite. Pause/shutdown closes owned trees; restart starts none and marks replay unavailable. Dirty scratch edits are retained. Neither scratch commits nor terminal output can satisfy managed delivery gates. See [limits and executed support](https://github.com/Division4Studios/malt/blob/main/docs/interactive-terminals.md), including the token-free three-minute browser fixture and the limited Windows provider startup smokes. No full provider inference turn or universal installed-PWA behavior is implied.

Pause before changing policy. Restart recovery restores durable claims/handoffs and checks actual Git state. Preserve dirty or newer worktrees; never delete them merely because a job ended. Stop the broker before a private backup and restore the entire coherent `.malt` store. See [troubleshooting](https://github.com/Division4Studios/malt/blob/main/docs/logging-and-troubleshooting.md).

## Priority, blockers and deployment

Product queue shows all unfinished objectives; completed/superseded work is collapsed. Move first/up/down changes durable order for future reservations. Focus only this objective holds unrelated new assignments without preempting running work.

Mission recovery offers Continue with team lead, Clarify with product owner, and Work existing deliveries. The last permits retained tickets across objectives while holding new product planning. Clear the path provides exact-revision acknowledge/diagnose/repair/review/verify/wait decisions. Acknowledge is not a fix. A validated source-specific size exception never waives QA, tests or protected merge.

Before retrying, inspect actual PR/main state and the [audit](Issue-audit-2026-10-15). Old failed attempts can describe code already merged. Do not replay implementation or force the private factory ledger to Done merely to match a board label.

Pause stops owned attempts and preserves edits; it does not certify success. Settle work and stop the specific owning broker/UI, update the intended source without overwriting edits, install locked dependencies and build the web shell, then restart matching services and pair again. A browser refresh or a merged PR does not hot-reload a broker. Never run native and container brokers against the same .malt.
