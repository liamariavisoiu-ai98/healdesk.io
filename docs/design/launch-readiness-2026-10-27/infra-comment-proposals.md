# Proposed infra comment fixes for the next infra batch (not applied)

Lane REG, 27 October 2026. `infra/aws/production.tfvars` is not edited by this lane. These are comment-only changes: no value changes, so a plan should show nothing to change.

## `voice_desired` comment (lines 55 to 66 of `infra/aws/production.tfvars`)

The comment says `voice_desired = 2` survives losing a task mid-call, but the value set two lines below it is 1. With one task, losing it (a host failure, an out-of-memory kill) drops every call on it, as `infra/aws/README.md` says around line 1210; `voice_desired = 2` adds about $8.51 a month (README line 1134).

Old:

```
# voice_desired = 2 survives losing a task mid-call. One full vCPU and 2 GB
```

New:

```
# voice_desired is 1: losing the one task mid-call drops every call on it (the
# fallback to the clinic's direct line is Retell's); 2 would limit that to the
# calls on the lost task, for about $8.51 a month more (README, Costs). One full vCPU and 2 GB
```

Whether to set the value to 2 before real calls is the owner's decision (status.md section 7 recommends it); that would be a separate change and a plan.
