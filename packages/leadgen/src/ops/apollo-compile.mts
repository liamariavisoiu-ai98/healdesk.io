/**
 * Compile several Apollo exports into one file, with a specialty and a top
 * service for every contact.
 *
 *   npx tsx src/ops/apollo-compile.mts <out.csv> <apollo.csv> [more.csv ...] [--previous all-leads.csv]
 *
 * Apollo exports of one search overlap: the same contact appears in more than
 * one file. This keeps one row per email address (the fullest copy), drops
 * rows that have no email, and adds columns at the front:
 *
 *   specialty         what the practice does, e.g. "Plastic & cosmetic surgery"
 *   top_service       the service people most often ask that specialty about,
 *                     by common sense and not by scraping (specialty.ts)
 *   segment           the pipeline's closed vocabulary, so a row can go straight
 *                     into `npm run enrich`
 *   specialty_basis   what decided it: title, company name, keywords, or nothing
 *   already_in_list   "yes" when --previous is given and the address is in it
 *   size_flag         500 or more employees: probably a chain or health system
 *
 * Nothing is fetched. Every original Apollo column is kept as it was.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { guessSpecialty } from "../enrich/specialty.ts";

type Row = Record<string, string>;

function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.length)) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const header = (rows.shift() ?? []).map((h) => h.replace(/^﻿/, "").trim());
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

function toCsv(rows: Row[]): string {
  const header = Object.keys(rows[0] ?? {});
  const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [header.join(","), ...rows.map((r) => header.map((h) => esc(r[h] ?? "")).join(","))].join("\n") + "\n";
}

const args = process.argv.slice(2);
const prevAt = args.indexOf("--previous");
const previousPath = prevAt >= 0 ? args.splice(prevAt, 2)[1] : undefined;
const [out, ...inputs] = args;
if (!out || inputs.length === 0) {
  console.error("usage: npx tsx src/ops/apollo-compile.mts <out.csv> <apollo.csv> [more.csv ...] [--previous all-leads.csv]");
  process.exit(1);
}

const previous = new Set<string>();
if (previousPath) {
  for (const r of parseCsv(readFileSync(previousPath, "utf8"))) if (r.email) previous.add(r.email.toLowerCase());
}

const fullness = (r: Row) => Object.values(r).filter(Boolean).length;
const byEmail = new Map<string, Row>();
let read = 0;
let noEmail = 0;
for (const file of inputs) {
  for (const r of parseCsv(readFileSync(file, "utf8"))) {
    read += 1;
    const email = (r.Email ?? "").trim().toLowerCase();
    if (!email) { noEmail += 1; continue; }
    const held = byEmail.get(email);
    if (!held || fullness(r) > fullness(held)) byEmail.set(email, r);
  }
}

const compiled: Row[] = [];
for (const r of byEmail.values()) {
  const employees = Number(r["# Employees"]) || undefined;
  const g = guessSpecialty({ company: r["Company Name"] ?? "", title: r.Title ?? "", industry: r.Industry ?? "", keywords: r.Keywords ?? "", employees });
  compiled.push({
    specialty: g.label,
    top_service: g.topService,
    segment: g.segment,
    specialty_basis: g.basis,
    already_in_list: previous.has((r.Email ?? "").toLowerCase()) ? "yes" : "",
    // 500 or more employees is a chain or a health system, not an owner-run clinic.
    // The first list excluded chains, so this is flagged rather than guessed at.
    size_flag: employees && employees >= 500 ? "500+ employees: likely a chain or health system" : "",
    ...r,
  });
}
// Clinics first, grouped by specialty; what is not a clinic or unclear last.
const tail = (r: Row) => (r.segment === "not-a-target" ? 2 : r.specialty === "Unclear: review" ? 1 : 0);
compiled.sort((a, b) => tail(a) - tail(b) || a.specialty!.localeCompare(b.specialty!) || (a["Company Name"] ?? "").localeCompare(b["Company Name"] ?? ""));

writeFileSync(out, toCsv(compiled));
const counts = new Map<string, number>();
for (const r of compiled) counts.set(r.specialty!, (counts.get(r.specialty!) ?? 0) + 1);
console.log(`read ${read} rows from ${inputs.length} files; ${noEmail} had no email; ${compiled.length} contacts after removing copies`);
for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
