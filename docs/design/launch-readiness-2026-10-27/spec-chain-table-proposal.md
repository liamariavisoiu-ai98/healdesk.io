# Proposed correction: the spec's chain table (not applied)

Lane REG, 27 October 2026. `docs/v1-product-spec.md` is the source of truth and this lane does not edit it. The owner (or a session he tells to) can apply the rows below at "Where the chain is complete, and where it is not" (line 748 at the time of writing).

Evidence for every new word: the owner's reports in chat and `AGENTS.md` ("Last verified / reported evidence": Retell and Anthropic agreements signed, database coverage confirmed); `infra/aws/rds.tf` and `CLAUDE.md` (RDS chosen 7 October, applied 14 October 2026); `docs/policies/aws-hipaa-account.md` (AWS accepted 22 September 2026). None of the three owner-reported links has an executed text or an attestation in the repo, so the table says "owner-reported". The attestations on `/admin/compliance` live in the production database and were not read.

## Row 1: Retell

Old:

```
| Healdesk to Retell | Self-sign the BAA in Retell's click-agreements portal, then set per-agent retention and PII controls | Not yet done |
```

New:

```
| Healdesk to Retell | Self-sign the BAA in Retell's click-agreements portal, then set per-agent retention and PII controls | Signed (owner-reported, not evidenced in the repo); per-agent controls are written by `lib/voice/retell-agent.ts`, which runs only from automatic provisioning, still off |
```

## Row 2: Anthropic

Old:

```
| Healdesk to Anthropic | Primary owner signs and activates | Not yet done |
```

New:

```
| Healdesk to Anthropic | Primary owner signs and activates | Signed (owner-reported, not evidenced in the repo); the owner still confirms the key in AWS is the HIPAA organisation's |
```

## Row 3: the database

Old:

```
| Healdesk to the database provider | Neon on Scale, or AWS RDS under the agreement already held. Sign, then apply the settings it requires | Not yet done |
```

New:

```
| Healdesk to the database provider | AWS RDS for PostgreSQL under the agreement already held (chosen 7 October 2026, applied 14 October 2026, `infra/aws/rds.tf`) | Coverage confirmed (owner-reported, not evidenced in the repo) |
```

## Row 4: AWS (small)

Old:

```
| Healdesk to AWS, where used | Already executed, applies to the designated account and eligible services only | Done |
```

New (adds the date and the open filing):

```
| Healdesk to AWS, where used | Accepted 22 September 2026, applies to the designated account and eligible services only | Done (the Artifact screenshot is still to be filed) |
```

## Optional new row: Slack

Slack is not in the chain because it carries no PHI by design, but a drafted support reply can contain text derived from a clinic's email (CLAUDE.md, owner 26 October 2026). Suggested bullet under "Two gaps stay open by design":

```
- **Slack.** No agreement. It carries ids, counts, dates and closed words, and one exception the owner accepted on 26 October 2026: the reply Healdesk drafted to a clinic's support email, shown to the operator for approval. Never the clinic's own email.
```

Rows not touched: "Clinic to Healdesk" and "Clinic to Google". The sentence "A single missing link means ..." stays true and is the reason the three owner-reported links should be filed as evidence before real patients.
