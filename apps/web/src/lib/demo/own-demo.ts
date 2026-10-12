import { postInternalAlert } from "@/lib/demo/alert";
import { runDemoBuild } from "@/lib/demo/build";
import { demoUrl, getDemoSession, type DemoSession } from "@/lib/demo/sessions";
import { sendSafely } from "@/lib/email";
import { site } from "@/lib/site";

/**
 * A demo a visitor asked for on the homepage, "See it in your own branding"
 * (components/OwnBranding.tsx, api/own-demo), built by the same pipeline as
 * the operator's (lib/demo/build.ts) and watched by the team.
 *
 * The owner's brief of 9 October 2026 asked for two things behind the form:
 * the whole automation that built Peachy's demo, and an email to
 * hello@healdesk.io for every request. So the build is runDemoBuild with the
 * link emailed to the visitor when it is ready, exactly as when an operator
 * ticks "send the link", and the team hears about each request when it
 * arrives, and again only if something needs a person: the build failed, or
 * the visitor's email could not be sent. A request nobody looks at is a lead
 * nobody follows up.
 *
 * A demo that has been built is then audited before it reaches anyone
 * (lib/demo/audit.ts), and a visitor who typed a stranger's site is as likely
 * to be held as any: the link goes out only when it passes. A held demo is
 * not a failed one. It is built, the request is on file with its email, and an
 * operator releasing it from the console sends the link, so the team's second
 * message says so, rather than calling it a failure and sending them to
 * rebuild what only needs reading.
 *
 * Every message to the team replies to the visitor, so answering one is
 * writing to them. Business contact data only: a website, an address, a
 * link. Never anything a patient said, which this side never holds.
 */

/** The console page where demos are rebuilt and their links re-sent. */
export function demoConsoleUrl(): string {
  return `${site.url.replace(/\/$/, "")}/admin/demos`;
}

function hostOf(session: Pick<DemoSession, "websiteUrl">): string {
  try {
    return new URL(session.websiteUrl).hostname.replace(/^www\./, "");
  } catch {
    return session.websiteUrl;
  }
}

/**
 * A stand-in name from the domain until the site has been read:
 * "peachy-studio.com" is "Peachy Studio". The demo shows the name the site
 * gives itself once it is built (displayName in lib/demo/sessions.ts), so a
 * visitor never sees this one; it is what the Google listing is searched by,
 * beside the domain, and what the console lists while the build runs.
 */
export function provisionalClinicName(website: URL): string {
  const label = website.hostname.replace(/^www\./, "").split(".")[0] ?? "";
  const words = label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  const name = words.join(" ");
  return name.length >= 2 ? name : website.hostname;
}

/** To hello@, as the request arrives. Exported for the test. */
export function requestNotice(session: DemoSession): { subject: string; text: string } {
  return {
    subject: `Demo request: ${hostOf(session)}`,
    text: [
      "Someone asked for their own demo on the homepage.",
      "",
      `Website: ${session.websiteUrl}`,
      `Email: ${session.leadEmail ?? "none given"}`,
      `Demo link: ${demoUrl(session.slug)}`,
      `Console: ${demoConsoleUrl()}`,
      "",
      "It is being built now, and the link goes to them by email when it is ready. You will hear about this one again only if the build fails, the audit holds it for review, or that email cannot be sent.",
      "",
      "Reply to this message to write to them.",
    ].join("\n"),
  };
}

/** To hello@, when a person has to finish what the automation could not. Exported for the test. */
export function problemNotice(session: DemoSession, problem: "failed" | "held" | "unsent"): { subject: string; text: string } {
  const host = hostOf(session);
  const who = session.leadEmail ?? "the visitor";
  if (problem === "held") {
    const score = typeof session.auditScore === "number" ? `Audit score: ${session.auditScore}/100.` : null;
    return {
      subject: `Demo held for review: ${host}`,
      text: [
        `The demo for ${session.websiteUrl} was built, but its audit held it back, so ${who} has not been sent anything. Their page says the team is putting the finishing touches on it.`,
        "",
        ...(score ? [score] : []),
        ...(session.buildNote ? [session.buildNote] : []),
        ...(score || session.buildNote ? [""] : []),
        `Read what the audit found in the console. Releasing the demo there sends the link to them, because their request is on file; rebuilding it audits it again:`,
        demoConsoleUrl(),
        "",
        "Reply to this message to write to them.",
      ].join("\n"),
    };
  }
  if (problem === "failed") {
    return {
      subject: `Demo build failed: ${host}`,
      text: [
        `The demo requested for ${session.websiteUrl} did not build: ${session.buildNote ?? "no reason was recorded"}`,
        "",
        `${who} has not been sent a link. Their page says the team is putting the finishing touches on it. Rebuild it or finish it by hand in the console, and send the link from there:`,
        demoConsoleUrl(),
        "",
        "Reply to this message to write to them.",
      ].join("\n"),
    };
  }
  return {
    subject: `Demo ready, email not sent: ${host}`,
    text: [
      `The demo for ${session.websiteUrl} is ready, but the email with its link to ${who} could not be sent. Send it from the console:`,
      demoConsoleUrl(),
      "",
      `Demo link: ${demoUrl(session.slug)}`,
      "",
      "Reply to this message to write to them.",
    ].join("\n"),
  };
}

async function tellTheTeam(session: DemoSession, message: { subject: string; text: string }, kind: string): Promise<void> {
  const result = await sendSafely({
    to: site.email,
    subject: message.subject,
    text: message.text,
    ...(session.leadEmail ? { replyTo: session.leadEmail } : {}),
    tag: `own-demo-${kind}`,
    // Row ids, never an address: Resend keeps the key in its logs.
    idempotencyKey: `own-demo-${kind}:${session.id}`,
  });
  if (result.status !== "sent") {
    console.error("[healdesk] own-demo notice to the team not sent", { slug: session.slug, kind, ...result });
  }
}

/**
 * Tell the team, build, and tell them again if a person is needed. Runs
 * after the response (`after()` in api/own-demo), so it never throws: a
 * failure here could only ever reach a log, and runDemoBuild already ends
 * every failure as a `failed` row with its reason.
 */
export async function buildSelfServeDemo(session: DemoSession): Promise<void> {
  try {
    await tellTheTeam(session, requestNotice(session), "request");
    await postInternalAlert(`Demo requested on the homepage for ${hostOf(session)}. ${demoConsoleUrl()}`);

    const built = await runDemoBuild(session.slug, { sendEmail: true });
    // Re-read: the link's email stamps the row after the build returns it.
    const latest = (await getDemoSession(session.slug, { fresh: true }).catch(() => null)) ?? built;
    if (latest?.status === "held") {
      // The build raised its own alert for a held demo (lib/demo/build.ts); one more would only repeat it.
      await tellTheTeam(latest, problemNotice(latest, "held"), "held");
    } else if (!latest || latest.status !== "ready") {
      const failed = latest ?? session;
      await tellTheTeam(failed, problemNotice(failed, "failed"), "failed");
      await postInternalAlert(`Homepage demo for ${hostOf(failed)} failed to build. ${demoConsoleUrl()}`);
    } else if (!latest.emailSentAt) {
      await tellTheTeam(latest, problemNotice(latest, "unsent"), "unsent");
    }
  } catch (error) {
    console.error("[healdesk] self-serve demo follow-through failed", {
      slug: session.slug,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
