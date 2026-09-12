/**
 * Build the local working-docs page.
 *
 *   npm run docs
 *
 * Reads docs/*.md, renders them, and writes one self-contained HTML file to
 * .docs-site/ (gitignored). No network, no CDN, no fonts to fetch — it works on
 * a plane and it works offline, which matters for a page you open while on the
 * phone to a vendor.
 *
 * The landing view is generated from scripts/docs-site/tasks.mjs, which is a
 * VIEW over handover.md rather than a second list. The `source` heading on every
 * task is verified against the real document below, and the build fails if one
 * has gone missing — that check is the whole reason this cannot quietly drift.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { render, slug } from "./markdown.mjs";
import { GROUPS, TASKS } from "./tasks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const out = join(repo, ".docs-site");

/** Inlined so the page stays a single self-contained file with no fetches. */
const clientJs = readFileSync(join(here, "client.js"), "utf8");

/**
 * `file` is the path under docs/. It differs from `id` for the nested outreach
 * documents, whose ids are flattened so they can be routes.
 */
const DOCS = [
  {
    id: "handover",
    file: "handover.md",
    title: "Handover",
    group: "Start",
    tagline: "The live list. If it isn't here, it isn't on the list.",
  },
  {
    id: "launch-plan",
    file: "launch-plan.md",
    title: "Launch plan",
    group: "Plan",
    tagline: "Plan of record: vendors, channels, pricing, build phases.",
  },
  {
    id: "next-steps",
    file: "next-steps.md",
    title: "Next steps",
    group: "Plan",
    tagline: "The best-sequenced document in the repo. A1–C3.",
  },
  {
    id: "blockers-runbook",
    file: "blockers-runbook.md",
    title: "Blockers runbook",
    group: "Do the work",
    tagline: "Click-by-click, with the exact text to send each vendor.",
  },
  {
    id: "outreach-step-by-step",
    file: "outreach/STEP-BY-STEP.md",
    title: "Outreach: step by step",
    group: "Do the work",
    tagline: "Cold-email infrastructure, gate by gate. This wins over the runbook.",
  },
  {
    id: "outreach-run-log",
    file: "outreach/run-log.md",
    title: "Outreach: run log",
    group: "Do the work",
    tagline: "What has actually been executed. Check here before redoing anything.",
  },
  {
    id: "outreach-infra",
    file: "outreach/coldemail-infra-runbook.md",
    title: "Outreach: infrastructure",
    group: "Do the work",
    tagline: "The original infra research. Superseded where the two disagree.",
  },
  {
    id: "leadgen-playbook",
    file: "leadgen-playbook.md",
    title: "Leadgen playbook",
    group: "Do the work",
    tagline: "Finding and scoring clinics worth contacting.",
  },
  {
    id: "research-conclusions",
    file: "research-conclusions.md",
    title: "Research",
    group: "Why",
    tagline: "Why each rule exists, and what it costs commercially.",
  },
  {
    id: "state-of-play",
    file: "state-of-play.md",
    title: "State of play",
    group: "Why",
    tagline: "A dated audit (2 Sep). Reasoning, not a task list.",
  },
  {
    id: "architecture",
    file: "architecture.md",
    title: "Architecture",
    group: "Why",
    tagline: "How the two apps fit together, and the locked decisions.",
  },
];

const STATUS = {
  ready: { label: "Ready to do", tone: "go" },
  vendor: { label: "Waiting on vendor", tone: "wait" },
  counsel: { label: "Waiting on counsel", tone: "wait" },
  decision: { label: "Your call", tone: "decide" },
};

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// --------------------------------------------------------------- read docs
const rendered = DOCS.map((doc) => {
  const md = readFileSync(join(repo, "docs", doc.file), "utf8");
  const { html, headings } = render(md);
  return { ...doc, html, headings };
});

// ------------------------------------------------- drift check (load-bearing)
const problems = [];
for (const task of TASKS) {
  const doc = rendered.find((d) => d.id === task.source.doc);
  if (!doc) {
    problems.push(`${task.id}: unknown source doc "${task.source.doc}"`);
    continue;
  }
  const want = slug(task.source.heading);
  if (!doc.headings.some((h) => h.id === want)) {
    problems.push(
      `${task.id}: "${task.source.heading}" no longer exists in docs/${doc.id}.md`,
    );
  }
}
if (problems.length) {
  console.error(
    "\nThe task view has drifted from the documents it explains:\n\n" +
      problems.map((p) => `  ✗ ${p}`).join("\n") +
      "\n\nFix scripts/docs-site/tasks.mjs, or update the heading it points at.\n" +
      "Do not delete the check — it is what stops this page becoming a second,\n" +
      "quietly-wrong task list.\n",
  );
  process.exit(1);
}

// ------------------------------------------------------------------ markup
const byId = Object.fromEntries(TASKS.map((t) => [t.id, t]));

const taskCard = (t) => {
  const s = STATUS[t.status];
  const doc = DOCS.find((d) => d.id === t.source.doc);
  const blocker = t.blockedBy ? byId[t.blockedBy] : null;
  return `
<details class="task" id="t-${t.id}" data-status="${t.status}">
  <summary>
    <span class="chip ${s.tone}">${s.label}</span>
    <span class="t-title">${esc(t.title)}</span>
    <span class="t-effort">${esc(t.effort)}</span>
  </summary>
  <div class="t-body">
    <p class="t-plain">${esc(t.plain)}</p>
    <div class="t-why"><span class="t-lab">Why it matters</span><p>${esc(t.why)}</p></div>
    ${
      blocker
        ? `<p class="t-blocked">Do <a href="#t-${blocker.id}">${esc(blocker.title)}</a> first.</p>`
        : ""
    }
    <span class="t-lab">Steps</span>
    <ol class="t-steps">${t.steps.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>
    <a class="t-src" href="#/${t.source.doc}#${slug(t.source.heading)}">
      Source · ${esc(doc.title)} → ${esc(t.source.heading)}
    </a>
  </div>
</details>`;
};

const startPage = `
<h1>Everything left to do</h1>
<p class="lede">
  ${TASKS.length} tasks, in the order the business needs them. Each is explained in plain
  English with steps, and links back to the document it came from — the documents stay
  the source of truth; this page is a way in.
</p>
<div class="filters">
  <button class="f on" data-f="all">All <b>${TASKS.length}</b></button>
  ${Object.entries(STATUS)
    .map(([k, v]) => {
      const n = TASKS.filter((t) => t.status === k).length;
      return n
        ? `<button class="f" data-f="${k}"><span class="dot ${v.tone}"></span>${v.label} <b>${n}</b></button>`
        : "";
    })
    .join("")}
</div>
${GROUPS.map((g, i) => {
  const items = TASKS.filter((t) => t.group === g.id);
  if (!items.length) return "";
  return `
<section class="group" data-group="${g.id}">
  <h2 id="${g.id}"><span class="g-num">${i + 1}</span>${esc(g.title)} <span class="g-count">${items.length}</span></h2>
  <p class="g-blurb">${esc(g.blurb)}</p>
  ${items.map(taskCard).join("")}
</section>`;
}).join("")}
<p class="foot">
  Generated from <code>docs/</code> by <code>npm run docs</code>. Edit the markdown,
  not this page.
</p>`;

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>healdesk · working docs</title>
<meta name="docs-token" content="__DOCS_TOKEN__">
<style>
:root{
  --ink:#1a1614; --soft:#5b524c; --mute:#8a807a;
  --line:#e8e1da; --line2:#d6ccc3; --bg:#fff; --wash:#faf7f4;
  --red:#e0301e; --go:#2f7d52; --wait:#b3701a; --decide:#1b5fc1;
  --r:10px;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0;background:var(--bg);color:var(--ink);
  font:15.5px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased;
}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
a{color:var(--red);text-decoration:none}
a:hover{text-decoration:underline}

.layout{display:grid;grid-template-columns:270px 1fr;min-height:100vh}
nav{
  border-right:1px solid var(--line);padding:26px 18px 60px;
  position:sticky;top:0;height:100vh;overflow-y:auto;background:var(--wash);
}
.brand{font-size:17px;font-weight:700;letter-spacing:-.02em;margin:0 0 2px 8px}
.brand span{color:var(--red)}
.brand-sub{font-size:11.5px;color:var(--mute);margin:0 0 18px 8px}
nav a.nav{
  display:block;padding:7px 10px;border-radius:8px;color:var(--soft);
  font-size:13.5px;font-weight:500;
}
nav a.nav:hover{background:#f0e9e2;color:var(--ink);text-decoration:none}
nav a.nav.on{background:var(--ink);color:#fff}
.nav-sub{font-size:11px;color:var(--mute);margin:2px 0 10px 10px;line-height:1.4}
.nav-h{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--mute);margin:20px 0 8px 10px}
.toc a{display:block;padding:3px 10px 3px 14px;font-size:12.5px;color:var(--mute);border-left:2px solid var(--line)}
.toc a:hover{color:var(--ink);border-left-color:var(--line2);text-decoration:none}
.toc a.l3{padding-left:26px}

main{padding:38px 46px 120px;max-width:900px;min-width:0}
h1{font-size:31px;letter-spacing:-.02em;margin:0 0 6px}
h2{font-size:22px;letter-spacing:-.015em;margin:34px 0 10px;scroll-margin-top:20px}
h3{font-size:17px;margin:26px 0 8px;scroll-margin-top:20px}
h4{font-size:15px;margin:20px 0 6px}
p{margin:0 0 12px;max-width:74ch}
.lede{color:var(--soft);font-size:16.5px;max-width:66ch;margin-bottom:26px}
ul,ol{margin:0 0 14px;padding-left:22px;max-width:74ch}
li{margin-bottom:6px}
hr{border:0;border-top:1px solid var(--line);margin:30px 0}
blockquote{
  margin:14px 0;padding:12px 16px;border-left:3px solid var(--line2);
  background:var(--wash);border-radius:0 8px 8px 0;color:var(--soft);
}
blockquote p{margin-bottom:8px}
blockquote :last-child{margin-bottom:0}
code{background:#f3ede7;padding:1px 5px;border-radius:5px;font-size:12.5px}
pre{background:var(--wash);border:1px solid var(--line);border-radius:var(--r);padding:14px;overflow-x:auto}
pre code{background:none;padding:0;font-size:12.5px}
.tw{overflow-x:auto;margin:14px 0;border:1px solid var(--line);border-radius:var(--r)}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{text-align:left;padding:9px 13px;border-bottom:1px solid var(--line);vertical-align:top}
th{background:var(--wash);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute)}
tr:last-child td{border-bottom:none}

.group{margin-bottom:34px}
.g-blurb{color:var(--soft);font-size:14px;max-width:68ch;margin-bottom:14px}
.task{border:1px solid var(--line);border-radius:var(--r);margin-bottom:9px;background:#fff;overflow:hidden}
.task[open]{border-color:var(--line2)}
.task>summary{
  cursor:pointer;list-style:none;padding:13px 16px;display:flex;
  align-items:center;gap:12px;flex-wrap:wrap;
}
.task>summary::-webkit-details-marker{display:none}
.task>summary:hover{background:var(--wash)}
.t-title{font-weight:600;font-size:15px;flex:1;min-width:220px}
.t-effort{font-size:11.5px;color:var(--mute);font-family:ui-monospace,monospace}
.chip{font-size:10px;letter-spacing:.05em;text-transform:uppercase;font-weight:700;padding:3px 8px;border-radius:100px;white-space:nowrap}
.chip.go{background:#eaf5ef;color:var(--go)}
.chip.wait{background:#fdf4e7;color:var(--wait)}
.chip.decide{background:#eef4fc;color:var(--decide)}
.t-body{padding:2px 18px 18px;border-top:1px solid var(--line)}
.t-plain{font-size:15px;margin-top:14px}
.t-why{background:var(--wash);border-radius:8px;padding:11px 14px;margin:12px 0 16px}
.t-why p{margin:4px 0 0;font-size:14px;color:var(--soft)}
.t-lab{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--mute);font-weight:700}
.t-steps{margin-top:8px;font-size:14.5px}
.t-steps li{margin-bottom:9px}
.t-src{display:inline-block;margin-top:8px;font-size:12.5px;color:var(--mute)}
.t-src:hover{color:var(--red)}
.foot{color:var(--mute);font-size:12.5px;margin-top:40px}
.filters{display:flex;gap:7px;flex-wrap:wrap;margin:0 0 26px}
.f{
  font:inherit;font-size:12.5px;cursor:pointer;background:#fff;color:var(--soft);
  border:1px solid var(--line);border-radius:100px;padding:5px 12px;display:flex;
  align-items:center;gap:6px;
}
.f:hover{border-color:var(--line2)}
.f.on{background:var(--ink);color:#fff;border-color:var(--ink)}
.f b{font-weight:700;opacity:.65}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block}
.dot.go{background:var(--go)}.dot.wait{background:var(--wait)}.dot.decide{background:var(--decide)}
.g-num{
  display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;
  background:var(--ink);color:#fff;font-size:12px;font-weight:700;margin-right:9px;
  vertical-align:2px;
}
.g-count{font-size:12px;color:var(--mute);font-weight:400;margin-left:6px}
.t-blocked{
  font-size:13.5px;background:#fdf4e7;border-radius:8px;padding:9px 13px;
  margin:0 0 14px;color:#7a4d09;
}
.task.hide{display:none}
.group.hide{display:none}

@media (max-width:880px){
  .layout{grid-template-columns:1fr}
  nav{position:static;height:auto;border-right:none;border-bottom:1px solid var(--line)}
  main{padding:26px 20px 80px}
  .toc{display:none}
}

/* ---------------- review comments ---------------- */
.cbtn{
  border:1px solid var(--line);background:#fff;color:var(--mute);cursor:pointer;
  font:inherit;font-size:11px;border-radius:100px;padding:2px 9px;line-height:1.6;
}
.cbtn:hover{border-color:var(--red);color:var(--red)}
h2 .cbtn,h3 .cbtn{margin-left:10px;vertical-align:middle;opacity:0;transition:opacity .12s}
h2:hover .cbtn,h3:hover .cbtn{opacity:1}
.has-note{box-shadow:inset 3px 0 0 var(--red)}

#sel{
  position:absolute;z-index:60;display:none;background:var(--ink);color:#fff;
  border-radius:8px;padding:5px 11px;font-size:12px;font-weight:600;cursor:pointer;
  box-shadow:0 6px 20px -8px rgba(0,0,0,.5);
}

#fab{
  position:fixed;right:22px;bottom:22px;z-index:70;background:var(--ink);color:#fff;
  border:none;border-radius:100px;padding:11px 18px;font:inherit;font-size:13.5px;
  font-weight:600;cursor:pointer;box-shadow:0 8px 26px -10px rgba(0,0,0,.55);
  display:flex;align-items:center;gap:9px;
}
#fab:hover{background:#000}
#fab .n{background:var(--red);border-radius:100px;padding:1px 8px;font-size:12px}
#fab.none .n{display:none}

#drawer{
  position:fixed;right:0;top:0;bottom:0;width:min(460px,100vw);z-index:80;background:#fff;
  border-left:1px solid var(--line);display:none;flex-direction:column;
  box-shadow:-14px 0 40px -22px rgba(0,0,0,.4);
}
#drawer.open{display:flex}
.dh{padding:18px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px}
.dh h3{margin:0;font-size:16px;flex:1}
.dh button{background:none;border:none;font-size:20px;cursor:pointer;color:var(--mute);line-height:1}
.dlist{flex:1;overflow-y:auto;padding:14px 20px}
.dnote{border:1px solid var(--line);border-radius:10px;padding:12px 13px;margin-bottom:10px}
.dnote .tgt{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);font-weight:700}
.dnote .q{
  font-size:12.5px;color:var(--soft);border-left:2px solid var(--line2);
  padding-left:9px;margin:7px 0;font-style:italic;
}
.dnote .b{font-size:14px;margin:6px 0 0;white-space:pre-wrap}
.dnote .x{float:right;background:none;border:none;color:var(--mute);cursor:pointer;font-size:15px;line-height:1}
.dnote .x:hover{color:var(--red)}
.dempty{color:var(--mute);font-size:13.5px;text-align:center;padding:38px 10px}
.df{padding:14px 20px;border-top:1px solid var(--line)}
.df button{
  width:100%;background:var(--red);color:#fff;border:none;border-radius:9px;
  padding:11px;font:inherit;font-size:14px;font-weight:700;cursor:pointer;
}
.df button:disabled{background:var(--line2);cursor:not-allowed}
.df .hint{font-size:11.5px;color:var(--mute);margin:8px 0 0;text-align:center}

#compose{position:fixed;inset:0;z-index:90;background:rgba(20,16,14,.35);display:none;align-items:center;justify-content:center}
#compose.open{display:flex}
.cbox{background:#fff;border-radius:14px;width:min(560px,92vw);padding:20px;box-shadow:0 24px 60px -20px rgba(0,0,0,.5)}
.cbox h3{margin:0 0 3px;font-size:17px}
.cbox .on{font-size:12.5px;color:var(--mute);margin:0 0 12px}
.cbox textarea{
  width:100%;min-height:120px;border:1px solid var(--line2);border-radius:9px;padding:11px;
  font:inherit;font-size:14.5px;resize:vertical;
}
.cbox textarea:focus{outline:2px solid var(--red);outline-offset:1px;border-color:transparent}
.cbox .row{display:flex;gap:9px;justify-content:flex-end;margin-top:12px}
.cbox .row button{border-radius:8px;padding:9px 16px;font:inherit;font-size:13.5px;font-weight:600;cursor:pointer;border:1px solid var(--line2);background:#fff}
.cbox .row .go{background:var(--ink);color:#fff;border-color:var(--ink)}

#run{position:fixed;inset:0;z-index:95;background:rgba(20,16,14,.55);display:none;align-items:center;justify-content:center}
#run.open{display:flex}
.rbox{background:#fff;border-radius:14px;width:min(760px,94vw);max-height:82vh;display:flex;flex-direction:column;overflow:hidden}
.rbox .rh{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:11px}
.rbox .rh h3{margin:0;font-size:16px;flex:1}
.spin{width:13px;height:13px;border:2px solid var(--line2);border-top-color:var(--red);border-radius:50%;animation:sp .7s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
.rlog{flex:1;overflow-y:auto;padding:16px 20px;font-family:ui-monospace,monospace;font-size:12.5px;line-height:1.6;white-space:pre-wrap}
.rlog .tool{color:var(--decide)}
.rlog .err{color:var(--red)}
.rlog .ok{color:var(--go);font-weight:700}
.rbox .rf{padding:13px 20px;border-top:1px solid var(--line);display:flex;justify-content:flex-end;gap:9px}
.rbox .rf button{border-radius:8px;padding:9px 16px;font:inherit;font-size:13.5px;font-weight:600;cursor:pointer;border:1px solid var(--line2);background:#fff}
@media print{#fab,#drawer,#sel,#compose,#run{display:none!important}}

@media print{nav{display:none}.task{break-inside:avoid}.task>summary{display:block}}
</style>
</head>
<body>
<div class="layout">
  <nav>
    <p class="brand"><span>heal</span>desk</p>
    <p class="brand-sub">Working docs · local only</p>
    <a class="nav" href="#/start" data-r="start">What's open</a>
    <p class="nav-sub">Plain English, with steps.</p>
    ${[...new Set(DOCS.map((d) => d.group))]
      .map(
        (g) =>
          `<p class="nav-h">${esc(g)}</p>` +
          DOCS.filter((d) => d.group === g)
            .map(
              (d) =>
                `<a class="nav" href="#/${d.id}" data-r="${d.id}">${esc(d.title)}</a>
                 <p class="nav-sub">${esc(d.tagline)}</p>`,
            )
            .join(""),
      )
      .join("")}
    <div id="toc" class="toc"></div>
  </nav>
  <main id="main"></main>
</div>


<button id="fab" class="none"><span>Comments</span><span class="n">0</span></button>
<div id="sel">Comment</div>

<aside id="drawer">
  <div class="dh"><h3>Review comments</h3><button id="dclose" aria-label="Close">&times;</button></div>
  <div class="dlist" id="dlist"></div>
  <div class="df">
    <button id="submit">Submit to Claude</button>
    <p class="hint">Claude edits this repo and leaves the changes uncommitted for you to review.</p>
  </div>
</aside>

<div id="compose">
  <div class="cbox">
    <h3>Add a comment</h3>
    <p class="on" id="con"></p>
    <textarea id="cbody" placeholder="What should change? Be specific &mdash; this becomes Claude&rsquo;s instruction."></textarea>
    <div class="row">
      <button id="ccancel">Cancel</button>
      <button id="csave" class="go">Add comment</button>
    </div>
  </div>
</div>

<div id="run">
  <div class="rbox">
    <div class="rh"><span class="spin" id="rspin"></span><h3 id="rtitle">Claude is working&hellip;</h3></div>
    <div class="rlog" id="rlog"></div>
    <div class="rf"><button id="rclose">Close</button></div>
  </div>
</div>

<script id="data" type="application/json">${JSON.stringify({
  start: startPage,
  docs: Object.fromEntries(rendered.map((d) => [d.id, { html: d.html, headings: d.headings }])),
}).replace(/</g, "\\u003c")}</script>

<script>
(function(){
  var DATA = JSON.parse(document.getElementById("data").textContent);
  var main = document.getElementById("main");
  var toc = document.getElementById("toc");

  function route(){
    // "#/doc#heading" -> ["doc", "heading"]
    var raw = location.hash.replace(/^#\\//, "") || "start";
    var parts = raw.split("#");
    return { page: parts[0] || "start", anchor: parts[1] || null };
  }

  function draw(){
    var r = route();
    var isStart = r.page === "start";
    main.innerHTML = isStart ? DATA.start : (DATA.docs[r.page] ? DATA.docs[r.page].html : DATA.start);

    document.querySelectorAll("a.nav").forEach(function(a){
      a.classList.toggle("on", a.dataset.r === r.page);
    });

    // Section list for the current document.
    var hs = (!isStart && DATA.docs[r.page]) ? DATA.docs[r.page].headings : [];
    toc.innerHTML = hs.length
      ? '<p class="nav-h">On this page</p>' + hs.filter(function(h){ return h.level >= 2; })
          .map(function(h){
            return '<a class="' + (h.level === 3 ? "l3" : "") + '" href="#/' + r.page + '#' + h.id + '">' + h.text + "</a>";
          }).join("")
      : "";

    if (r.anchor) {
      var el = document.getElementById(r.anchor);
      if (el) { el.scrollIntoView(); return; }
    }
    window.scrollTo(0, 0);
  }

  // Status filter on the landing page. Re-bound after every draw because the
  // buttons are part of the rendered HTML, not the shell.
  function bindFilters(){
    var btns = document.querySelectorAll("button.f");
    btns.forEach(function(b){
      b.addEventListener("click", function(){
        var want = b.dataset.f;
        btns.forEach(function(o){ o.classList.toggle("on", o === b); });
        document.querySelectorAll(".task").forEach(function(t){
          t.classList.toggle("hide", want !== "all" && t.dataset.status !== want);
        });
        document.querySelectorAll(".group").forEach(function(g){
          var any = g.querySelectorAll(".task:not(.hide)").length > 0;
          g.classList.toggle("hide", !any);
        });
      });
    });
  }

  window.addEventListener("hashchange", function(){
    draw(); bindFilters();
    if (window.__attachComments) window.__attachComments();
  });
  draw();
  bindFilters();
})();
</script>
<script>${clientJs}</script>
<script>
  if (window.__attachComments) window.__attachComments();
</script>
</body>
</html>`;

mkdirSync(out, { recursive: true });
writeFileSync(join(out, "index.html"), page);
console.log(
  `\n  Built .docs-site/index.html — ${DOCS.length} documents, ${TASKS.length} tasks\n`,
);
