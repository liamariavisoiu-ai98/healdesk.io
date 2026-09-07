# Opt-out

The footer in [footers.md](./footers.md) tells every recipient to reply `no thanks`. That
sentence is a promise, and this file is how it gets kept. Generated footer text is not
compliance on its own; honouring the reply is.

## What the law actually requires

| Requirement | Statute | What it means here |
|---|---|---|
| Honour the request within **10 business days** | §7704(a)(4)(A) | The clock starts when the reply arrives, not when it is read |
| The mechanism must work for **at least 30 days** after the message was sent | §7704(a)(3)(A) | The mailbox that sent it has to keep receiving for 30 days. Do not retire a mailbox mid-campaign |
| No fee, no login, no information beyond the address and the request | §7704(a)(3)(B) | A reply satisfies this by construction. A link to a preference centre would need care; a reply needs none |
| Suppression binds the **sender**, not the campaign | §7704(a)(4)(A) | One "no thanks" covers all 10 domains and every future campaign, not just the one it landed in |

The last row is the one that catches people. The obligation attaches to healdesk, so a
clinic that opts out of the injectables campaign must not receive the GLP-1 campaign six
weeks later from a different domain.

## Why reply, not a link

A tracked unsubscribe URL on a domain with no sending history is one of the stronger spam
signals a young domain carries, and all ten of these domains are young. A reply is the
opposite signal. §7704(a)(3)(A) names "a functioning return electronic mail address" first
among the acceptable mechanisms, so this is the statute's own default rather than a
workaround.

The cost is that the mechanism is a person, not a database. Hence the rest of this file.

## How Instantly actually handles it

Verified against Instantly's own documentation, September 2026:

**The Global Blocklist is workspace-wide.** It blocks an address or a whole domain from
being imported or contacted, across every campaign and every sending account. That is the
correct home for an opt-out, because it is the only mechanism that matches the scope the
statute requires.

**Automatic blocklisting from a reply phrase is gated to Hyper Growth and above.** So is
automatic blocklisting from a lead status. On lower plans, only leads who use a literal
unsubscribe link are auto-blocked, and there is no link here.

That gate matters more than it looks, because it splits the plan in two:

| | On Hyper Growth or above | Below it |
|---|---|---|
| Reply `no thanks` arrives | Instantly matches the phrase and adds the lead to the Global Blocklist | Instantly marks the lead "uninterested" |
| Suppression across all 10 domains | Automatic | **Not automatic.** Status is shared between campaigns, which usually stops further sends, but a shared status is not a blocklist entry and is not a guarantee |
| What you must do | Spot-check weekly | Add each one to the Global Blocklist by hand, inside 10 business days |

**Decision required:** if the account is not on Hyper Growth, either upgrade it before the
first send, or run the manual procedure below. Both are fine. Doing neither is not, because
"marked uninterested" is a CRM status and the statute asks for suppression.

### If you upgrade

1. Settings > Blocklist > add an automation on reply phrase.
2. Match on more than the scripted phrase. Real replies say "unsubscribe", "remove me",
   "take me off", "stop", "not interested", "no thank you", "please don't contact".
   Someone who means it will not check the footer for the exact wording.
3. Match case-insensitively and on substrings.
4. Still read the replies weekly. A phrase matcher will miss "we're all set, please don't
   follow up on this one", and that is unambiguously an opt-out.

### If you do not

Once every business day, five minutes:

1. Open the unified inbox, filter to replies received since the last check.
2. For anything that reads as a request to stop, whatever the wording: copy the address.
3. Settings > Blocklist > add the address. Not the status. The blocklist.
4. If the reply says "nobody here" or "wrong contact" rather than "stop", block the
   **domain**, not the address, since the next contact at that clinic is the same clinic.
5. Log the date and the address in `run-log.md`. The log is what shows a pattern of
   honouring requests if it is ever asked for.

Daily rather than every tenth day, because 10 business days is the deadline, not the
target, and a missed week is how a deadline is blown.

## The one that is not automatable

A reply that says "who is this?" or "how did you get my email?" is not an opt-out and
should not be blocked. A reply that says "please remove us from your list" is, even if it
is followed by a question. When it is genuinely ambiguous, block. The cost of blocking a
lead who did not ask is one lost prospect out of roughly 1,700. The cost of the reverse is
a §7704 violation with a per-message penalty attached.

## What is deliberately not here

Nothing in this repo enforces any of the above. There is no send path in the codebase, no
suppression table, and no reply ingestion, because the campaign runs entirely inside
Instantly. If sending ever moves in-house, this file becomes a specification rather than a
procedure, and the suppression list becomes a table with a unique index on the address.
