# Recommendation store

`FactoryRepository.recommendations` (`src/factory/recommendations.ts`) stores the project's [ticket recommendations](project-management-decisions.md) privately in the existing SQLite store, bound to the project's verified identity. This page is the reference for its identities, lifecycle and limits. For how recommendations are reviewed and executed, see [review ticket recommendations](project-management-decisions.md).

## Identity and revisions

- **Identity** hashes the project, the kind and the sorted, unique set of tickets.
- **Revision** hashes the validated proposal: action, evidence, observed issue revisions, observed local objectives, survivor, transferred acceptance and dependencies, affected assignments and the before/after preview.
- Object key order and ticket order change neither hash.

`propose` stores new content as `proposed`:

- Replaying known content returns its original revision unchanged, without reactivating it.
- Changed content supersedes `proposed` or `awaiting_human` content, which becomes `stale`.
- After `stale` or `rejected`, new content creates a new current revision. History is kept; the old revision is never reopened.
- `approved`, `applying`, `reconciling`, `completed` and `failed` records cannot be replaced.

## Lifecycle

Transitions apply to one revision. Each requires the current revision and the expected current state, inside a SQLite transaction, so a concurrent change refuses the transition without mutating anything.

| From                             | Allowed next states                           | Who or what moves it                                                                    |
| -------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `proposed`                       | `awaiting_human`, `stale`                     | Submission or intake queues it for review.                                              |
| `awaiting_human`                 | `approved`, `rejected`, `stale`               | The human decision, after a freshness re-read.                                          |
| `approved`                       | `applying`, `stale`                           | The supervisor, after re-reading the observed issues and objectives.                    |
| `applying`                       | `completed`, `reconciling`, `stale`, `failed` | The supervisor, as effects are confirmed, become ambiguous or fail.                     |
| `reconciling`                    | `completed`, `applying`, `failed`             | The supervisor, after resolving an ambiguous remote result.                             |
| `failed`                         | `approved`, `applying`                        | An operator retry: revalidate from `approved`, or re-queue the same idempotent effects. |
| `rejected`, `stale`, `completed` | none                                          | Terminal. A stale or rejected proposal can only be replaced by new content.             |

Only `duplicate`, `consolidate` and `guidance_suggestion` records are advanced past `approved` by the supervisor. Approved `related` and `scope_change` records stay `approved`; they record the decision and notify the affected roles.

## Audit, unread state and limits

- Every creation and transition appends an audit entry with the time, previous and new state, and rationale.
- Every change sets the record unread. `markRead` is idempotent and fenced by the current revision. A read receipt never approves or starts anything.
- Text is stored verbatim, up to 32,000 characters per narrative field and 200 per identifier. Collections hold at most 100 items. The project identity follows the nonempty-string configuration rule, with no extra length limit.
- Every ticket needs exactly one observed revision, and a survivor must be one of the tickets. `related` and `scope_change` proposals may name no tickets if they observe at least one local objective.
- The store keeps observed revisions, never ticket body snapshots.
- List reads return bounded summaries and the 25 most recent audit entries; the full history stays durable.

The store makes no remote calls. Decisions arrive only from the paired console, and remote effects are applied by the supervisor's outbox; see [what approval executes](project-management-decisions.md#what-approval-executes).
