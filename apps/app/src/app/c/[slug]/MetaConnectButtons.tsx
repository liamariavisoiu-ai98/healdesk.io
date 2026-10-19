import type { MetaConnectView } from "@/lib/meta/reconnect";

/**
 * The portal's Meta buttons, in set-up's channels step and in Settings →
 * Channels: Connect with Facebook (Messenger and Instagram, one login),
 * Connect WhatsApp (Meta's embedded sign-up), and, when Meta has dropped a
 * login, Reconnect in their place, with a plain sentence saying why
 * (lib/meta/reconnect.ts). A clinic never pastes a key: every connection is a
 * button (CLAUDE.md, "The clinic portal").
 *
 * A server component without state: the Facebook button is a form post to
 * /api/meta/login, WhatsApp a link to the sign-up page, so both work before
 * any script has loaded. `from` tells each where to return to.
 */

const BUTTON = "bg-ink min-h-11 inline-flex items-center rounded-full px-5 text-sm font-bold text-white";
const QUIET_BUTTON = "border-line min-h-11 inline-flex items-center rounded-full border px-5 text-sm font-semibold";

export function MetaConnectButtons({
  slug,
  from,
  view,
  showWhatsApp = true,
}: {
  slug: string;
  from: "setup" | "settings";
  view: MetaConnectView;
  /** Hidden when the page already lists WhatsApp by itself. */
  showWhatsApp?: boolean;
}) {
  return (
    <div className="mt-3 grid gap-4 text-sm">
      <FacebookConnect slug={slug} from={from} view={view} />
      {showWhatsApp ? <WhatsAppConnectLink slug={slug} from={from} view={view} /> : null}
    </div>
  );
}

function FacebookConnect({ slug, from, view }: { slug: string; from: "setup" | "settings"; view: MetaConnectView }) {
  const { state, names } = view.facebook;
  if (!view.available.facebook) {
    return state === "none" || state === "needs_reconnect" ? (
      <p className="text-muted">
        {state === "needs_reconnect" ? "Facebook dropped the connection. " : ""}Email hello@healdesk.io and
        we&rsquo;ll connect Facebook and Instagram with you.
      </p>
    ) : (
      <p>Connected: {names.join(", ")}.</p>
    );
  }
  if (state === "connected" && from === "setup") return <p>Connected: {names.join(", ")}.</p>;
  const label = state === "none" ? "Connect with Facebook" : "Reconnect Facebook";
  return (
    <form method="post" action="/api/meta/login" className="grid gap-2">
      <input type="hidden" name="clinic" value={slug} />
      <input type="hidden" name="from" value={from} />
      {state === "connected" ? (
        <p>
          Connected: {names.join(", ")}. Sign in again to change the Page or to refresh the connection.
        </p>
      ) : state === "needs_reconnect" ? (
        <p className="text-red-800">
          Facebook dropped the connection to {names.join(" and ")}, so AYA can&rsquo;t reply there. Sign in with
          Facebook again to bring it back.
        </p>
      ) : (
        <p className="text-muted">
          Sign in with Facebook and choose your practice&rsquo;s Page. An Instagram professional account linked to
          that Page connects at the same time. AYA is designed to reply only to people who message you, within 24
          hours of their message, and to move anyone describing a medical condition to a call.
        </p>
      )}
      <p>
        <button type="submit" className={state === "connected" ? QUIET_BUTTON : BUTTON}>
          {label}
        </button>
      </p>
    </form>
  );
}

function WhatsAppConnectLink({ slug, from, view }: { slug: string; from: "setup" | "settings"; view: MetaConnectView }) {
  const { state } = view.whatsapp;
  if (!view.available.whatsapp) {
    return state === "connected" ? (
      <p>Connected: WhatsApp.</p>
    ) : (
      <p className="text-muted">
        {state === "needs_reconnect" ? "Meta dropped the WhatsApp connection. " : ""}Email hello@healdesk.io and
        we&rsquo;ll connect WhatsApp with you.
      </p>
    );
  }
  if (state === "connected" && from === "setup") return <p>Connected: WhatsApp.</p>;
  const href = `/c/${slug}/whatsapp?from=${from}`;
  return (
    <div className="grid gap-2">
      {state === "connected" ? (
        <p>Connected: WhatsApp.</p>
      ) : state === "needs_reconnect" ? (
        <p className="text-red-800">
          Meta dropped the WhatsApp connection, so AYA can&rsquo;t reply there. Sign up again to bring it back.
        </p>
      ) : (
        <p className="text-muted">
          WhatsApp connects through a short sign-up in a window from Meta, where you also add a card to your WhatsApp
          account: Meta bills you directly for WhatsApp messages.
        </p>
      )}
      <p>
        <a href={href} className={state === "connected" ? QUIET_BUTTON : BUTTON}>
          {state === "none" ? "Connect WhatsApp" : "Reconnect WhatsApp"}
        </a>
      </p>
    </div>
  );
}
