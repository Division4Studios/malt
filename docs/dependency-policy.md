# Dependency upgrades

MALT targets Node.js 24 LTS in native setup, CI and containers. Keep Node type declarations on the same major. Container updates retain a verified immutable digest. Runtime major upgrades require an explicit compatibility migration; the ended Node 25 release line is not an upgrade target.

TypeScript upgrades must satisfy the installed typescript-eslint peer range. The current tooling supports TypeScript 6.0, not 7. Do not use forced installs or ignore peer conflicts to admit an incompatible compiler. Dependabot continues patch/minor updates; compiler and Node type major upgrades require deliberate migration.
