# Sample Instantly files

Four made-up clinics, built with `buildInstantlyFiles` (`packages/leadgen/src/enrich/instantly.ts`)
to show the format the real files take. They contain no real clinic, contact or lead, and must
never be uploaded to Instantly or sent.

The real files come from `npm run enrich -w @healdesk/leadgen`, which writes
`instantly-main.csv` and `instantly-low-enrichment.csv` next to `all-leads.csv` in
`packages/leadgen/data/` (gitignored). See `../sequences.md`, "Uploading to Instantly".

- `SAMPLE-instantly-main.csv`: three clinics with measured hours and a service.
- `SAMPLE-instantly-low-enrichment.csv`: one clinic with no hours and no service found.
- `SAMPLE-instantly-leads.xlsx`: both of the above as two tabs.
