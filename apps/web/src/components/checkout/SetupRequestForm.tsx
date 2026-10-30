"use client";

import { type FormEvent, useState } from "react";

import { track } from "@/lib/analytics";
import { leadIdFromUrl } from "@/lib/attribution";
import { type ChannelId, SETUP_CHANNELS } from "@/lib/setup-channels";
import { site } from "@/lib/site";

import { PrimaryButton, StepShell } from "./StepShell";

/**
 * "Tell us about your clinic": what the call to action opens while the
 * purchase is by invitation (lib/checkout-mode.ts).
 *
 * One screen, five questions, and a promise with a date on it. A person reads
 * every request and replies with the next step; the purchase itself opens
 * from the setup link that reply carries. Nothing on this screen says why the
 * purchase works that way: to the clinic it is simply how setup starts.
 *
 * The email asked for is the clinic's, not the person's, because the plan
 * gives each clinic one address for everything: sign-in, billing and every
 * notification. A shared inbox is fine, and the hint says so, because "work
 * email" makes owners type a personal address that leaves with them.
 */

/** Why a setup link sent the visitor here instead of to the purchase. */
export type LinkNotice = "invalid" | "expired" | "replaced" | "used";

export const LINK_NOTICES: Record<LinkNotice, string> = {
  invalid: "That setup link isn't valid. Send the form below and we'll reply with a new one.",
  expired: "Your setup link has expired. Send the form below and we'll reply with a new one.",
  replaced: "That setup link was replaced by a newer one. Use the link in our latest email, or send the form below.",
  used: `That setup link has already been used to complete a purchase. Questions? Email ${site.email}.`,
};

type Fields = {
  name: string;
  clinicName: string;
  website: string;
  noWebsite: boolean;
  email: string;
  channels: ChannelId[];
  /** The honeypot. No person sees it, so anything in it is a bot. */
  middleName: string;
};

export function SetupRequestForm({
  replyBy,
  notice,
  initialEmail = "",
  initialClinicName = "",
  initialWebsite = "",
  onClose,
}: {
  /** "Tuesday 7 October", worked out on the server so it can't disagree with the email. */
  replyBy: string;
  notice?: LinkNotice | null;
  /** From the demo gate, when the visitor already gave one. */
  initialEmail?: string;
  /** From the visitor's own demo (lib/demo/checkout.ts), so it is not asked for twice. */
  initialClinicName?: string;
  initialWebsite?: string;
  onClose?: () => void;
}) {
  const [fields, setFields] = useState<Fields>({
    name: "",
    clinicName: initialClinicName,
    website: initialWebsite,
    noWebsite: false,
    email: initialEmail,
    channels: [],
    middleName: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  const [sent, setSent] = useState<{ email: string; replyBy: string } | null>(null);

  const set = <K extends keyof Fields>(key: K, value: Fields[K]) =>
    setFields((f) => ({ ...f, [key]: value }));

  const toggleChannel = (id: ChannelId) =>
    setFields((f) => ({
      ...f,
      channels: f.channels.includes(id) ? f.channels.filter((c) => c !== id) : [...f.channels, id],
    }));

  const ready =
    fields.name.trim().length > 0 &&
    fields.clinicName.trim().length > 1 &&
    (fields.noWebsite || fields.website.trim().length > 3) &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(fields.email.trim()) &&
    fields.channels.length > 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || submitting) return;
    setSubmitting(true);
    setError(null);
    setErrorField(null);
    try {
      const response = await fetch("/api/setup-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: fields.name.trim(),
          clinicName: fields.clinicName.trim(),
          website: fields.noWebsite ? undefined : fields.website.trim(),
          noWebsite: fields.noWebsite,
          email: fields.email.trim(),
          channels: fields.channels,
          middleName: fields.middleName,
          // The Day 7 email's link carries the lead id; the server checks it.
          leadId: leadIdFromUrl(),
        }),
      });
      const data = (await response.json().catch(() => null)) as {
        ok?: boolean;
        replyBy?: string;
        error?: string;
        field?: string;
      } | null;
      if (!response.ok || !data?.ok) {
        setError(data?.error ?? `Something went wrong. Email ${site.email} and we'll take it from there.`);
        setErrorField(data?.field ?? null);
        return;
      }
      track("setup_requested", { has_website: !fields.noWebsite });
      setSent({ email: fields.email.trim(), replyBy: data.replyBy ?? replyBy });
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <div className="mx-auto w-full max-w-[560px] text-center">
        <div className="bg-mint text-ink mx-auto grid size-14 place-items-center rounded-full text-2xl">
          ✓
        </div>
        <h1 className="font-display mt-6 text-[clamp(var(--text-3xl),4.32vw,var(--text-4xl))] leading-tight font-medium tracking-[-0.024em]">
          Thanks.
        </h1>
        <p className="text-muted mt-4 text-lg font-medium" role="status">
          We&apos;ll reply to <strong className="text-ink">{sent.email}</strong> by{" "}
          {sent.replyBy} with your next step.
        </p>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="border-line-strong text-ink hover:border-ink mt-8 rounded-full border-[1.5px] px-6 py-3 text-sm font-bold transition-colors"
          >
            Close
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <StepShell
      eyebrow={site.cta.primary.label}
      title="Tell us about your clinic"
      subtitle={`We'll reply by ${replyBy} with your next step.`}
      onClose={onClose}
    >
      {notice ? (
        <p className="border-red/30 bg-red/[0.06] mb-6 rounded-sm border px-4 py-3 text-sm font-semibold">
          {LINK_NOTICES[notice]}
        </p>
      ) : null}

      <form className="grid gap-4" onSubmit={(event) => void submit(event)} noValidate>
        <TextField
          label="Your name"
          value={fields.name}
          onChange={(v) => set("name", v)}
          placeholder="Alex Chen"
          autoComplete="name"
          invalid={errorField === "name"}
        />
        <TextField
          label="Clinic name"
          value={fields.clinicName}
          onChange={(v) => set("clinicName", v)}
          placeholder="Radiance Med Spa"
          autoComplete="organization"
          invalid={errorField === "clinicName"}
        />
        <div>
          <TextField
            label="Clinic website"
            value={fields.website}
            onChange={(v) => set("website", v)}
            placeholder="radiancemedspa.com"
            inputMode="url"
            autoComplete="url"
            disabled={fields.noWebsite}
            invalid={errorField === "website"}
          />
          <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm font-semibold">
            <input
              type="checkbox"
              checked={fields.noWebsite}
              onChange={(e) => set("noWebsite", e.target.checked)}
              className="accent-red size-4"
            />
            We don&apos;t have a website
          </label>
        </div>
        <TextField
          label="Clinic email"
          type="email"
          value={fields.email}
          onChange={(v) => set("email", v)}
          placeholder="info@radiancemedspa.com"
          autoComplete="email"
          hint="The one address your clinic will use with healdesk: we reply here, and later it's your sign-in and where everything is sent. A shared inbox such as info@ is fine."
          invalid={errorField === "email"}
        />

        <fieldset
          className={[
            "rounded-md border bg-white p-5",
            errorField === "channels" ? "border-red" : "border-line",
          ].join(" ")}
        >
          <legend className="text-sm font-bold tracking-[0.04em] uppercase">
            Where should AYA answer?
          </legend>
          <p className="text-muted mt-1.5 text-sm">Pick every channel you want. You choose a package with your setup link.</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {SETUP_CHANNELS.map((channel) => {
              const checked = fields.channels.includes(channel.id);
              return (
                <label
                  key={channel.id}
                  className={[
                    "flex cursor-pointer items-center gap-3 rounded-sm border px-4 py-3 transition-colors",
                    checked ? "border-red bg-red/[0.04]" : "border-line hover:border-line-strong",
                  ].join(" ")}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleChannel(channel.id)}
                    className="accent-red size-4 shrink-0"
                  />
                  <span className="text-sm font-semibold">{channel.label}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {/* The honeypot: off-screen rather than display:none, which some
            bots skip, and out of the tab order and the accessibility tree. */}
        <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
          <label>
            Middle name
            <input
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={fields.middleName}
              onChange={(e) => set("middleName", e.target.value)}
            />
          </label>
        </div>

        {error ? (
          <p className="text-red-deep text-sm font-semibold" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-4">
          <PrimaryButton type="submit" disabled={!ready || submitting}>
            {submitting ? "Sending…" : "Request my setup"}
          </PrimaryButton>
        </div>
      </form>
    </StepShell>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  type = "text",
  inputMode,
  autoComplete,
  disabled,
  invalid,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  type?: string;
  inputMode?: "url" | "email" | "text";
  autoComplete?: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-sm font-bold tracking-[0.04em] uppercase">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        autoComplete={autoComplete}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={[
          "text-ink placeholder:text-muted mt-2 w-full rounded-sm border bg-white px-4 py-3 text-lg outline-none transition-colors disabled:opacity-50",
          invalid ? "border-red" : "border-line focus:border-orange",
        ].join(" ")}
      />
      {hint ? <span className="text-muted mt-1.5 block text-xs">{hint}</span> : null}
    </label>
  );
}
