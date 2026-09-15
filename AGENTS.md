# Agent instructions

This repository's working instructions live in **[CLAUDE.md](./CLAUDE.md)**.
Read it before adding any surface — it is short, and the first section decides
where new code is allowed to go.

The one rule to carry even if you read nothing else:

> **`apps/web` handles NO patient data and has no database client.**
> **`apps/app` handles PHI and must stay portable off Vercel.**
> If it needs the database, it goes in `apps/app`.

`docs/hipaa-compliance.md` is authoritative for what counts as PHI.
