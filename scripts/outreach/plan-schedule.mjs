#!/usr/bin/env node
/**
 * Phases 3–6 capacity model — simulates staggered warmup, then the cold ramp, day by day,
 * and answers the only question that matters for planning: on what date is the 14,800th
 * send delivered, and does the plan fit the window?
 *
 * Why simulate rather than divide: the runbook's headline figure (30 inboxes x 27/day = 810/day)
 * is a steady-state number. It ignores (a) the staggered warmup start, so cohorts become
 * available on different dates, (b) the multi-week cold ramp from 8/day to 27/day, and
 * (c) weekends, if you send business-days-only as most B2B outreach does. Those three together
 * move the finish date materially.
 *
 * Usage:
 *   node scripts/outreach/plan-schedule.mjs --start 2026-08-18
 *   node scripts/outreach/plan-schedule.mjs --start 2026-08-18 --send-days 7
 *   node scripts/outreach/plan-schedule.mjs --start 2026-08-18 --warmup-days 21 --verbose
 */

import { ALL_DOMAINS, MAILBOXES_PER_DOMAIN } from './lib/domains.mjs'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const flag = (name) => args.includes(`--${name}`)

// ---- Config, mirroring the runbook's `sending` and `infrastructure` blocks ---------------
const CFG = {
  totalMailboxes: ALL_DOMAINS.length * MAILBOXES_PER_DOMAIN, // 30
  totalSends: Number(arg('total-sends', 14800)),

  // Phase 3 stagger: "4 to 6 mailboxes every 2 to 3 days". Midpoint of each range.
  cohortSize: Number(arg('cohort-size', 5)),
  cohortIntervalDays: Number(arg('cohort-interval', 3)),

  // Phase 4: "roughly 2 to 3 weeks of warmup" before the placement test. Use the pessimistic
  // end by default — the gate is a measurement, not a timer, and under-running it is the
  // single most common way this kind of build fails.
  warmupDays: Number(arg('warmup-days', 21)),

  coldStart: Number(arg('cold-start', 8)),
  coldRampStep: Number(arg('cold-ramp-step', 5)),
  coldCap: Number(arg('cold-cap', 27)),

  // 5 = Mon–Fri. Cold outreach to US clinics on a Saturday is wasted volume and mildly
  // reputation-negative; the runbook's 810/day assumes 7, which overstates weekly capacity by 40%.
  sendDaysPerWeek: Number(arg('send-days', 5)),

  startDate: arg('start', null),
}

if (!CFG.startDate) {
  console.error('Pass --start YYYY-MM-DD (the date warmup begins on the first cohort).')
  console.error('Example: node scripts/outreach/plan-schedule.mjs --start 2026-08-18')
  process.exit(1)
}

const start = new Date(`${CFG.startDate}T00:00:00Z`)
if (Number.isNaN(start.getTime())) {
  console.error(`Invalid --start date: ${CFG.startDate}`)
  process.exit(1)
}

const addDays = (d, n) => new Date(d.getTime() + n * 86400000)
const iso = (d) => d.toISOString().slice(0, 10)
const isSendDay = (d) => {
  if (CFG.sendDaysPerWeek >= 7) return true
  const dow = d.getUTCDay() // 0=Sun, 6=Sat
  return dow !== 0 && dow !== 6
}

// ---- Build cohorts ----------------------------------------------------------------------
const cohorts = []
for (let i = 0, n = 0; n < CFG.totalMailboxes; i++) {
  const size = Math.min(CFG.cohortSize, CFG.totalMailboxes - n)
  cohorts.push({
    index: i + 1,
    size,
    warmupStart: addDays(start, i * CFG.cohortIntervalDays),
    coldEligible: addDays(start, i * CFG.cohortIntervalDays + CFG.warmupDays),
  })
  n += size
}

// ---- Simulate ---------------------------------------------------------------------------
// Each mailbox carries its own cold volume, ramping from coldStart to coldCap on its own
// send-days, because cohorts go live on different dates.
const state = cohorts.map((c) => ({ ...c, live: false, perInbox: 0 }))

let sent = 0
let day = 0
let firstSendDate = null
let finishDate = null
const timeline = []
const MAX_DAYS = 400

while (day < MAX_DAYS) {
  const date = addDays(start, day)

  for (const c of state) {
    if (!c.live && date >= c.coldEligible) {
      c.live = true
      c.perInbox = CFG.coldStart
    }
  }

  let todaySends = 0
  if (isSendDay(date)) {
    for (const c of state) {
      if (!c.live) continue
      todaySends += c.perInbox * c.size
    }
    if (todaySends > 0) {
      const remaining = CFG.totalSends - sent
      const actual = Math.min(todaySends, remaining)
      if (firstSendDate === null) firstSendDate = date
      sent += actual
      // Ramp only on days the inbox actually sent.
      for (const c of state) {
        if (c.live) c.perInbox = Math.min(CFG.coldCap, c.perInbox + CFG.coldRampStep)
      }
    }
  }

  const liveInboxes = state.filter((c) => c.live).reduce((a, c) => a + c.size, 0)
  timeline.push({
    day,
    date: iso(date),
    sendDay: isSendDay(date),
    liveInboxes,
    capacity: todaySends,
    cumulative: sent,
    warmupLoad: liveInboxes * 12, // maintenance warmup continues alongside outreach
  })

  if (sent >= CFG.totalSends) {
    finishDate = date
    break
  }
  day++
}

// ---- Report -----------------------------------------------------------------------------
const B = '\x1b[1m'
const R = '\x1b[0m'
const Y = '\x1b[33m'
const G = '\x1b[32m'
const RD = '\x1b[31m'

console.log(`${B}Cold-email capacity plan${R}`)
console.log('='.repeat(72))
console.log(`Mailboxes            ${CFG.totalMailboxes} (${ALL_DOMAINS.length} domains x ${MAILBOXES_PER_DOMAIN})`)
console.log(`Total sends          ${CFG.totalSends.toLocaleString()}`)
console.log(`Warmup per cohort    ${CFG.warmupDays} days`)
console.log(`Stagger              ${CFG.cohortSize} mailboxes every ${CFG.cohortIntervalDays} days -> ${cohorts.length} cohorts`)
console.log(`Cold ramp            ${CFG.coldStart}/day +${CFG.coldRampStep}/day -> cap ${CFG.coldCap}/inbox/day`)
console.log(`Sending days         ${CFG.sendDaysPerWeek}/week${CFG.sendDaysPerWeek < 7 ? ' (Mon–Fri)' : ''}`)
console.log('')

console.log(`${B}Warmup schedule${R}`)
for (const c of cohorts) {
  console.log(
    `  Cohort ${String(c.index).padStart(2)}  ${String(c.size).padStart(2)} mailboxes   ` +
      `warmup ${iso(c.warmupStart)}  ->  cold-eligible ${G}${iso(c.coldEligible)}${R}`,
  )
}
console.log('')

const lastCohort = cohorts[cohorts.length - 1]
const fullRampDaily = CFG.totalMailboxes * CFG.coldCap
const weeklyAtFull = fullRampDaily * CFG.sendDaysPerWeek

console.log(`${B}Milestones${R}`)
console.log(`  Warmup begins            ${iso(start)}`)
console.log(`  Last cohort starts warm  ${iso(lastCohort.warmupStart)}`)
console.log(`  First live cold send     ${firstSendDate ? iso(firstSendDate) : 'n/a'}   ${Y}(subject to the 85% placement gate)${R}`)
console.log(`  All 30 inboxes eligible  ${iso(lastCohort.coldEligible)}`)
if (finishDate) {
  const totalWeeks = ((finishDate - start) / 86400000 / 7).toFixed(1)
  const sendWeeks = firstSendDate ? ((finishDate - firstSendDate) / 86400000 / 7).toFixed(1) : '?'
  console.log(`  ${B}Final send delivered     ${iso(finishDate)}${R}`)
  console.log('')
  console.log(`${B}Duration${R}`)
  console.log(`  Warmup start -> done     ${totalWeeks} weeks`)
  console.log(`  Live sending window      ${sendWeeks} weeks`)
} else {
  console.log(`  ${RD}Did not complete within ${MAX_DAYS} days.${R}`)
}
console.log('')

console.log(`${B}Steady-state capacity${R}`)
console.log(`  At full ramp             ${fullRampDaily.toLocaleString()}/send-day`)
console.log(`  Weekly                   ${weeklyAtFull.toLocaleString()}/week`)
console.log(`  Concurrent warmup load   ${(CFG.totalMailboxes * 12).toLocaleString()}/day (maintenance, never switched off)`)
console.log('')

// The runbook plans a ~6 week live-sending window. Check it rather than assume it.
if (finishDate && firstSendDate) {
  const sendWeeksNum = (finishDate - firstSendDate) / 86400000 / 7
  const totalWeeksNum = (finishDate - start) / 86400000 / 7
  console.log(`${B}Against the runbook's plan${R}`)
  console.log(
    `  Runbook says ~6 weeks of live sending. Model says ${sendWeeksNum.toFixed(1)} weeks ` +
      `${sendWeeksNum <= 6.5 ? `${G}— consistent${R}` : `${Y}— longer${R}`}`,
  )
  console.log(
    `  End-to-end from a standing start: ${B}${totalWeeksNum.toFixed(1)} weeks${R}. ` +
      `${totalWeeksNum > 8 ? `${Y}Budget the calendar accordingly.${R}` : ''}`,
  )
  if (CFG.sendDaysPerWeek < 7) {
    console.log(
      `  ${Y}Note:${R} the runbook's "810/day" implies 7-day sending. At Mon–Fri that is ` +
        `${weeklyAtFull.toLocaleString()}/week, not ${(fullRampDaily * 7).toLocaleString()}.`,
    )
  }
}

if (flag('verbose')) {
  console.log(`\n${B}Daily timeline${R}`)
  console.log('  date        live  capacity  cumulative  warmup')
  for (const t of timeline) {
    if (!t.sendDay && t.capacity === 0 && t.liveInboxes === 0) continue
    console.log(
      `  ${t.date}  ${String(t.liveInboxes).padStart(4)}  ${String(t.capacity).padStart(8)}  ` +
        `${String(t.cumulative).padStart(10)}  ${String(t.warmupLoad).padStart(6)}${t.sendDay ? '' : '   (weekend)'}`,
    )
  }
}
