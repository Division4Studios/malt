# Duplicate detection

`detectDuplicates` is a pure classifier over supplied request, issue, objective and operation snapshots. It performs no network access, persistence or queueing. A match requires concrete behavioral, acceptance, reproduction, component or dependency evidence; titles do not establish duplicates. Contradictory evidence is retained. Closed issues remain related references, and comparably strong open duplicates have no proposed survivor.

An exact unresolved operation identity takes precedence over classification: the result contains reusable operations, no matches, no survivor and no ambiguity. This also applies when the interrupted operation has no known issue or several issues otherwise match. Resolved operations and different identities do not suppress classification.

Shared tokens and ranking keys use locale-independent UTF-16 ordinal ordering. Free text is reduced to bounded normalized tokens; echoed identities are bounded and sanitized. Consumers must still render returned data safely. This module does not itself approve, execute or persist a project-management decision.
