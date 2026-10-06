"use client";

import { useActionState, useEffect, useState } from "react";

import { useRouter } from "next/navigation";

import { createDemoAction, type CreateDemoState } from "./actions";

/**
 * The form an operator fills in when a prospect replies "yes, send it over":
 * the clinic's website is the one thing that matters, the rest seeds the page
 * and the email. Submitting returns the private link straight away; the demo
 * finishes building behind it.
 */

const NICHES = [
  ["", "Work it out from the site"],
  ["med-spa", "Med spa, dermatology, aesthetics"],
  ["plastic-surgery", "Plastic and cosmetic surgery"],
  ["dental", "Dental and orthodontics"],
  ["fertility", "Fertility and IVF"],
  ["glp1", "Weight loss and GLP-1"],
  ["hair-restoration", "Hair restoration"],
  ["veterinary", "Veterinary and pet spas"],
  ["massage-chiro", "Massage and chiropractic"],
] as const;

const field =
  "border-line focus:border-orange text-ink placeholder:text-muted w-full rounded-xl border bg-white px-3.5 py-2.5 text-[16px] outline-none transition-colors";

export function DemoBuilder() {
  const [state, action, pending] = useActionState<CreateDemoState, FormData>(createDemoAction, { status: "idle" });
  const [copied, setCopied] = useState(false);

  useEffect(() => setCopied(false), [state]);

  const invalid = (name: string) => state.status === "error" && state.field === name;

  return (
    <div className="border-line rounded-3xl border bg-white p-5 sm:p-6">
      <form action={action} className="grid gap-4 sm:grid-cols-2">
        <label className="sm:col-span-2">
          <span className="text-[14.4px] font-semibold">Clinic website</span>
          <input
            name="websiteUrl"
            required
            placeholder="smithdental.com"
            autoComplete="off"
            className={`${field} mt-1 ${invalid("websiteUrl") ? "border-red" : ""}`}
          />
        </label>
        <label>
          <span className="text-[14.4px] font-semibold">Clinic name</span>
          <input name="clinicName" required placeholder="Smith Dental" className={`${field} mt-1 ${invalid("clinicName") ? "border-red" : ""}`} />
        </label>
        <label>
          <span className="text-[14.4px] font-semibold">Niche</span>
          <select name="niche" className={`${field} mt-1`} defaultValue="">
            {NICHES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="text-[14.4px] font-semibold">Prospect email</span>
          <input
            name="leadEmail"
            type="email"
            placeholder="owner@smithdental.com"
            className={`${field} mt-1 ${invalid("leadEmail") ? "border-red" : ""}`}
          />
        </label>
        <label>
          <span className="text-[14.4px] font-semibold">Prospect phone (optional)</span>
          <input
            name="phone"
            type="tel"
            placeholder="+1 512 555 0142"
            className={`${field} mt-1 ${invalid("phone") ? "border-red" : ""}`}
          />
          <span className="text-muted mt-1 block text-[13.2px]">Prefills &ldquo;call me&rdquo;. They still tick consent themselves.</span>
        </label>
        <label className="flex items-center gap-2.5 sm:col-span-2">
          <input type="checkbox" name="sendEmail" className="accent-red size-4" />
          <span className="text-[15px] font-medium">Email them the link as soon as it&rsquo;s ready</span>
        </label>

        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <button
            type="submit"
            disabled={pending}
            className="bg-brand-gradient shadow-brand rounded-xl px-6 py-3 text-[16px] font-bold text-white transition-all duration-200 hover:-translate-y-px disabled:translate-y-0 disabled:opacity-50"
          >
            {pending ? "Creating…" : "Build the demo"}
          </button>
          {state.status === "error" ? (
            <p className="text-red-deep text-[15px] font-semibold" role="alert">
              {state.error}
            </p>
          ) : null}
        </div>
      </form>

      {state.status === "created" ? (
        <div className="bg-tint-mint mt-5 rounded-2xl px-4 py-4">
          <p className="text-[15px] font-semibold">
            {state.clinicName}&rsquo;s demo is building. This link works now and fills in within a minute or two:
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-white px-3 py-2 font-mono text-[14px]">{state.url}</code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(state.url).then(() => setCopied(true));
              }}
              className="border-line hover:border-line-strong rounded-lg border bg-white px-3 py-2 text-[14.4px] font-bold"
            >
              {copied ? "Copied" : "Copy link"}
            </button>
            <a
              href={state.url}
              target="_blank"
              rel="noreferrer"
              className="border-line hover:border-line-strong rounded-lg border bg-white px-3 py-2 text-[14.4px] font-bold"
            >
              Open
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Re-render the list every few seconds while any demo on it is still building. */
export function RefreshWhileAnyBuilding({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => router.refresh(), 5_000);
    return () => window.clearInterval(id);
  }, [active, router]);
  return null;
}

export function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(url).then(() => setCopied(true));
      }}
      className="text-red-deep hover:text-red text-[14.4px] font-bold"
    >
      {copied ? "Copied" : "Copy link"}
    </button>
  );
}
