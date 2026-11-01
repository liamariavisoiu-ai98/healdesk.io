"use client";

import { useId, useRef, useState } from "react";

import type { FileRow } from "@/lib/knowledge-file/proposals";
import { FILE_HEADER, FILE_LIMITS, FILE_REFUSAL_WORDS } from "@/lib/knowledge-file/shared";

import { useAnnounce } from "../feedback";
import { addKnowledgeFileAction } from "./actions";

/**
 * "Add from a file" on Your practice (portal redesign, owner, 1 November
 * 2026): choose a price list, a menu or an info sheet, see what AYA found
 * that the page doesn't say yet, and add what you want. Nothing changes until
 * Add. The file is posted as its own bytes to ./file/route.ts and kept
 * nowhere; a photo is made smaller here first, so a phone's camera picture
 * fits the 4 MB limit.
 */

const SECTION_WORDS: Readonly<Record<FileRow["section"], string>> = {
  prices: "Prices",
  hours: "Hours",
  policies: "Policies",
  quick_answers: "Quick answers",
};

const ACCEPT = "application/pdf,image/jpeg,image/png";
/** The longest side a photo is sent at: enough to read a printed menu. */
const PHOTO_MAX_SIDE = 2000;

type Stage =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "rows"; rows: FileRow[]; chosen: Set<string>; message: string }
  | { kind: "adding"; rows: FileRow[]; chosen: Set<string>; message: string }
  | { kind: "done"; message: string }
  | { kind: "problem"; message: string };

/** A photo redrawn at most PHOTO_MAX_SIDE on its longest side, as a JPEG; a PDF as it is. */
async function prepared(file: File): Promise<Blob> {
  if (file.type === "application/pdf") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= FILE_LIMITS.maxBytes) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob ?? file;
  } catch {
    return file;
  }
}

export function FileCard({ slug }: { slug: string }) {
  const announce = useAnnounce();
  const input = useRef<HTMLInputElement>(null);
  const statusId = useId();
  const [stage, setStage] = useState<Stage>({ kind: "idle" });

  async function read(file: File) {
    setStage({ kind: "reading" });
    const body = await prepared(file);
    if (body.size > FILE_LIMITS.maxBytes) {
      setStage({ kind: "problem", message: FILE_REFUSAL_WORDS.too_big });
      return;
    }
    try {
      const response = await fetch(`/c/${encodeURIComponent(slug)}/knowledge/file`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", [FILE_HEADER]: "1" },
        body,
        credentials: "same-origin",
      });
      const result = (await response.json()) as
        | { ok: true; rows: FileRow[]; message: string }
        | { ok: false; message: string };
      if (!result.ok) {
        setStage({ kind: "problem", message: result.message });
        return;
      }
      if (result.rows.length === 0) {
        setStage({ kind: "done", message: result.message });
        return;
      }
      setStage({
        kind: "rows",
        rows: result.rows,
        chosen: new Set(result.rows.map((r) => r.id)),
        message: result.message,
      });
    } catch {
      setStage({ kind: "problem", message: FILE_REFUSAL_WORDS.unavailable });
    } finally {
      if (input.current) input.current.value = "";
    }
  }

  async function add(rows: FileRow[], chosen: Set<string>, message: string) {
    const picked = rows.filter((r) => chosen.has(r.id));
    if (picked.length === 0) return;
    setStage({ kind: "adding", rows, chosen, message });
    try {
      const result = await addKnowledgeFileAction(slug, picked);
      if (!result.ok) {
        announce({ text: result.message, tone: "problem" });
        setStage({ kind: "rows", rows, chosen, message });
        return;
      }
      announce({ text: result.message, tone: "ok" });
      // The action revalidates this page, so the sections below show what was added.
      setStage({ kind: "done", message: result.message });
    } catch {
      announce({ text: "Something went wrong on our side. Try again in a moment.", tone: "problem" });
      setStage({ kind: "rows", rows, chosen, message });
    }
  }

  const busy = stage.kind === "reading" || stage.kind === "adding";

  return (
    <div className="grid gap-3 py-3">
      <p className="text-sm font-semibold">Leave out anything about a patient.</p>
      <div className="flex flex-wrap items-center gap-3">
        <label
          className={`bg-ink inline-flex min-h-11 cursor-pointer items-center rounded-full px-5 text-sm font-bold text-white ${
            busy ? "pointer-events-none opacity-50" : ""
          }`}
        >
          Choose a file
          <input
            ref={input}
            type="file"
            accept={ACCEPT}
            className="sr-only"
            disabled={busy}
            aria-describedby={statusId}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void read(file);
            }}
          />
        </label>
        <span className="text-muted text-sm">PDF, JPG or PNG, up to 4 MB.</span>
      </div>

      <div id={statusId} role="status" aria-live="polite" className="text-sm">
        {stage.kind === "reading" ? "AYA is reading your file. This takes a few seconds." : null}
        {stage.kind === "done" ? stage.message : null}
        {stage.kind === "problem" ? <span className="text-problem">{stage.message}</span> : null}
        {stage.kind === "rows" || stage.kind === "adding" ? stage.message : null}
      </div>

      {stage.kind === "rows" || stage.kind === "adding" ? (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void add(stage.rows, stage.chosen, stage.message);
          }}
        >
          <ul className="border-line divide-line divide-y rounded-md border bg-white">
            {stage.rows.map((row) => {
              const on = stage.chosen.has(row.id);
              return (
                <li key={row.id}>
                  <label className="flex min-h-11 cursor-pointer items-start gap-3 px-4 py-3">
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={busy}
                      className="mt-1 h-5 w-5 shrink-0"
                      onChange={() => {
                        const next = new Set(stage.chosen);
                        if (on) next.delete(row.id);
                        else next.add(row.id);
                        setStage({ ...stage, chosen: next });
                      }}
                    />
                    <span className="min-w-0">
                      <span className="text-muted block text-xs font-semibold tracking-wider uppercase">
                        {SECTION_WORDS[row.section]} · {row.kind === "new" ? "New" : "Different"}
                      </span>
                      <span className="block">{row.text}</span>
                      {row.was ? <span className="text-muted block text-sm">{row.was}</span> : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={busy || stage.chosen.size === 0}
              className="bg-ink min-h-11 rounded-full px-5 text-sm font-bold text-white disabled:opacity-50"
            >
              {stage.kind === "adding"
                ? "Adding…"
                : stage.chosen.size === stage.rows.length
                  ? "Add all"
                  : `Add ${stage.chosen.size}`}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setStage({ kind: "idle" })}
              className="border-line min-h-11 rounded-full border bg-white px-5 text-sm font-semibold disabled:opacity-50"
            >
              Skip these
            </button>
          </div>
          <p className="text-muted text-sm">Untick anything you don&rsquo;t want. Nothing changes until you add it.</p>
        </form>
      ) : null}
    </div>
  );
}
