/**
 * Words a caller said that sound like something the call knows (owner,
 * 1 November 2026, on a test call to the Miami Skin & Vein demo: "this port"
 * for Dysport five times, "Ristalin" for Restylane, "barking" for parking,
 * "bottle" for Botox, "doctor Sean" for Dr. Shaun Patel: "she should be able
 * to understand that when she's already mentioned a subject and the caller
 * replies with something that sounds closely similar to that subject, she
 * should just continue on that topic").
 *
 * The transcriber writes what it heard, so a caller who says Dysport the way
 * they say it gets "this port" every time, and asking them to say it again
 * only loops. This reads each word and each pair of words against the menu,
 * the providers, a front desk's usual topics and, above all, what she said in
 * the last few turns, by how they sound rather than how they are spelled.
 * A confident match becomes a note for the turn ("they said 'this port': that
 * is Dysport"); two equally close ones, a single either-or question.
 *
 * Plain code, no model and no vendor: the words never leave the call.
 */

/** What the call knows, to match what it heard against. */
export type SoundAlikeVocabulary = {
  /** The practice's treatments, by their menu names. */
  services: readonly string[];
  /** The providers' names ("Dr. Shaun Patel"). */
  providers: readonly string[];
  /** What she said in the last few turns, newest last: a match there is the likeliest. */
  recent: readonly string[];
};

/** A word they said, and what it most likely was. */
export type SoundAlike = { heard: string; meant: string } | { heard: string; options: readonly [string, string] };

/** A front desk's usual topics: words a caller asks about that are not on any menu. */
const TOPICS = ["parking", "deposit", "insurance", "financing", "cancellation", "consultation", "appointment", "location", "address", "refund", "membership", "payment"] as const;

/** Words too common to be taken for anything else on their own ("for", "this", "part"). */
const COMMON = new Set(
  "a an the this that these those it its is are was were be been to of in on at by for from with about as and or but if so not no yes yeah yep ok okay alright right sure please thanks thank you i me my mine we us our you your he him his she her they them their what when where which who why how do does did can could would should will shall have has had get got want need like just also too very really more most less much many some any all one two three four five six seven eight nine ten part port four for far fair full fill feel there here then than now well good great fine nice day week time today tomorrow morning afternoon evening night monday tuesday wednesday thursday friday saturday sunday book booking hi hello hey bye goodbye".split(
    " ",
  ),
);

/**
 * A word's sound, in a few letters: consonant groups a transcriber confuses
 * are one letter (b and p, d and t, g, k, c and q, s and z, f, v and ph),
 * "sh" and "th" lose their h, vowels go after the first letter, and doubles
 * are said once. "this port" and "Dysport" are both "tsprt".
 */
export function soundKey(text: string): string {
  let w = text.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return "";
  w = w
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/[cq]/g, "k")
    .replace(/x/g, "ks")
    .replace(/sh|ch/g, "s")
    .replace(/th/g, "t")
    .replace(/dg/g, "j")
    .replace(/gh/g, "g");
  const map: Record<string, string> = { b: "p", d: "t", g: "k", z: "s", v: "f", j: "j", w: "", h: "", y: "" };
  let out = "";
  for (const [i, ch] of [...w].entries()) {
    if ("aeiou".includes(ch)) {
      if (i === 0) out += "a";
      continue;
    }
    const c = map[ch] ?? ch;
    if (c && out.at(-1) !== c) out += c;
  }
  return out;
}

/** How alike two sound keys are, 0 to 1 (1 - edit distance / longer length). */
function alike(a: string, b: string): number {
  if (!a || !b) return 0;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return 1 - d[a.length]![b.length]! / Math.max(a.length, b.length);
}

/** The names a caller might say: each menu name, its distinctive words, the providers' names, the topics. */
function targets(vocabulary: SoundAlikeVocabulary): { name: string; word: string }[] {
  const out: { name: string; word: string }[] = [];
  const add = (name: string, word: string) => {
    const clean = word.replace(/[®™]/g, "").trim();
    if (clean.length >= 4 && !COMMON.has(clean.toLowerCase())) out.push({ name, word: clean });
  };
  for (const service of vocabulary.services) {
    const name = service.replace(/[®™]/g, "").trim();
    add(name, name);
    for (const word of name.split(/[\s/&,()-]+/)) if (word.length >= 5) add(name, word);
  }
  for (const provider of vocabulary.providers) {
    for (const word of provider.replace(/^(?:dr\.?|doctor)\s+/i, "").split(/\s+/)) add(provider, word);
  }
  for (const topic of TOPICS) add(topic, topic);
  return out;
}

/** Whether a name was in what she said in the last few turns. */
function recentlySaid(name: string, word: string, recent: readonly string[]): boolean {
  const said = recent.join(" ").toLowerCase();
  return said.includes(name.toLowerCase()) || said.includes(word.toLowerCase());
}

/**
 * What their words most likely meant, for each word or pair of words that is
 * not itself something the call knows but sounds like it. A sound key that
 * matches outright counts anywhere; a looser one only for something she just
 * said (a44374c9-era test call: "the bottle" right after Botox).
 */
export function soundAlikes(words: string, vocabulary: SoundAlikeVocabulary): SoundAlike[] {
  const all = targets(vocabulary);
  if (all.length === 0) return [];
  const tokens = words.split(/[^A-Za-z']+/).filter(Boolean);
  const said = new Set(tokens.map((t) => t.toLowerCase()));
  const known = new Set(all.map((t) => t.word.toLowerCase()));
  const out: SoundAlike[] = [];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const one = tokens[i]!;
    if (one.length >= 4 && !COMMON.has(one.toLowerCase())) candidates.push(one);
    const two = tokens[i + 1];
    if (two) candidates.push(`${one} ${two}`);
  }
  // A name said after "doctor" ("doctor Sean"): short, so matched only to a provider's name, and only outright.
  for (let i = 1; i < tokens.length; i += 1) {
    if (!/^(?:dr|doctor)$/i.test(tokens[i - 1]!)) continue;
    const heard = tokens[i]!;
    if (known.has(heard.toLowerCase())) continue;
    const provider = all.find((t) => vocabulary.providers.includes(t.name) && soundKey(t.word) === soundKey(heard) && soundKey(heard).length >= 2);
    if (provider && !seen.has(provider.name)) {
      seen.add(provider.name);
      out.push({ heard: `doctor ${heard}`, meant: provider.name });
    }
  }
  for (const heard of candidates) {
    const lower = heard.toLowerCase();
    // Said as the call knows it, or part of something said that way: nothing to repair.
    if (known.has(lower) || heard.split(" ").some((w) => known.has(w.toLowerCase()))) continue;
    const key = soundKey(heard);
    if (key.length < 3) continue;
    // A provider's name only for a word said as a name (capitalised by the transcriber); "doctor Sean" is matched above.
    // ("the bottle" sounds like "Patel".)
    const asName = /^[A-Z]/.test(heard);
    const scored = all
      .filter((t) => asName || !vocabulary.providers.includes(t.name))
      .map((t) => {
        const score = alike(key, soundKey(t.word));
        const recent = recentlySaid(t.name, t.word, vocabulary.recent);
        // Outright, or close and the first sound the same and she just said it.
        const ok = score >= 0.99 || (score >= 0.8 && key[0] === soundKey(t.word)[0]) || (recent && score >= 0.5 && key[0] === soundKey(t.word)[0]);
        return { ...t, score: score + (recent ? 0.25 : 0), ok };
      })
      .filter((t) => t.ok && !said.has(t.word.toLowerCase()))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || seen.has(best.name)) continue;
    const second = scored.find((t) => t.name !== best.name);
    seen.add(best.name);
    out.push(second && Math.abs(second.score - best.score) < 0.05 ? { heard, options: [best.name, second.name] } : { heard, meant: best.name });
  }
  return out;
}

/** The turn's note for what was heard: take it as meant and carry on; either-or once when two are as close. */
export function soundAlikeNote(found: readonly SoundAlike[]): string | null {
  if (found.length === 0) return null;
  const lines = found.map((f) =>
    "meant" in f
      ? `They said "${f.heard}": that is ${f.meant}, misheard by the line. Answer about ${f.meant} as if they had said it, and never question the word or ask them to say it again.`
      : `They said "${f.heard}": that is ${f.options[0]} or ${f.options[1]}. Ask once which, in those words ("${f.options[0]} or ${f.options[1]}?"), and never ask them to say it again.`,
  );
  return lines.join(" ");
}
