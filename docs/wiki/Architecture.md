# Architecture and trust boundaries

![MALT components: the operator's browser and CLI talk to one local broker and supervisor, which launch provider CLIs through bridges, keep state in the project's .malt folder and deliver through GitHub or a local hub](https://raw.githubusercontent.com/Division4Studios/malt/main/docs/images/diagrams/system-overview.svg)

- The **broker** is one local service. It validates every request and owns each project's SQLite state in that project's private `.malt/`.
- The **supervisor** runs inside the broker. It schedules bounded assignments, launches the provider CLIs in owned worktrees and retires them. It spends no model tokens while it waits, and idle roles have no process.
- A **bridge** connects one agent session to the broker over MCP. It is not a model and uses no tokens.
- The **console** is a PWA served on loopback. The browser holds no project token or provider secret, and every change goes through the same backend checks as the CLI.

Each project is isolated: its messages, claims, evidence, skills and accounting stay in its own `.malt/`. Delivery goes through GitHub or through a protected local hub.

MALT trusts the local user. It is not a sandbox for hostile agents or a multi-tenant service. Process groups and Windows Job Objects clean up owned processes; resource limits are admission thresholds, not hard kernel ceilings on every OS.

See the [architecture guide](https://github.com/Division4Studios/malt/blob/main/docs/architecture.md) for modules, transactions and recovery, and the [API reference](https://github.com/Division4Studios/malt/blob/main/docs/api.md) for every tool and operation.
