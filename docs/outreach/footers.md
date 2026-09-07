# Campaign footers

Generated from `packages/leadgen/src/enrich/footer.ts`. Do not hand-edit: change the
module and regenerate, so the postal address and the opt-out phrase cannot drift apart
across 30 mailboxes.

## What each line is doing

| Line | CAN-SPAM requirement |
|---|---|
| `<name>, healdesk` | identifies the sender |
| the street address | §7704(a)(5)(A)(iii) valid physical postal address |
| `a cold sales note` | §7704(a)(5)(A)(i) identification as a solicitation |
| `reply "no thanks"` | §7704(a)(5)(A)(ii) notice of the opportunity to decline |

## The one-template version (preferred)

Instantly exposes the sending mailbox's own name as a variable, so all 30 mailboxes can
share one template. Confirm the exact variable name in your Instantly account before
relying on it, and send yourself a test from two different mailboxes to check it renders
the right name rather than a blank.

```
{{sendingAccountFirstName}} {{sendingAccountLastName}}, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

Touch 2 onward, the only change is the first two words:

```
Still a sales note, so reply "no thanks" if you would rather not get another.
```

## The literal version, per mailbox

Use these if the variable does not resolve. Touch 1 shown; for later touches swap
`A cold sales note` for `Still a sales note`.

### sarah@gethealdesk.com  (Google)

```
Sarah Whitfield, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### daniel.reyes@gethealdesk.com  (Google)

```
Daniel Reyes, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### megan@gethealdesk.com  (Google)

```
Megan Callahan, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### peter@tryhealdesk.com  (Google)

```
Peter Lindqvist, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### alyssa.moreau@tryhealdesk.com  (Google)

```
Alyssa Moreau, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### jordan@tryhealdesk.com  (Google)

```
Jordan Ashby, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### nicole@usehealdesk.com  (Google)

```
Nicole Vandermeer, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### marcus.delaney@usehealdesk.com  (Google)

```
Marcus Delaney, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### rachel@usehealdesk.com  (Google)

```
Rachel Okonkwo, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### trevor@healdeskapp.com  (Google)

```
Trevor Blackwood, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### priya.raghavan@healdeskapp.com  (Google)

```
Priya Raghavan, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### colin@healdeskapp.com  (Google)

```
Colin Mercer, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### danielle@joinhealdesk.com  (Google)

```
Danielle Fontaine, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### andre.kowalski@joinhealdesk.com  (Google)

```
Andre Kowalski, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### bethany@joinhealdesk.com  (Google)

```
Bethany Sinclair, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### ethan@healdeskpro.com  (Microsoft)

```
Ethan Bergstrom, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### camille.duarte@healdeskpro.com  (Microsoft)

```
Camille Duarte, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### nathan@healdeskpro.com  (Microsoft)

```
Nathan Holloway, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### simone@healdeskusa.com  (Microsoft)

```
Simone Achterberg, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### gregory.tanaka@healdeskusa.com  (Microsoft)

```
Gregory Tanaka, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### vanessa@healdeskusa.com  (Microsoft)

```
Vanessa Kirkland, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### julian@healdeskteam.com  (Microsoft)

```
Julian Abernathy, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### kendra.solberg@healdeskteam.com  (Microsoft)

```
Kendra Solberg, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### miles@healdeskteam.com  (Microsoft)

```
Miles Pettigrew, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### laura@healdeskco.com  (Microsoft)

```
Laura Castellano, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### dominic.fairbanks@healdeskco.com  (Microsoft)

```
Dominic Fairbanks, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### anika@healdeskco.com  (Microsoft)

```
Anika Bhattacharya, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### russell@healdeskhub.com  (Microsoft)

```
Russell Thornbury, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### elena.vasquez@healdeskhub.com  (Microsoft)

```
Elena Vasquez, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```

### grant@healdeskhub.com  (Microsoft)

```
Grant Ellsworth, healdesk
800 N King St, Suite 304-1426, Wilmington, DE 19801

A cold sales note, so reply "no thanks" if you would rather not get another.
```
