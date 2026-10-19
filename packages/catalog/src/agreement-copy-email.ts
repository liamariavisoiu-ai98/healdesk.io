import { agreementKindOfVersion, DPA_VERSION_PREFIX, type AgreementKind } from "./agreement-kind";
import { emailHtmlDocument } from "./email-html";
import { SENDER_IDENTITY } from "./sender-identity";

/**
 * The words of the email that carries the signer's copy of the agreement,
 * and the name of the file attached to it.
 *
 * Pure, and in the catalog since 14 October 2026, because the copy now goes
 * from both apps: apps/web mails it at signature, through Resend
 * (apps/web/src/app/api/agreement/route.ts), now that the signature is taken
 * there (docs/design/checkout-records-on-vercel-2026-10-14.md), and apps/app
 * mails it again when an operator resends it, through SES
 * (apps/app/src/lib/email/agreement-copy.ts). One rendering, so the two
 * cannot word the same document differently.
 *
 * No PHI, and no credential: the body is fixed copy plus four facts, the
 * practice's name, who signed, the template version and when, and the
 * document hash. The acceptance id is deliberately NOT in it: a database key
 * mailed to an unverified address is where entitlement bugs come from, and
 * the hash names the document for a human without opening anything.
 *
 * Since 19 October 2026 it ends with the footer every healdesk email carries
 * (Annex X1.9): why it came, that replies reach the team and should leave out
 * patient details, and the sender's identity with the US mailing address. Its
 * subject is held to 70 characters (X4), the practice's name cut to fit, and
 * its HTML is the one-column, system-font document of email-html.ts, with no
 * link in it: the address to write to is printed, not a mailto: link, since
 * an email links only to a public https page of ours (X1.6).
 */

const CONTACT = SENDER_IDENTITY.replyTo;

/** The most a subject may be (Annex X4); the inbox cuts a longer one mid-word. */
export const AGREEMENT_COPY_SUBJECT_MAX = 70;

/**
 * Why the reader gets this email, the first line of its footer (Annex X1.9).
 * The address is the one typed beside the signature, which nobody confirmed.
 */
export const AGREEMENT_COPY_REASON =
  "You're getting this because this address was given for the signatory when an agreement with healdesk was signed.";

/** The footer's reply line (X1.9), as every healdesk email words it, so hello@ stays free of patient details. */
const REPLY_LINE = "Replies reach the healdesk team. Please leave out patient details.";

/**
 * The footer, as lines: why the email came, who reads a reply, and who sent
 * it (the operating entity and the US mailing address, as on the site). No
 * opt-out: this is a transactional message, the copy of a contract the reader
 * signed, sent once.
 */
export function agreementCopyFooter(): readonly string[] {
  return [
    AGREEMENT_COPY_REASON,
    REPLY_LINE,
    SENDER_IDENTITY.entityLine,
    `${SENDER_IDENTITY.postalAddressLabel}: ${SENDER_IDENTITY.postalAddress}`,
  ];
}

/** The practice's name cut, with an ellipsis, to fit `room` characters of a subject. */
function nameForSubject(name: string, room: number): string {
  const clean = name.replace(/\s+/g, " ").trim();
  const chars = [...clean];
  return chars.length <= room ? clean : `${chars.slice(0, Math.max(1, room - 1)).join("").trimEnd()}…`;
}

/**
 * The words that name the document, by kind. The BAA's are the strings this
 * email has always carried; the DPA's say what a practice outside HIPAA would
 * be asked for, and never call its clients patients.
 */
const DOCUMENT_WORDS: Readonly<
  Record<AgreementKind, { noun: string; keepText: readonly string[]; keepHtml: string }>
> = {
  baa: {
    noun: "business associate agreement",
    keepText: [
      `Please keep it. This is a contract with two parties to it, and healdesk`,
      `should not be the only one holding a copy — if your practice is ever asked`,
      `to produce its business associate agreements, this is the file.`,
    ],
    keepHtml:
      `<p><strong>Please keep it.</strong> This is a contract with two parties to it, ` +
      `and healdesk should not be the only one holding a copy — if your practice is ` +
      `ever asked to produce its business associate agreements, this is the file.</p>`,
  },
  dpa: {
    noun: "data protection agreement",
    keepText: [
      `Please keep it. This is a contract with two parties to it, and healdesk`,
      `should not be the only one holding a copy — if your practice is ever asked`,
      `what it agreed with healdesk about its clients' information, this is the`,
      `file.`,
    ],
    keepHtml:
      `<p><strong>Please keep it.</strong> This is a contract with two parties to it, ` +
      `and healdesk should not be the only one holding a copy — if your practice is ` +
      `ever asked what it agreed with healdesk about its clients' information, this is ` +
      `the file.</p>`,
  },
};

export function renderAgreementCopy(copy: {
  /**
   * Who signed, as typed. Null leaves the name out ("Signed on …"): apps/app
   * does that for a name its payload allowlist will not put in an email.
   */
  signatoryName: string | null;
  clinicName: string;
  version: string;
  documentHash: string;
  acceptedAt: Date;
}): { subject: string; text: string; html: string } {
  const when = formatSignedAt(copy.acceptedAt);
  const words = DOCUMENT_WORDS[agreementKindOfVersion(copy.version)];
  const opening = `Your signed ${words.noun} for `;
  const subject = `${opening}${nameForSubject(copy.clinicName, AGREEMENT_COPY_SUBJECT_MAX - opening.length)}`;
  const signed = copy.signatoryName ? `Signed by ${copy.signatoryName} on ${when}.` : `Signed on ${when}.`;
  const footer = agreementCopyFooter();

  const text = [
    `Attached, as a PDF, is the ${words.noun} you signed for`,
    `${copy.clinicName}. It is the document we recorded at signature, word for`,
    `word — the same text that was on your screen.`,
    ``,
    signed,
    `Agreement version ${copy.version}.`,
    ``,
    ...words.keepText,
    ``,
    `Our reference for it is the SHA-256 of the agreement text:`,
    copy.documentHash,
    ``,
    `If you need another copy, or this reached the wrong address, email`,
    `${CONTACT} and a person will deal with it.`,
    ``,
    `If you did not sign anything, someone has typed this address by mistake.`,
    `You can ignore this email; if you would rather tell us, ${CONTACT}`,
    `reaches a person.`,
    ``,
    `--`,
    ...footer,
  ].join("\n");

  const body = [
    `<p>Attached, as a PDF, is the ${words.noun} you signed for `,
    `<strong>${escapeHtml(copy.clinicName)}</strong>. It is the document we recorded `,
    `at signature, word for word — the same text that was on your screen.</p>`,
    `<p>${escapeHtml(signed)}<br>`,
    `Agreement version ${escapeHtml(copy.version)}.</p>`,
    words.keepHtml,
    `<p>Our reference for it is the SHA-256 of the agreement text:<br>`,
    `<code style="word-break:break-all">${escapeHtml(copy.documentHash)}</code></p>`,
    // The address as text, not a mailto: link. An email links only to a
    // public https page of ours (X1.6), and a reply already reaches it.
    `<p>If you need another copy, or this reached the wrong address, email `,
    `${CONTACT} and a person will deal with it.</p>`,
    `<p>If you did not sign anything, someone has typed this address by mistake. `,
    `You can ignore this email; if you would rather tell us, `,
    `${CONTACT} reaches a person.</p>`,
    `<hr style="border:0;border-top:1px solid #d0d7de;margin:24px 0 12px;">`,
    ...footer.map(
      (line) =>
        `<p class="hd-muted" style="margin:0 0 6px;color:#57606a;font-size:13px;">${escapeHtml(line)}</p>`,
    ),
  ].join("");
  const html = emailHtmlDocument(subject, body);

  return { subject, text, html };
}

/**
 * The attachment's name when the renderer's own is not given: the kind spelled
 * out, the version, and the UTC day of the signature.
 */
export function agreementCopyFilename(acceptance: { version: string; acceptedAt: Date }): string {
  const at = acceptance.acceptedAt;
  const day = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  if (agreementKindOfVersion(acceptance.version) === "dpa") {
    // The stem names the kind; the version's own namespace is not repeated.
    const version = acceptance.version.slice(DPA_VERSION_PREFIX.length);
    return `healdesk-data-protection-agreement-${version}-${day}.pdf`;
  }
  return `healdesk-business-associate-agreement-${acceptance.version}-${day}.pdf`;
}

/**
 * UTC, spelled out, for the reason connect-link.ts spells out an expiry: the
 * signer's own timezone is not knowable from here, and this date is a fact
 * about a contract. In words rather than digits so it cannot be read as the
 * other way round, and assembled from UTC parts rather than toLocale* so the
 * string does not depend on which ICU data the container happens to ship.
 */
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

function formatSignedAt(at: Date): string {
  return (
    `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()} ` +
    `at ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`
  );
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
