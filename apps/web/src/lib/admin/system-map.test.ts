import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  assess,
  BRIDGES,
  GROUPS,
  KEYS,
  NOT_KEYS,
  STORIES,
  THEMES,
  TOOLS,
  type BridgeView,
  type HostReach,
  type KeyView,
  type LiveInputs,
} from "./system-map";

/**
 * The system map (/admin/map): the registry is honest about the code, the
 * picture is legible, and the colouring says what was found and nothing more.
 */

const WEB_SRC = join(__dirname, "..", "..");
const REPO = join(WEB_SRC, "..", "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const NOW = new Date("2026-10-14T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

/** Every Vercel and AWS key present, the host answering, every proof passing. */
function allGood(over: Partial<LiveInputs> = {}): LiveInputs {
  const vercel: Record<string, boolean> = {};
  const aws: Record<string, boolean> = {};
  for (const key of KEYS) {
    if (key.home === "vercel" && key.env) vercel[key.env] = true;
    if (key.home === "aws" && key.env) aws[key.env] = true;
  }
  return {
    now: NOW,
    vercel,
    vercelStripeMode: "live",
    host: { state: "answered", present: aws, stripeMode: "live" },
    proofs: {
      kms: { ok: true, detail: "ok" },
      sheet: { ok: true, detail: "ok" },
      "github-actions": { ok: true, detail: "ok" },
      "github-feed": { ok: true, detail: "ok" },
    },
    expiresAt: {},
    rotatedAt: {},
    rotationLog: "read",
    ...over,
  };
}

function bridge(view: ReturnType<typeof assess>, id: string): BridgeView {
  const found = view.bridges.find((b) => b.id === id);
  if (!found) throw new Error(`no bridge ${id}`);
  return found;
}

function key(view: ReturnType<typeof assess>, id: string): KeyView {
  const found = view.keys.find((k) => k.id === id);
  if (!found) throw new Error(`no key ${id}`);
  return found;
}

describe("the registry", () => {
  test("ids are unique and every reference resolves", () => {
    const tools = new Set(TOOLS.map((t) => t.id));
    const keys = new Set(KEYS.map((k) => k.id));
    const bridges = new Set(BRIDGES.map((b) => b.id));
    expect(tools.size).toBe(TOOLS.length);
    expect(keys.size).toBe(KEYS.length);
    expect(bridges.size).toBe(BRIDGES.length);

    for (const b of BRIDGES) {
      expect(tools.has(b.from), `${b.id}.from`).toBe(true);
      expect(tools.has(b.to), `${b.id}.to`).toBe(true);
      for (const k of b.keys) expect(keys.has(k), `${b.id} names ${k}`).toBe(true);
      if (b.dependsOn) expect(bridges.has(b.dependsOn), `${b.id}.dependsOn`).toBe(true);
      // A bridge with no key says why it needs none.
      if (b.keys.length === 0) expect(b.keyless, `${b.id}.keyless`).toBeTruthy();
    }
  });

  test("every key is on some bridge, and every tool has one", () => {
    const used = new Set(BRIDGES.flatMap((b) => b.keys));
    for (const k of KEYS) expect(used.has(k.id), `${k.id} is on no bridge`).toBe(true);
    for (const t of TOOLS) {
      expect(BRIDGES.some((b) => b.from === t.id || b.to === t.id), `${t.id} has no bridge`).toBe(true);
    }
  });

  test("a key's id is its home and its variable, and `later` keys say what they wait for", () => {
    for (const k of KEYS) {
      if (k.env) expect(k.id).toBe(`${k.home}.${k.env}`);
      if (k.need === "later") expect(k.waitsFor, k.id).toBeTruthy();
      if (k.sameAs) expect(KEYS.some((other) => other.id === k.sameAs && other.env === k.env), k.id).toBe(true);
    }
  });

  /**
   * A renamed variable must fail here rather than leave the map asking about
   * a name nothing reads, which would show a key as missing forever.
   */
  test("every Vercel key is read by the shop window's code", () => {
    const source = walk(WEB_SRC)
      .filter((file) => !file.endsWith(join("admin", "system-map.ts")))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    for (const k of KEYS.filter((k) => k.home === "vercel")) {
      expect(new RegExp(`\\b${k.env}\\b`).test(source), `${k.env} is read in apps/web/src`).toBe(true);
    }
  });

  test("every AWS key is one the engine reports on (apps/app lib/ops/key-presence.ts)", () => {
    const presence = readFileSync(join(REPO, "apps", "app", "src", "lib", "ops", "key-presence.ts"), "utf8");
    const listed = presence.slice(presence.indexOf("KEY_PRESENCE_NAMES = ["), presence.indexOf("] as const"));
    for (const k of KEYS.filter((k) => k.home === "aws")) {
      expect(listed, `${k.env} is not in KEY_PRESENCE_NAMES`).toContain(`"${k.env}"`);
    }
  });

  test("every secret Terraform makes for the engine is on the map", () => {
    const ssm = readFileSync(join(REPO, "infra", "aws", "ssm.tf"), "utf8");
    const external = ssm.slice(ssm.indexOf("external_parameter_names = ["));
    const names = [...external.slice(0, external.indexOf("]")).matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map((m) => m[1]!);
    const internal = ssm.slice(ssm.indexOf("internal_parameter_paths = {"));
    const app = [...internal.slice(0, internal.indexOf("}")).matchAll(/([A-Z][A-Z0-9_]+)\s*=\s*"app\//g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(5);
    for (const name of [...names, ...app]) {
      expect(KEYS.some((k) => k.id === `aws.${name}`), `aws.${name} is not on the map`).toBe(true);
    }
  });

  /**
   * The other way round: every variable either app reads, in its code or in
   * the scripts beside it (run on your computer, or as one-off jobs inside
   * AWS), is a key on the map or a setting NOT_KEYS names, so a new secret
   * cannot be added to the code and stay off the map. A read is
   * `process.env.NAME`, `process.env["NAME"]`, one of the helpers that take a
   * name (apps/app's `optional` and `required`, apps/web's `pastedSetting`),
   * or a name held in a `…_VARIABLE` constant (lib/host/github.ts). A name
   * reached any other way is not seen, which is why the forward tests above
   * hold the map's own names to the code.
   */
  test("every variable either app reads is on the map or named as a setting", () => {
    const READS = [
      /process\.env\.([A-Z][A-Z0-9_]+)/g,
      /process\.env\[\s*["'`]([A-Z][A-Z0-9_]+)["'`]\s*\]/g,
      /\b(?:optional|required|pastedSetting)\(\s*["']([A-Z][A-Z0-9_]+)["']/g,
      /\b[A-Z][A-Z0-9_]*_VARIABLE\s*=\s*["']([A-Z][A-Z0-9_]+)["']/g,
    ];
    const readsIn = (...dirs: string[]) => {
      const names = new Set<string>();
      for (const file of dirs.flatMap((dir) => walk(dir))) {
        const text = readFileSync(file, "utf8");
        for (const re of READS) for (const m of text.matchAll(re)) names.add(m[1]!);
      }
      return names;
    };
    const web = readsIn(WEB_SRC, join(REPO, "apps", "web", "scripts"));
    const app = readsIn(join(REPO, "apps", "app", "src"), join(REPO, "apps", "app", "scripts"));
    const onMap = (homes: string[]) => new Set(KEYS.filter((k) => homes.includes(k.home)).map((k) => k.env));

    const webKeys = onMap(["vercel"]);
    const appKeys = onMap(["aws", "aws-ci"]);
    const unseen = [
      ...[...web].filter((n) => !webKeys.has(n) && !(n in NOT_KEYS)).map((n) => `apps/web reads ${n}`),
      ...[...app].filter((n) => !appKeys.has(n) && !(n in NOT_KEYS)).map((n) => `apps/app reads ${n}`),
    ];
    expect(unseen, "add it to KEYS in system-map.ts, or to NOT_KEYS with the reason it is not a key").toEqual([]);

    // A setting nothing reads any more comes off the list, so it stays short and true.
    const stale = Object.keys(NOT_KEYS).filter((n) => !web.has(n) && !app.has(n));
    expect(stale, "no longer read by either app: remove from NOT_KEYS").toEqual([]);
  });

  test("the deploy-only and your computer's keys are the ones the AWS setup and .env.example name", () => {
    const paste = readFileSync(join(REPO, "infra", "aws", "scripts", "put-external-secrets.sh"), "utf8");
    const ssm = readFileSync(join(REPO, "infra", "aws", "ssm.tf"), "utf8");
    const example = readFileSync(join(REPO, ".env.example"), "utf8");
    for (const k of KEYS.filter((k) => k.home === "aws-ci")) expect(paste.includes(k.env!) || ssm.includes(k.env!), k.id).toBe(true);
    for (const k of KEYS.filter((k) => k.home === "computer")) expect(example).toContain(`${k.env}=`);
  });

  test("GitHub's keys are the repository variables the AWS workflows read", () => {
    const workflows = join(REPO, ".github", "workflows");
    const text = readdirSync(workflows)
      .map((name) => readFileSync(join(workflows, name), "utf8"))
      .join("\n");
    for (const k of KEYS.filter((k) => k.home === "github")) expect(text, k.id).toContain(`vars.${k.env}`);
  });
});

describe("categories, themes and stories", () => {
  test("every tool but the two hubs sits in one category, and every category has a tool", () => {
    const groups = new Set(GROUPS.map((g) => g.id));
    expect(groups.size).toBe(GROUPS.length);
    for (const t of TOOLS) {
      if (t.id === "app" || t.id === "web") expect(t.category, t.id).toBeNull();
      else expect(groups.has(t.category!), `${t.id} is in ${t.category}`).toBe(true);
    }
    for (const g of GROUPS) expect(TOOLS.some((t) => t.category === g.id), `${g.id} is empty`).toBe(true);
  });

  test("a category's band agrees with the side its tools are on", () => {
    for (const t of TOOLS.filter((t) => t.category)) {
      const band = GROUPS.find((g) => g.id === t.category)!.band;
      expect(band === "shared" ? "both" : band, t.id).toBe(t.side);
    }
  });

  test("every bridge has a theme the lenses know", () => {
    const themes = new Set(THEMES.map((t) => t.id));
    for (const b of BRIDGES) expect(themes.has(b.theme), b.id).toBe(true);
  });

  test("every story step is a real bridge, and a story never repeats one", () => {
    for (const story of STORIES) {
      const ids = story.steps.map((step) => step.bridge);
      expect(new Set(ids).size, story.id).toBe(ids.length);
      for (const id of ids) expect(BRIDGES.some((b) => b.id === id), `${story.id}: ${id}`).toBe(true);
    }
  });
});

describe("assess", () => {
  test("with everything in place, live checks show as proven and nothing is left but what waits on purpose", () => {
    const view = assess(allGood());
    expect(bridge(view, "web-app")).toMatchObject({ status: "working", proven: true });
    expect(bridge(view, "app-kms")).toMatchObject({ status: "working", proven: true });
    expect(bridge(view, "you-console")).toMatchObject({ status: "working", proven: false });
    expect(bridge(view, "connectors-app").status).toBe("parked");
    expect(bridge(view, "patients-widget").status).toBe("to-build");
    expect(view.todos.filter((t) => t.kind === "fix" || t.kind === "add-key")).toEqual([]);
  });

  test("a key held back on purpose turns its bridge, and the bridges that need it, off rather than missing", () => {
    const live = allGood();
    const host = live.host as Extract<HostReach, { state: "answered" }>;
    host.present.META_APP_SECRET = false;
    host.present.HEALDESK_RETELL_LLM_SECRET = false;
    const view = assess(live);

    expect(key(view, "aws.META_APP_SECRET").state).toBe("waiting");
    expect(bridge(view, "meta-app").status).toBe("off");
    // AYA can't answer on Instagram before Meta can hand over a message.
    expect(bridge(view, "app-meta").status).toBe("off");
    expect(bridge(view, "app-meta").statusText).toContain("Meta passes on patients' messages");
    // The patient's call, forwarded, waits on the voice line.
    expect(bridge(view, "retell-app").status).toBe("off");
    expect(bridge(view, "patients-retell").status).toBe("off");
    expect(view.todos.some((t) => t.kind === "add-key" && t.key === "aws.META_APP_SECRET")).toBe(false);
    expect(view.todos.some((t) => t.kind === "waiting" && t.key === "aws.META_APP_SECRET")).toBe(true);
  });

  test("a pasted voice secret alone is not voice: the line stays off until enable_voice is on", () => {
    const live = allGood();
    (live.host as Extract<HostReach, { state: "answered" }>).present.HEALDESK_VOICE_ENABLED = false;
    const view = assess(live);

    expect(key(view, "aws.HEALDESK_RETELL_LLM_SECRET").state).toBe("in-place");
    expect(bridge(view, "retell-app").status).toBe("off");
    expect(bridge(view, "retell-app").statusText).toContain("enable_voice");
    expect(bridge(view, "patients-retell").status).toBe("off");
    expect(bridge(view, "retell-clinic").status).toBe("off");
  });

  test("checkout waits on the Sheet it seals purchases into, and on the seal", () => {
    const sheetDown = assess(allGood({ proofs: { ...allGood().proofs, sheet: { ok: false, detail: "no access" } } }));
    // A broken Sheet breaks checkout too; only the Sheet gets the to-do.
    expect(bridge(sheetDown, "web-stripe").status).toBe("broken");
    expect(bridge(sheetDown, "web-stripe").statusText).toMatch(/^Waits on bridge \d+, "Leads and setup requests/);
    expect(sheetDown.todos.filter((t) => t.kind === "fix").map((t) => t.bridge)).toEqual(["web-sheets"]);

    const live = allGood();
    live.vercel.HEALDESK_PROVISION_SECRET = false;
    expect(bridge(assess(live), "web-stripe").status).toBe("needs-key");
  });

  test("a bridge that waits on a broken or unconfigured one takes its colour, never 'off on purpose'", () => {
    const refused = assess(allGood({ host: { state: "refused", message: "most often the two copies differ" }, proofs: {} }));
    expect(bridge(refused, "stripe-web").status).toBe("broken");
    expect(bridge(refused, "stripe-web").statusText).toContain("Most often the two copies differ");

    expect(bridge(assess(allGood({ host: { state: "unconfigured" }, proofs: {} })), "stripe-web").status).toBe("needs-key");
    expect(bridge(assess(allGood({ proofs: { ...allGood().proofs, kms: { ok: false, detail: "denied" } } })), "app-ses").status).toBe("broken");
  });

  test("an engine older than this page's list says so, rather than 'could not be read'", () => {
    const live = allGood();
    delete (live.host as Extract<HostReach, { state: "answered" }>).present.HEALDESK_VOICE_ENABLED;
    const view = assess(live);
    expect(bridge(view, "retell-app").status).toBe("unknown");
    expect(bridge(view, "retell-app").statusText).toContain("older version");
    for (const b of view.bridges) expect(b.statusText, b.id).not.toContain("could not be read");
    expect(view.todos.some((t) => t.kind === "check" && t.text.includes("deploy-app.yml"))).toBe(true);
  });

  test("GitHub's repository variables are named but never checked from here", () => {
    const view = assess(allGood());
    for (const k of view.keys.filter((k) => k.home === "github")) expect(k.state, k.id).toBe("not-checked");
    expect(bridge(view, "github-app").status).toBe("not-checked");
  });

  test("a required key that is missing names itself and where to add it", () => {
    const live = allGood();
    live.vercel.STRIPE_WEBHOOK_SECRET = false;
    (live.host as Extract<HostReach, { state: "answered" }>).present.STRIPE_CONNECT_CLIENT_ID = false;
    const view = assess(live);

    expect(bridge(view, "stripe-web").status).toBe("needs-key");
    expect(bridge(view, "app-clinic-stripe").status).toBe("needs-key");
    const todos = view.todos.filter((t) => t.kind === "add-key").map((t) => t.text);
    expect(todos.some((t) => t.includes("STRIPE_WEBHOOK_SECRET") && t.includes("Vercel"))).toBe(true);
    expect(todos.some((t) => t.includes("STRIPE_CONNECT_CLIENT_ID") && t.includes("production.tfvars"))).toBe(true);
  });

  test("an optional key that is missing switches a feature off and is not a to-do", () => {
    const live = allGood();
    live.vercel.SLACK_WEBHOOK_URL = false;
    live.vercel.RETELL_DEMO_INBOUND_AGENT_ID = false;
    const view = assess(live);
    expect(key(view, "vercel.SLACK_WEBHOOK_URL").state).toBe("optional-off");
    expect(view.todos.some((t) => t.key === "vercel.SLACK_WEBHOOK_URL")).toBe(false);
    // Its only key: the whole line is off. One of several: that part is.
    expect(bridge(view, "web-slack").status).toBe("off");
    expect(bridge(view, "prospects-retell-demo").status).toBe("working");
    expect(bridge(view, "prospects-retell-demo").statusText).toContain("not added, so that part is off");
    expect(bridge(view, "prospects-retell-demo").statusText).not.toContain("every key it needs is in place");
  });

  test("an engine that is up but refuses is not called 'in standby'", () => {
    const view = assess(allGood({ host: { state: "refused", message: "the two copies differ" }, proofs: {} }));
    expect(bridge(view, "console-app").status).toBe("unknown");
    expect(bridge(view, "console-app").statusText).toContain("refused");
    expect(bridge(view, "app-gcal").statusText).not.toContain("standby");
  });

  test("a host that does not answer makes its keys unknown, never missing", () => {
    const view = assess(allGood({ host: { state: "silent", message: "nothing answered at its address" }, proofs: {} }));
    for (const k of view.keys.filter((k) => k.home === "aws")) expect(k.state, k.id).toBe("unknown");
    expect(bridge(view, "web-app").status).toBe("unknown");
    expect(bridge(view, "app-kms").status).toBe("unknown");
    expect(bridge(view, "app-gcal").status).toBe("unknown");
    // Keyless work on the engine is not "connected" while there is no engine.
    expect(bridge(view, "console-app").status).toBe("unknown");
    expect(bridge(view, "app-exports").status).toBe("unknown");
    expect(view.todos.some((t) => t.kind === "add-key" && t.key?.startsWith("aws."))).toBe(false);
    expect(view.todos.some((t) => t.kind === "check")).toBe(true);
    // What is unbuilt stays on the list, whatever the host is doing.
    const builds = view.todos.filter((t) => t.kind === "build").map((t) => t.bridge);
    expect(builds).toEqual(expect.arrayContaining(["patients-widget", "app-clinic-stripe", "clinic-app"]));
  });

  test("a host that refuses the signed call breaks the bridge between the two apps", () => {
    const view = assess(allGood({ host: { state: "refused", message: "the two copies differ" }, proofs: {} }));
    expect(bridge(view, "web-app")).toMatchObject({ status: "broken", statusText: "the two copies differ" });
    expect(view.todos[0]).toMatchObject({ kind: "fix", bridge: "web-app" });
  });

  test("Stripe on test keys on one side and live on the other is broken; the same mode is not", () => {
    const mismatch = allGood({ vercelStripeMode: "test" });
    expect(bridge(assess(mismatch), "web-stripe").status).toBe("broken");
    expect(bridge(assess(mismatch), "app-stripe").status).toBe("broken");

    const bothTest = allGood({ vercelStripeMode: "test" });
    (bothTest.host as Extract<HostReach, { state: "answered" }>).stripeMode = "test";
    const view = assess(bothTest);
    expect(bridge(view, "web-stripe")).toMatchObject({ status: "working", testMode: true });
  });

  test("a failed live check breaks its bridge with the reason", () => {
    const view = assess(allGood({ proofs: { kms: { ok: false, detail: "The engine could not use the key safe just now (denied)." } } }));
    expect(bridge(view, "app-kms")).toMatchObject({ status: "broken" });
    expect(bridge(view, "app-kms").statusText).toContain("denied");
  });

  describe("rotation", () => {
    const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY);

    test("counts the suggested days from the last recorded rotation", () => {
      const view = assess(
        allGood({
          rotatedAt: {
            "vercel.HEALDESK_ADMIN_SECRET": at(10),
            "vercel.STRIPE_SECRET_KEY": at(170),
            "vercel.RETELL_API_KEY": at(200),
          },
        }),
      );
      expect(key(view, "vercel.HEALDESK_ADMIN_SECRET").rotation).toMatchObject({ state: "ok", lastOn: "2026-10-04", dueOn: "2027-04-02" });
      expect(key(view, "vercel.STRIPE_SECRET_KEY").rotation.state).toBe("due-soon");
      expect(key(view, "vercel.RETELL_API_KEY").rotation.state).toBe("overdue");
      expect(view.rotationsDue).toBe(2);
      expect(view.todos.filter((t) => t.kind === "rotate").map((t) => t.key)).toEqual(["vercel.STRIPE_SECRET_KEY", "vercel.RETELL_API_KEY"]);
    });

    test("an unrecorded rotation is said, not guessed, and is not a to-do", () => {
      const view = assess(allGood());
      expect(key(view, "vercel.ANTHROPIC_API_KEY").rotation).toMatchObject({ state: "unrecorded", recordable: true, dueOn: null });
      expect(view.todos.some((t) => t.kind === "rotate")).toBe(false);
    });

    test("never-rotate keys say so and cannot be marked rotated", () => {
      const view = assess(allGood());
      expect(key(view, "aws.HEALDESK_IDENTIFIER_REF_KEY").rotation).toMatchObject({ state: "never", recordable: false });
      expect(key(view, "vercel.MARKETING_SHEET_ID").rotation).toMatchObject({ state: "public", recordable: false });
    });

    test("a GitHub token's real expiry beats any schedule, and an expired one breaks its bridge", () => {
      const soon = assess(allGood({ expiresAt: { "vercel.HEALDESK_GITHUB_ACTIONS_TOKEN": new Date(NOW.getTime() + 5 * DAY) } }));
      expect(key(soon, "vercel.HEALDESK_GITHUB_ACTIONS_TOKEN").rotation).toMatchObject({ state: "due-soon", dueOn: "2026-10-19" });
      expect(bridge(soon, "web-github").status).toBe("working");

      const gone = assess(allGood({ expiresAt: { "vercel.HEALDESK_GITHUB_ACTIONS_TOKEN": new Date(NOW.getTime() - DAY) } }));
      expect(key(gone, "vercel.HEALDESK_GITHUB_ACTIONS_TOKEN").state).toBe("broken");
      expect(bridge(gone, "web-github").status).toBe("broken");
    });
  });

  test("the view carries names, states and sentences only", () => {
    const view = assess(allGood());
    // Every value in the view is a string, number, boolean or null, or a
    // structure of them: nothing a key's value could hide in is computed here,
    // because nothing here is ever given one.
    const json = JSON.stringify(view);
    expect(json).not.toMatch(/sk_live_|sk_test_|whsec_|re_[A-Za-z0-9]{8}|sk-ant-/);
  });
});
