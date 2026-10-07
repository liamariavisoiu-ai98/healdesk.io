import type { Channel } from "@healdesk/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  channelsInService,
  channelsReadyOnOurSide,
  channelStatus,
  readChannelStates,
  type ChannelState,
  type ClinicPause,
} from "@/lib/channels/state";
import { withTenant } from "@/lib/tenant";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * The one reading of a clinic's channels that the status words, the answer
 * gate and billing share (lib/channels/state.ts). The order of the rules is
 * the contract: Off wins over everything, and a pause shows only on a channel
 * that is live.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const actor = { type: "service", serviceName: "channel-state-test" } as const;

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-10-20T15:00:00Z");
const before = new Date(NOW.getTime() - HOUR);
const after = new Date(NOW.getTime() + HOUR);
const NOT_PAUSED: ClinicPause = { pausedAt: null, pausedUntil: null };
const PAUSED: ClinicPause = { pausedAt: before, pausedUntil: null };

function row(over: Partial<{ enabled: boolean; readyAt: Date | null; liveAt: Date | null }> = {}) {
  return { enabled: true, readyAt: null, liveAt: null, ...over };
}

function state(channel: Channel, over: Partial<ChannelState> = {}): ChannelState {
  return {
    channel,
    enabled: true,
    readyAt: null,
    waitingOn: null,
    liveAt: null,
    firstAnswerAt: null,
    pausedUntil: null,
    status: "setting_up",
    ...over,
  };
}

describe("channelStatus", () => {
  test("applies its rules in order: off, paused, live, waiting, setting up", () => {
    const live = row({ readyAt: before, liveAt: before });
    expect(channelStatus({ ...live, enabled: false }, PAUSED, NOW)).toBe("off");
    expect(channelStatus(live, PAUSED, NOW)).toBe("paused");
    expect(channelStatus(live, NOT_PAUSED, NOW)).toBe("live");
    expect(channelStatus(row({ readyAt: before }), NOT_PAUSED, NOW)).toBe("waiting");
    expect(channelStatus(row(), NOT_PAUSED, NOW)).toBe("setting_up");
    expect(channelStatus(row({ enabled: false }), NOT_PAUSED, NOW)).toBe("off");
  });

  test("a pause shows only on a live channel", () => {
    expect(channelStatus(row({ readyAt: before }), PAUSED, NOW)).toBe("waiting");
    expect(channelStatus(row(), PAUSED, NOW)).toBe("setting_up");
  });

  test("a timed pause holds until its end, and an end with no pause is no pause", () => {
    const live = row({ readyAt: before, liveAt: before });
    expect(channelStatus(live, { pausedAt: before, pausedUntil: after }, NOW)).toBe("paused");
    expect(channelStatus(live, { pausedAt: before, pausedUntil: NOW }, NOW)).toBe("live");
    expect(channelStatus(live, { pausedAt: before, pausedUntil: before }, NOW)).toBe("live");
    expect(channelStatus(live, { pausedAt: null, pausedUntil: after }, NOW)).toBe("live");
  });
});

describe("billing's two readings", () => {
  test("a channel is in service from its first answer, even once it is switched Off", () => {
    const states = [
      state("web", { readyAt: before, liveAt: before, firstAnswerAt: before, status: "live" }),
      state("meta", {
        enabled: false,
        readyAt: before,
        liveAt: before,
        firstAnswerAt: before,
        status: "off",
      }),
      state("voice", { readyAt: before, liveAt: before, status: "live" }),
    ];
    expect(channelsInService(states)).toEqual(["web", "meta"]);
  });

  test("ready on our side means live or waiting on the clinic, not still setting up", () => {
    const states = [
      state("web", { readyAt: before, liveAt: before, status: "live" }),
      state("meta", { readyAt: before, waitingOn: "meta_connect", status: "waiting" }),
      state("voice"),
    ];
    expect(channelsReadyOnOurSide(states)).toEqual(["web", "meta"]);
    expect(channelsInService(states)).toEqual([]);
  });
});

describeDb("readChannelStates", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("reads each bought channel in the catalog's order, with the clinic's pause", async () => {
    const { clinicId } = await seedClinic("channel-states");
    await inTenant(clinicId, async (c) => {
      await c.query(
        `insert into clinic_channels (clinic_id, channel, ready_at, live_at, first_answer_at) values ($1, 'voice', $2, $2, $2)`,
        [clinicId, before],
      );
      await c.query(
        `insert into clinic_channels (clinic_id, channel, ready_at, waiting_on) values ($1, 'web', $2, 'snippet')`,
        [clinicId, before],
      );
    });
    const read = (now: Date) =>
      withTenant({ clinicId, actor }, (tx) => readChannelStates(tx.db, clinicId, now));

    // No clinic_settings row: the defaults, so nothing is paused.
    let states = await read(NOW);
    expect(states.map((s) => [s.channel, s.status])).toEqual([
      ["web", "waiting"],
      ["voice", "live"],
    ]);
    expect(states[0]).toMatchObject({ waitingOn: "snippet", liveAt: null, pausedUntil: null });

    // Paused for an hour: the live channel shows it, the waiting one does not.
    await inTenant(clinicId, (c) =>
      c.query(
        `insert into clinic_settings (clinic_id, ai_paused_at, ai_paused_until) values ($1, $2, $3)`,
        [clinicId, before, after],
      ),
    );
    states = await read(NOW);
    expect(states.map((s) => s.status)).toEqual(["waiting", "paused"]);
    expect(states[1]!.pausedUntil?.getTime()).toBe(after.getTime());
    expect(states[0]!.pausedUntil).toBeNull();

    // Two hours on, the pause has ended by itself.
    states = await read(new Date(NOW.getTime() + 2 * HOUR));
    expect(states.map((s) => s.status)).toEqual(["waiting", "live"]);
    expect(states[1]!.pausedUntil).toBeNull();
    expect(channelsInService(states)).toEqual(["voice"]);
    expect(channelsReadyOnOurSide(states)).toEqual(["web", "voice"]);
  });

  test("reads nothing of another clinic's channels", async () => {
    const mine = await seedClinic("channel-states-mine");
    const theirs = await seedClinic("channel-states-theirs");
    await inTenant(theirs.clinicId, (c) =>
      c.query(`insert into clinic_channels (clinic_id, channel) values ($1, 'web')`, [
        theirs.clinicId,
      ]),
    );
    const seen = await withTenant({ clinicId: mine.clinicId, actor }, (tx) =>
      readChannelStates(tx.db, theirs.clinicId, NOW),
    );
    expect(seen).toEqual([]);
  });
});
