"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Meta's Embedded Signup v4, run in the browser.
 *
 * Two things arrive from Meta, in either order, and both are needed:
 *
 *   - the authorization code, from the `FB.login` callback;
 *   - the WhatsApp Business account id and phone number id, from a
 *     `WA_EMBEDDED_SIGNUP` / `FINISH` message posted by Meta's window.
 *
 * When both are in hand they go to /api/meta/whatsapp, which does everything
 * that needs the app secret. This component never sees a token.
 *
 * The message listener accepts only Meta's own origins. Meta's sample checks
 * `origin.endsWith("facebook.com")`, which `evilfacebook.com` also passes, so
 * the host is compared exactly here.
 */

type FbLoginResponse = { authResponse?: { code?: string } | null };
type Fb = {
  init: (options: Record<string, unknown>) => void;
  login: (callback: (response: FbLoginResponse) => void, options: Record<string, unknown>) => void;
};

declare global {
  interface Window {
    FB?: Fb;
    fbAsyncInit?: () => void;
  }
}

const SDK_SRC = "https://connect.facebook.net/en_US/sdk.js";

function fromMeta(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === "facebook.com" || host.endsWith(".facebook.com");
  } catch {
    return false;
  }
}

const ERRORS: Record<string, string> = {
  invalid_link: "This link has already been used or has expired. Ask us for a new one.",
  throttled: "That was tried several times in a short space of time. Wait a few minutes and try again.",
  not_configured: "Connecting WhatsApp isn't switched on yet.",
  bad_request: "Meta's window didn't send everything we need. Please try again.",
  meta_error: "Meta didn't finish setting up the number. Nothing was saved, and your link still works. Try again in a minute.",
  number_taken:
    "That WhatsApp number is already connected to another practice on healdesk, so it can't be connected here too. Nothing was saved. Disconnect it there first, or reply to your setup email and we'll sort it out.",
};

type Phase = "loading" | "ready" | "working" | "failed";

export function WhatsAppConnect({
  token,
  appId,
  configId,
  graphVersion,
}: {
  token: string;
  appId: string;
  configId: string;
  graphVersion: string;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const code = useRef<string | null>(null);
  const session = useRef<{ wabaId?: string; phoneNumberId?: string }>({});
  const submitted = useRef(false);

  async function submitWhenComplete() {
    const { wabaId, phoneNumberId } = session.current;
    if (submitted.current || !code.current || !wabaId || !phoneNumberId) return;
    submitted.current = true;
    setPhase("working");
    setMessage(null);
    try {
      const res = await fetch("/api/meta/whatsapp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, code: code.current, wabaId, phoneNumberId }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; number?: string | null };
      if (res.ok && body.ok) {
        const done = new URLSearchParams({ channel: "whatsapp", number: body.number ?? "" });
        window.location.assign(`/channels/done?${done.toString()}`);
        return;
      }
      setMessage(ERRORS[body.error ?? ""] ?? ERRORS.meta_error!);
    } catch {
      setMessage(ERRORS.meta_error!);
    }
    // A failed attempt can be retried with a fresh signup from the start.
    submitted.current = false;
    code.current = null;
    session.current = {};
    setPhase("failed");
  }

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!fromMeta(event.origin)) return;
      let data: Record<string, unknown>;
      try {
        data = (typeof event.data === "string" ? JSON.parse(event.data) : event.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!data || data.type !== "WA_EMBEDDED_SIGNUP") return;
      if (data.event === "FINISH") {
        const info = ((data.data as Record<string, unknown> | undefined) ?? data) as Record<string, unknown>;
        session.current = {
          wabaId: typeof info.waba_id === "string" ? info.waba_id : undefined,
          phoneNumberId: typeof info.phone_number_id === "string" ? info.phone_number_id : undefined,
        };
        void submitWhenComplete();
      } else if (data.event === "CANCEL" || data.event === "ERROR") {
        setPhase("ready");
        setMessage("WhatsApp setup was closed before it finished. Nothing was saved, and your link still works.");
      }
    }
    window.addEventListener("message", onMessage);

    window.fbAsyncInit = () => {
      window.FB?.init({ appId, autoLogAppEvents: true, xfbml: false, version: graphVersion });
      setPhase("ready");
    };
    if (window.FB) {
      window.fbAsyncInit();
    } else if (!document.querySelector(`script[src="${SDK_SRC}"]`)) {
      const script = document.createElement("script");
      script.src = SDK_SRC;
      script.async = true;
      script.defer = true;
      script.crossOrigin = "anonymous";
      script.onerror = () => {
        setPhase("failed");
        setMessage("Meta's sign-in couldn't load. Check that nothing in your browser is blocking facebook.com, then reload.");
      };
      document.body.appendChild(script);
    }
    return () => window.removeEventListener("message", onMessage);
    // Runs once: the SDK is a page-level singleton, and the props never change on this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function start() {
    if (!window.FB) return;
    setMessage(null);
    window.FB.login(
      (response) => {
        const c = response?.authResponse?.code;
        if (c) {
          code.current = c;
          void submitWhenComplete();
        } else if (!submitted.current) {
          setPhase("ready");
          setMessage("WhatsApp setup was closed before it finished. Nothing was saved, and your link still works.");
        }
      },
      {
        config_id: configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {} },
      },
    );
  }

  return (
    <div className="mt-8">
      {message ? <p className="mb-4 rounded-lg border border-[color:var(--color-ink)] px-4 py-3 text-[15px]">{message}</p> : null}
      <button
        type="button"
        onClick={start}
        disabled={phase === "loading" || phase === "working"}
        className="w-full rounded-full bg-[color:var(--color-ink)] px-6 py-3.5 text-base font-bold text-white transition-opacity disabled:opacity-50 sm:w-auto"
      >
        {phase === "loading" ? "Loading…" : phase === "working" ? "Connecting your number…" : "Connect WhatsApp"}
      </button>
    </div>
  );
}
