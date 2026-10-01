# Agent instructions

This repository's working instructions live in **[CLAUDE.md](./CLAUDE.md)**.
Read it before adding any surface — it is short, and the first section decides
where new code is allowed to go.

What the product is and does is decided by
**[docs/v1-product-spec.md](./docs/v1-product-spec.md)**. It is an export: never
edit it; change the source doc and re-export. The live task list is that doc's
"Launch plan" tab. Where any other doc disagrees with the spec about what the
product does, the spec wins.

The one rule to carry even if you read nothing else:

> **`apps/web` handles NO patient data and has no database client.**
> **`apps/app` handles PHI and must stay portable off Vercel.**
> If it needs the database, it goes in `apps/app`.
> Clinics DO sign in, to the clinic portal in `apps/app`. `/admin` is ours.

`docs/hipaa-compliance.md` is authoritative for what counts as PHI.
