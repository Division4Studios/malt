# Security and privacy

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/Division4Studios/malt/security/advisories/new). Do not publish a reproduction with live secrets or attach a `.malt` archive. See the repository Security tab for the current policy.

```mermaid
flowchart TD
  Report[Sanitized private report] --> Triage[Confirm impact and affected revision]
  Triage --> Fix[Develop and independently review fix]
  Triage -->|Exposed credential| Revoke[Revoke and rotate immediately]
  Revoke --> Fix
  Fix --> Release[Verify release and advisory]
  Release --> Disclosure[Coordinated disclosure]
```

- Keep `.malt`, `.mlt`, provider credential homes, `.env` and private keys out of source, images, exports and public logs.
- Pair only with the local daemon you started. Do not expose its control ports publicly or put pairing codes in URLs.
- Inspect permissions and project commands before dispatch. Developer full-access mode permits native execution under your OS account.
- Scan current files and all reachable Git history before release. Ignoring a file does not remove a historical leak; revocation takes priority.
- Review third-party skills/tools for license, provenance, compatibility and security. Human adoption is for an exact revision; downloaded instructions are not authority.

The project uses the OpenSSF Baseline and best-practices criteria as review frameworks. It has not claimed a badge, penetration-test certification or complete absence of defects. See the repository's audit/readiness document once the corresponding public-readiness PR is merged.
