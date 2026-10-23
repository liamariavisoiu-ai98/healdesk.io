import { Failure, Tag } from "@/components/admin/ui";
import type { ClinicCards, ClinicCardView, OpsResult } from "@/lib/admin/ops-client";

/**
 * The one line the old clinic card carried that nothing else on the panel
 * says: the agreement the clinic is under, where each bought channel stands,
 * and the build tracker the clinic sees on its own Home, by stage and state
 * (listClinicCards). Drawn once, at the top of the Setup tab, under the
 * shell's header (which says the name, id, stage and blocker and is not
 * repeated here). A cards read that failed says so and costs only this line.
 */

/** The channel names the portal uses (the catalog's CHANNEL_NAMES), kept here for a static render. */
const CHANNEL_LABELS: Record<ClinicCardView["channels"][number]["channel"], string> = {
  web: "Website chat",
  meta: "Instagram, Messenger & WhatsApp",
  voice: "Phone",
};

const CHANNEL_STATUS_WORDS: Record<ClinicCardView["channels"][number]["status"], string> = {
  off: "off",
  paused: "paused",
  live: "live",
  waiting: "waiting on the clinic",
  setting_up: "setting up",
};

export function SetupSummary({ cards, clinicId }: { cards: OpsResult<ClinicCards>; clinicId: string }) {
  if (!cards.ok) return <Failure failure={cards} what="the clinic's agreement, channels and build" />;
  const card = cards.data.cards.find((c) => c.id === clinicId.toLowerCase());
  if (!card) {
    return <p className="text-muted mt-6 text-sm">The agreement, channels and build were not read for this clinic: it is past the {cards.data.limit} most recent the cards read covers.</p>;
  }
  return (
    <div className="mt-6 grid gap-1.5 text-sm">
      <p>
        <Tag tone={card.agreementKind ? "ok" : "warn"}>{card.agreementLabel}</Tag>
      </p>
      <p className="text-muted">
        {card.channels.length === 0
          ? "No channels bought."
          : card.channels.map((c) => `${CHANNEL_LABELS[c.channel]}: ${CHANNEL_STATUS_WORDS[c.status]}`).join(" · ")}
      </p>
      <p className="text-muted">
        Build: {card.tracker.map((s) => `${s.state === "done" ? "✓" : s.state === "info" ? "–" : "·"} ${s.label}`).join("  ")}
      </p>
      {card.trackerLeft.length > 0 ? <p className="text-muted">Still to do: {card.trackerLeft.join(", ")}.</p> : null}
    </div>
  );
}
