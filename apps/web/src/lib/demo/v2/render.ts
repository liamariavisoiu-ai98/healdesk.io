import { PRODUCTS, shortClinicName } from "@healdesk/catalog";

import { demoGaps, gapLabel } from "../gaps";
import { weekSchedule } from "../opening-hours";
import type { ClinicProfile } from "../profile";
import { CHAT_SLOT_ID, VOICE_SLOT_ID } from "./slots";
import { DEMO_V2_BODY, DEMO_V2_SCRIPT } from "./template";

/**
 * The owner's demo page (lib/demo/v2/template.ts) for one clinic: what the
 * file's own notes say production does, and nothing else.
 *
 *   - "Clinic data (Lumen Aesthetics & Wellness, prices, hours, providers) is
 *     sample data standing in for the scraped clinic_context": each Lumen is
 *     the clinic's name (or its short name where the file says "Lumen"), the
 *     sample email is the requester's, the sample link is the demo's, the
 *     sample phone is the clinic's, and the opening days and hours come from
 *     its profile (lib/demo/opening-hours.ts).
 *   - "Voice and chat are scripted placeholders" and "keep the repo's
 *     existing voice and chat cards unchanged": the two card bodies become
 *     slots (./slots.ts) that components/demo/DemoV2Islands.tsx fills with VoiceCard and ClinicChatPanel, and the
 *     scripted call and chat are cut from the script.
 *   - "The countdown ... comes from ... (server), never a client timer that
 *     resets": the deadline is the demo's own offer end (demoOfferEndsAt).
 *   - The discount: the file prints 50%, the operator's demo credit; a demo
 *     asked for on the homepage carries 30% (catalog SELF_SERVE_DEMO_SETUP_CREDIT),
 *     so the page says the demo's own share, and the setup figures are the
 *     catalog's, discounted the way checkout discounts them
 *     (`setupAfterCreditUsd`: rounded up to the dollar).
 *   - "Pay hands off to Stripe Checkout": Pay opens the existing purchase
 *     (/demo/[slug]/onboard) on the plan built on the page; that purchase signs
 *     the agreements and takes the card, as every other purchase does.
 *   - "The VIP flag is saved": joining the Metachat list is a demo event.
 *   - The team call-back "POST ... to the server, which alerts the team":
 *     /api/demo/[slug]/callback.
 *   - Privacy, Terms and the agreements link to the real pages.
 *
 * Every replacement names an exact piece of the template and throws when it
 * is missing (render.test.ts), so a changed template fails the build instead
 * of serving Lumen to a clinic.
 */

export type DemoV2Input = {
  slug: string;
  /** The demo's public link. */
  url: string;
  profile: ClinicProfile;
  /** The name shown (lib/demo/sessions.ts displayName). */
  name: string;
  logoUrl: string | null;
  leadEmail: string | null;
  /** The demo's setup share off, e.g. 50 or 30. */
  percentOff: number;
  /** When the discount ends, or null when it already has. */
  offerEndsAt: Date | null;
  /** The AYA portrait shown beside the demo bars. */
  ayaImage: string;
};

export type DemoV2 = { body: string; script: string };

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Replace every occurrence of `find`, which must occur at least once. */
function swapAll(text: string, find: string, replace: string): string {
  if (!text.includes(find)) throw new Error(`demo v2: the template no longer contains ${JSON.stringify(find.slice(0, 80))}`);
  return text.split(find).join(replace);
}

/** Replace the one span from `start` up to (not including) `end`. */
function swapSpan(text: string, start: string, end: string, replace: string): string {
  const from = text.indexOf(start);
  const to = from === -1 ? -1 : text.indexOf(end, from);
  if (from === -1 || to === -1) throw new Error(`demo v2: the template no longer has the span starting ${JSON.stringify(start.slice(0, 60))}`);
  return text.slice(0, from) + replace + text.slice(to);
}

/** "(512) 555-0142" in the clinic's own area code, the file's sample of a new local number. */
function newNumberSample(phone: string | null): string {
  const digits = (phone ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return digits.length === 10 ? `(${digits.slice(0, 3)}) 555-0142` : "(512) 555-0142";
}

/** The file's CTX: open days as JS weekdays (0 is Sunday), and one opening and closing hour for them. */
export function demoV2Context(input: Pick<DemoV2Input, "name" | "logoUrl" | "profile">) {
  const schedule = weekSchedule(input.profile.hours);
  // weekSchedule counts Monday as 0; the file counts Sunday as 0.
  const days = [0, 1, 2, 3, 4, 5, 6].filter((jsDay) => (schedule.days[(jsDay + 6) % 7] ?? []).length > 0);
  const spans = days.flatMap((jsDay) => schedule.days[(jsDay + 6) % 7] ?? []);
  const open = spans.length > 0 ? Math.min(...spans.map(([start]) => start)) / 60 : 9;
  const close = spans.length > 0 ? Math.max(...spans.map(([, end]) => end)) / 60 : 17;
  const gaps = new Set(demoGaps(input.profile));
  return {
    name: input.name,
    short: shortClinicName(input.name),
    logo: input.logoUrl ?? "",
    phone: input.profile.phone ?? "Your clinic number",
    open,
    close,
    days: days.length > 0 ? days : [1, 2, 3, 4, 5],
    found: {
      services: !gaps.has("treatments"),
      prices: !gaps.has("treatments") && !gaps.has("prices"),
      hours: !gaps.has("hours"),
      team: !gaps.has("team"),
      location: !gaps.has("address"),
      policies: !gaps.has("policy"),
    },
  };
}

function setupFees(percentOff: number) {
  const voice = PRODUCTS.voice.setupFeeUsd;
  const web = PRODUCTS.webchat.setupFeeUsd;
  const meta = PRODUCTS.metachat.setupFeeUsd;
  const list = { voice, web, meta, "voice+web": voice + web, "voice+meta": voice + meta };
  // The same rounding as checkout's setupAfterCreditUsd: up to the dollar.
  const after = Object.fromEntries(Object.entries(list).map(([k, fee]) => [k, Math.ceil((fee * (100 - percentOff)) / 100)]));
  return { list, after };
}

/**
 * The note above the voice and chat cards: what a demo built from public
 * pages cannot know, so the owner trying it reads the gaps as normal rather
 * than as faults (owner, 30 October 2026: "write a list of things public
 * website scrapping couldnt gather and add it as disclaimer on top of the demo
 * voice and chat section"). The live calendar and the deposit rules are never
 * on a public site; the rest is what this scan missed (lib/demo/gaps.ts).
 */
export function demoNoteHtml(profile: ClinicProfile): string {
  const missed = demoGaps(profile)
    .filter((gap) => gap !== "policy")
    .map((gap) => gapLabel(gap, "patients"));
  const items = ["your live booking calendar, so she can't see real free times yet", "your deposit and cancellation rules", ...missed];
  const list = items.map((item) => `<li>${escapeHtml(item.charAt(0).toUpperCase() + item.slice(1))}</li>`).join("");
  return `<aside class="hd-note" role="note"><span class="hd-note-i" aria-hidden="true">i</span><div><p class="hd-note-h">What this demo can't know yet</p><p class="hd-note-p">It was built only from your public website and Google listing, so some things are missing. That's normal: you add them at setup, and Aya uses them from then on.</p><ul class="hd-note-l">${list}</ul></div></aside>`;
}

export function renderDemoV2(input: DemoV2Input): DemoV2 {
  const ctx = demoV2Context(input);
  const name = escapeHtml(input.name);
  const short = escapeHtml(ctx.short);
  const pct = `${Math.round(input.percentOff)}%`;
  const link = input.url.replace(/^https?:\/\//, "");

  let body = DEMO_V2_BODY;
  // What a demo from public pages cannot know, above the two cards.
  body = swapAll(body, '<div class="demo-grid" data-show="voice">', `${demoNoteHtml(input.profile)}<div class="demo-grid" data-show="voice">`);
  // The two stand-in card bodies become slots; each card keeps its own header.
  body = swapSpan(body, '<div class="vseg-wrap">', "\n      </div>\n\n      <!-- Chat -->", `<div id="${VOICE_SLOT_ID}" class="hd-slot"></div>`);
  body = swapSpan(body, '<div class="chtabs">', "\n      </div>\n    </div>\n\n    <div class=\"live-card\"", `<div id="${CHAT_SLOT_ID}" class="hd-slot"></div>`);
  // The sample clinic, longest names first so "Lumen" never eats a full name.
  body = swapAll(body, "Lumen Aesthetics &amp; Wellness", name);
  body = swapAll(body, "Lumen Aesthetics", short);
  // The small logo boxes print one word, as the file's "LUMEN" does.
  body = swapAll(body, "LUMEN", escapeHtml((ctx.short.split(/\s+/)[0] ?? ctx.short).toUpperCase()));
  body = swapAll(body, "elena@lumenaesthetics.com", escapeHtml(input.leadEmail ?? ""));
  body = swapAll(body, "healdesk.io/demo/lumen-aesthetics", escapeHtml(link));
  body = swapAll(body, "(512) 555-0100", escapeHtml(ctx.phone));
  body = swapAll(body, "Lumen", short);
  body = swapAll(body, "50%", pct);
  // The links the mockup left dead.
  body = swapAll(body, '<a href="#" onclick="return false">Privacy</a><a href="#" onclick="return false">Terms</a>', '<a href="/privacy">Privacy</a><a href="/terms">Terms</a>');
  body = swapAll(body, '<a href="#" onclick="return false"><span class="dl">Read the&nbsp;</span>Service Agreement</a>', '<a href="/terms" target="_blank" rel="noopener"><span class="dl">Read the&nbsp;</span>Service Agreement</a>');
  body = swapAll(body, '<a href="#" onclick="return false"><span class="dl">Read the&nbsp;</span>BAA</a>', '<a href="/terms#phi" target="_blank" rel="noopener"><span class="dl">Read the&nbsp;</span>BAA</a>');

  let script = DEMO_V2_SCRIPT;
  script = swapSpan(script, '  var DEMO_URL = "https://healdesk.io/demo/lumen-aesthetics";', "  $(\"pullAv\").src", "  var HD = window.__HD_DEMO__, DEMO_URL = HD.url, CLINIC = HD.ctx.name, CTX = HD.ctx;\n");
  script = swapAll(script, '$("pullAv").src = document.querySelector(".portrait img").src;', '$("pullAv").src = HD.aya;');
  script = swapSpan(script, "  var RATE = { voice:80, web:40, meta:60 };", "  var state = {", "  var RATE = HD.rate, SETUP = HD.setup, SETUP_HALF = HD.setupAfter;\n");
  script = swapSpan(script, '  var KEY = "hd_discount_deadline_lumen"', "  function tick(){", "  var deadline = HD.offerEndsAt || 0, expired = false;\n");
  // Pay opens the existing purchase on the plan built here.
  script = swapAll(
    script,
    '      toast("Opening secure Stripe checkout");',
    '      toast("Opening secure Stripe checkout");\n      var plan = state.voice && state.chat ? "voice-webchat-" + state.vSteps + "-" + state.cSteps : state.voice ? "voice-" + state.vSteps : "webchat-" + state.cSteps;\n      location.href = HD.onboard + "?from=checkout&plan=" + encodeURIComponent(plan);',
  );
  script = swapAll(
    script,
    '$("metaSwitch").addEventListener("click", function(){ setVip(!vip); if(vip) toast("You\'re on the Aya Metachat VIP list, free"); });',
    '$("metaSwitch").addEventListener("click", function(){ setVip(!vip); if(vip) toast("You\'re on the Aya Metachat VIP list, free"); try{ fetch(HD.events, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ name:"metachat_vip", detail: vip ? "joined" : "left" }), keepalive:true }).catch(function(){}); }catch(e){} });',
  );
  // The scripted call and chat: the real cards replace them.
  script = swapSpan(script, "  /* ---------- Voice (scripted placeholder for Retell WebRTC) ---------- */", "  /* ---------- Share ---------- */", "");
  script = swapAll(script, 'var src = document.querySelector(".portrait img").src;', "var src = HD.aya;");
  script = swapAll(script, '"(512) 555-0142"', "HD.newNumber");
  script = swapAll(script, 'CTX.name.split(" ")[0] + " is open "', 'CTX.short + " is open "');
  // The team call-back reaches the team, and says so only when it did.
  script = swapAll(
    script,
    '        var done = document.createElement("div"); done.className = "cb-done";\n        done.textContent = "Got it. " + (inHours() ? "Our team will call you right away." : "Our team will call you at 9 a.m. ET.");\n        f.replaceWith(done);',
    '        var btn = f.querySelector("button"); if(btn) btn.disabled = true;\n        fetch(HD.callback, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ phone: v }) }).then(function(r){\n          if(!r.ok) throw new Error(String(r.status));\n          var done = document.createElement("div"); done.className = "cb-done";\n          done.textContent = "Got it. " + (inHours() ? "Our team will call you right away." : "Our team will call you at 9 a.m. ET.");\n          f.replaceWith(done);\n        }).catch(function(){ if(btn) btn.disabled = false; toast("That did not go through. Email hello@healdesk.io and we will call you."); });',
  );
  script = swapAll(script, "50%", pct);

  const { list, after } = setupFees(input.percentOff);
  const data = {
    url: input.url,
    ctx,
    aya: input.ayaImage,
    rate: { voice: PRODUCTS.voice.perStepMonthlyUsd, web: PRODUCTS.webchat.perStepMonthlyUsd, meta: PRODUCTS.metachat.perStepMonthlyUsd },
    setup: list,
    setupAfter: after,
    offerEndsAt: input.offerEndsAt ? input.offerEndsAt.getTime() : null,
    onboard: `/demo/${input.slug}/onboard`,
    events: `/api/demo/${input.slug}/event`,
    callback: `/api/demo/${input.slug}/callback`,
    newNumber: newNumberSample(input.profile.phone),
  };
  // JSON inside a script: "</" must not close it.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return { body, script: `window.__HD_DEMO__ = ${json};\n${script}` };
}
