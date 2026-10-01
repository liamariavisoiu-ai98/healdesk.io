"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { CitySelect } from "@/components/CitySelect";
import { site } from "@/lib/site";

/**
 * "Leave a review", a small control under the homepage FAQ, and the form it
 * opens.
 *
 * ## It used to be a panel, twice
 *
 * First a card in the bento, then a full-width orange banner carrying the
 * niche deck's circle-flood. Both were too loud for what they are: an invitation
 * aimed at the small minority of visitors who are already customers. It is a
 * two-line text control now. The review wall it once sat beside was
 * placeholder content and is gone (src/lib/reviews.ts); this control is what
 * collects the real ones. Its natural home later is the clinic portal, for a
 * signed-in owner.
 *
 * ## Why the customer ID is asked for, and what it is not
 *
 * A review wall that anyone can post to is a spam target and, worse, a place
 * where a competitor can put words in a customer's mouth. So the form asks for
 * the customer ID on the account and /api/reviews checks it against the product
 * database before accepting anything.
 *
 * It is a check, not a login: this form lives on the marketing site, which has
 * no session of its own. (Clinics do sign in, to the clinic portal in apps/app;
 * that is a different surface.) Getting the ID wrong is a field-level error on
 * the form, not a security event.
 *
 * ## Why a review does not appear on the page when it is submitted
 *
 * It goes to us to be read first. Testimonials carry a named person's words and
 * face, and self-publishing them the moment a form is posted means the first
 * time anyone at healdesk sees a review is after a stranger has. The form says
 * so plainly rather than implying it went live.
 */

const STAR_PATH =
  "M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z";

/** Longest side of the portrait we keep, in pixels. */
const PHOTO_SIZE = 320;

/** Refused before it is decoded. A phone camera file clears this easily. */
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

const MAX_REVIEW_CHARS = 2_000;

type Status = "idle" | "sending" | "sent";

export function LeaveReview() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  /** Where focus goes back to. showModal does not restore it. */
  const openerRef = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMounted(true);
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
    setIsOpen(true);
  }, []);

  const close = useCallback(() => dialogRef.current?.close(), []);

  // Escape and close() both bypass React, so the element reports rather than
  // the other way round. Same arrangement as BuyModal.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onClose = () => setIsOpen(false);
    dialog.addEventListener("close", onClose);
    return () => dialog.removeEventListener("close", onClose);
  }, []);

  // showModal inerts the page but leaves it scrolling behind the dialog.
  useEffect(() => {
    if (isOpen) {
      const previous = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = previous;
      };
    }
    openerRef.current?.focus();
    return undefined;
  }, [isOpen]);

  return (
    <>
      {/*
        An inline control, not a panel.

        It was a full-width orange banner with the circle-flood on it, which at
        1128 by 170 was the largest thing in its section. The flood went with
        the background: there is nothing left to flood. What remains is the
        arrow, which slides on hover, and that is the right amount of movement
        for a link.
      */}
      <button
        type="button"
        onClick={open}
        className="group text-left"
      >
        <span className="text-muted block text-xs font-bold tracking-[0.14em] uppercase">
          Already a customer?
        </span>
        <span className="text-red-deep group-hover:text-red font-display mt-1.5 flex items-center gap-1.5 text-[22.8px] leading-tight font-medium tracking-[-0.02em] transition-colors">
          Leave a review
          <svg
            viewBox="0 0 24 24"
            aria-hidden
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-[13px] transition-transform duration-200 ease-out group-hover:translate-x-1"
          >
            <path d="m9 6 6 6-6 6" />
          </svg>
        </span>
      </button>

      <dialog
        ref={dialogRef}
        className="hd-modal"
        aria-label="Leave a review"
        onClick={(event) => {
          // A backdrop click reports the dialog itself as the target.
          if (event.target === dialogRef.current) close();
        }}
      >
        <div className="hd-modal-scroll">
          {/* Kept mounted once opened, so a mis-click on the backdrop does not
              throw away a review somebody has half written. */}
          {mounted ? <ReviewForm onClose={close} /> : null}
        </div>
      </dialog>
    </>
  );
}

/**
 * Centre-crop to a square and re-encode small.
 *
 * The portrait is sent inside the JSON body rather than to a separate upload
 * endpoint, so its size is the whole design constraint: 320px of JPEG at 0.82
 * lands around 30KB, which survives base64 and a request body limit with room
 * to spare, and is still twice the resolution the wall renders it at.
 *
 * `imageOrientation: "from-image"` is not optional. Phone cameras record
 * rotation in EXIF rather than in the pixels, and a canvas draws the pixels, so
 * without it every portrait taken in portrait arrives on its side.
 */
async function toSquareJpeg(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const side = Math.min(bitmap.width, bitmap.height);

  const canvas = document.createElement("canvas");
  canvas.width = PHOTO_SIZE;
  canvas.height = PHOTO_SIZE;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D context.");

  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    PHOTO_SIZE,
    PHOTO_SIZE,
  );
  bitmap.close();

  return canvas.toDataURL("image/jpeg", 0.82);
}

function ReviewForm({ onClose }: { onClose: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);

  const [rating, setRating] = useState(0);
  /** What the pointer is currently over, so the row previews the click. */
  const [hovered, setHovered] = useState(0);
  const [photo, setPhoto] = useState<string | null>(null);
  const [body, setBody] = useState("");
  /*
   * Controlled, like the body, and for the same reason: closing the section
   * unmounts these inputs, and an uncontrolled input that unmounts takes its
   * value with it. "Closing is not discarding" has to be true of every field
   * in there, not just the ones that happened to be wired up.
   */
  const [title, setTitle] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  /** Owned here rather than in CitySelect: picking a town sets both. */
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  /**
   * Whether the reviewer has opened the writing half of the form.
   *
   * Closed, this is three fields and a rating. Open, it is the whole thing and
   * the headline and the review become required, because somebody who has said
   * yes to writing a review has agreed to write one.
   */
  const [expanded, setExpanded] = useState(false);

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  /** Which input the error belongs to, so it can be marked and focused. */
  const [errorField, setErrorField] = useState<string | null>(null);

  const pickPhoto = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared immediately so choosing the same file twice still fires change.
    event.target.value = "";
    if (!file) return;

    if (file.size > MAX_UPLOAD_BYTES) {
      setError("That image is too large. Anything under 12MB is fine.");
      setErrorField("photo");
      return;
    }

    try {
      setPhoto(await toSquareJpeg(file));
      setError(null);
      setErrorField(null);
    } catch {
      setError("We couldn't read that image. A JPEG or PNG should work.");
      setErrorField("photo");
    }
  }, []);

  /**
   * Shut the section without touching what is in it.
   *
   * Closing is not discarding. The chevron is a big target next to a heading
   * and it will get hit by accident, and losing four fields to a stray click
   * is the kind of thing people do not forgive a form for. What was typed
   * survives, reopening brings it back, and nothing hidden is ever submitted:
   * `submit` only reads these fields while the section is open, and the
   * primary button relabels to say so.
   */
  const close = useCallback(() => {
    setExpanded(false);
    setError(null);
    setErrorField(null);
  }, []);

  /** The destructive one, and it says so. Only reachable inside the section. */
  const clear = useCallback(() => {
    setExpanded(false);
    setCity("");
    setState("");
    setBody("");
    setTitle("");
    setJobTitle("");
    setPhoto(null);
    setError(null);
    setErrorField(null);
  }, []);

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);

      if (rating === 0) {
        setError("Pick a rating first.");
        setErrorField("rating");
        return;
      }

      // The contract the disclosure sets: open it and you are writing a
      // review, so it needs a headline and some words. Leave it closed and a
      // rating on its own is a complete submission.
      if (expanded) {
        if (!title.trim()) {
          setError("Give your review a title.");
          setErrorField("title");
          return;
        }
        if (!String(data.get("body") ?? "").trim()) {
          setError("Write a line or two, or close this section.");
          setErrorField("body");
          return;
        }
      }

      setStatus("sending");
      setError(null);
      setErrorField(null);

      try {
        const response = await fetch("/api/reviews", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: data.get("name"),
            customerId: data.get("customerId"),
            // Gated on `expanded` rather than on the DOM. `city` and `state`
            // are React state, so they survive a close and would otherwise be
            // posted from a section the reviewer has shut.
            title: expanded ? title : "",
            jobTitle: expanded ? jobTitle : "",
            city: expanded ? city : "",
            state: expanded ? state : "",
            rating,
            body: data.get("body"),
            photo,
            website: data.get("website"),
          }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as
            | { error?: string; field?: string }
            | null;
          setError(payload?.error ?? "Something went wrong. Try again.");
          setErrorField(payload?.field ?? null);
          setStatus("idle");
          return;
        }

        setStatus("sent");
      } catch {
        setError(`Network error. Email ${site.email} instead.`);
        setErrorField(null);
        setStatus("idle");
      }
    },
    [city, expanded, jobTitle, photo, rating, state, title],
  );

  if (status === "sent") {
    return (
      <div className="mx-auto max-w-[560px] py-6 text-center">
        <span
          aria-hidden
          className="bg-mint text-ink mx-auto grid size-14 place-items-center rounded-full text-[28.8px] leading-none font-bold"
        >
          ✓
        </span>
        <h2 className="font-display mt-6 text-[31.2px] leading-tight font-medium tracking-[-0.02em]">
          Thank you. That means a lot.
        </h2>
        <p className="text-muted mx-auto mt-3 max-w-[42ch] text-[18px] leading-[1.55] font-medium">
          A person reads every review before it goes on the site, so give us a day or
          two. If we need to check anything with you first, we&apos;ll get in touch.
        </p>
        <button
          type="button"
          onClick={onClose}
          className="bg-brand-gradient shadow-brand mt-7 rounded-full px-8 py-3.5 text-[18px] font-bold text-white transition-transform duration-200 hover:-translate-y-px"
        >
          Close
        </button>
      </div>
    );
  }

  const shown = hovered || rating;

  return (
    <form onSubmit={submit} className="mx-auto max-w-[560px]">
      <div className="text-center">
        {/*
          `text-orange-deep`, not `text-orange`. Brand orange measures 2.67:1 on
          this ground, which fails even the 3:1 bar that large text gets, so
          there is no size at which the logo value is safe as type. See the
          token in globals.css. This heading never drops below 24px, which is
          the condition the darkened one clears.
        */}
        <h2 className="font-display text-orange-deep text-[clamp(28.8px,4.08vw,38.4px)] leading-[1.08] font-medium tracking-[-0.025em]">
          Tell another clinic what we were like
        </h2>
      </div>

      <fieldset
        className="mt-8"
        onMouseLeave={() => setHovered(0)}
        aria-describedby={errorField === "rating" ? "review-error" : undefined}
      >
        <legend className="text-[15.6px] font-bold">
          Your rating <Required />
        </legend>
        <div className="mt-2.5 flex items-center gap-1.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <label
              key={n}
              onMouseEnter={() => setHovered(n)}
              className="cursor-pointer"
              // The native radio underneath supplies arrow-key movement, the
              // group name and the announcement. Only the glyph is ours.
            >
              <input
                type="radio"
                name="rating"
                value={n}
                checked={rating === n}
                onChange={() => setRating(n)}
                aria-label={`${n} star${n === 1 ? "" : "s"}`}
                className="peer sr-only"
              />
              <svg
                viewBox="0 0 24 24"
                aria-hidden
                className={[
                  "size-8 transition-[fill,transform] duration-150 ease-out",
                  "peer-focus-visible:outline-orange peer-focus-visible:rounded-sm peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2",
                  n <= shown ? "fill-sun" : "fill-line-strong",
                  n <= hovered ? "scale-110" : "scale-100",
                ].join(" ")}
              >
                <path d={STAR_PATH} />
              </svg>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-6 grid gap-2.5 sm:grid-cols-2">
        <Field
          name="name"
          label="Your name"
          placeholder="Jane D."
          autoComplete="name"
          required
          maxLength={120}
        />
        <Field
          name="customerId"
          label="Customer ID"
          placeholder="XX-XXX-XXXX"
          required
          maxLength={120}
          invalid={errorField === "customerId"}
        />
      </div>

      {/*
        Everything past the customer ID lives behind this.

        Three fields is a form somebody finishes. Eight is a form somebody
        abandons, and most of those eight only matter to the minority who
        actually want to write something. So the short version is the default
        and the rest is one question away, with the underline drawing itself
        three times so the question is not missed.

        Opening it changes the contract: a reader who says yes to writing a
        review is asked for a headline and a review, both of them required.
        Closing it puts the contract back and empties the fields, so a
        half-answered section cannot be submitted from behind a closed door.
      */}
      <div className="border-line mt-7 border-t pt-6">
        {/*
          The question stays put whether the section is open or shut, and the
          chevron says which. It used to be replaced by the fields entirely,
          so opening the disclosure deleted the thing that explained it and
          left a run of unexplained inputs with no way back up.
        */}
        <button
          type="button"
          onClick={() => (expanded ? close() : setExpanded(true))}
          aria-expanded={expanded}
          aria-controls="review-details"
          className="share-toggle group flex w-full items-center justify-between gap-4 text-left"
        >
          <span>
            <span className="font-display text-orange-deep block text-[22.8px] leading-tight font-medium tracking-[-0.02em]">
              Would you like to share your experience?
            </span>
            <span className="text-muted mt-1 block text-[15px] font-medium">
              {expanded
                ? "A headline and a few words. Both are needed to publish it."
                : "Add a headline and a few words. It takes a minute."}
            </span>
          </span>

          {/* The homepage's chevron, pointing down until it is open. */}
          <svg
            viewBox="0 0 24 24"
            aria-hidden
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="share-chevron text-red-deep group-hover:text-red size-[17px] shrink-0 transition-colors"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        {expanded ? (
          <div id="review-details" className="share-reveal mt-6">
            <Field
              name="jobTitle"
              label="Job title"
              optional
              placeholder="Office Manager"
              autoComplete="organization-title"
              maxLength={60}
              value={jobTitle}
              onValue={setJobTitle}
            />

            <div className="mt-6">
              <CitySelect city={city} state={state} onCity={setCity} onState={setState} />
            </div>

            <div className="mt-6">
              <Field
                name="title"
                label="Review title"
                required
                placeholder="Worth every penny"
                maxLength={40}
                invalid={errorField === "title"}
                value={title}
                onValue={setTitle}
              />
            </div>

            <div className="mt-6">
              <label htmlFor="review-body" className="block text-[15.6px] font-bold">
                Write a review <Required />
              </label>
              <textarea
                id="review-body"
                name="body"
                rows={6}
                maxLength={MAX_REVIEW_CHARS}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder="What changed at your front desk?"
                aria-invalid={errorField === "body" || undefined}
                className="border-line focus:border-orange text-ink placeholder:text-muted mt-2 w-full resize-y rounded-xl border px-4 py-3 text-[17.4px] leading-[1.55] outline-none transition-colors"
              />
              <p className="text-muted mt-1.5 text-right text-[14.4px] font-medium tabular-nums">
                {body.length} / {MAX_REVIEW_CHARS}
              </p>
            </div>

            <div className="border-line mt-4 flex items-center gap-4 rounded-xl border border-dashed p-4">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                aria-label={photo ? "Replace your photo" : "Add a photo from your device"}
                className="border-line hover:border-ink grid size-14 shrink-0 place-items-center overflow-hidden rounded-full border transition-colors"
              >
                {photo ? (
                  <img src={photo} alt="" className="size-full object-cover" />
                ) : (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                    className="text-muted size-6"
                  >
                    <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.2a1.5 1.5 0 0 0 1.28-.72l.62-1.03A1.5 1.5 0 0 1 9.88 3.5h4.24a1.5 1.5 0 0 1 1.28.75l.62 1.03A1.5 1.5 0 0 0 17.3 6h1.2A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" />
                    <circle cx="12" cy="12.8" r="3.4" />
                  </svg>
                )}
              </button>

              <div className="min-w-0 flex-1">
                <p className="text-[15.6px] font-bold">
                  Add a photo <span className="text-muted font-medium">(optional)</span>
                </p>
                <p className="text-muted mt-0.5 text-[15px] leading-snug font-medium">
                  {photo
                    ? "Tap the picture to choose a different one."
                    : "A face makes a review land harder."}
                </p>
              </div>

              {photo ? (
                <button
                  type="button"
                  onClick={() => setPhoto(null)}
                  className="text-muted hover:text-ink shrink-0 text-[15.6px] font-bold transition-colors"
                >
                  Remove
                </button>
              ) : null}

              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                onChange={pickPhoto}
                className="sr-only"
              />
            </div>

            <div className="flex justify-end pt-1">
              {/*
                Bottom right of the section it empties, which is where a
                destructive utility belongs: out of the reading path, next to
                the thing it acts on, and nowhere near the submit button. It
                used to sit bottom left labelled "Never mind", where it read as
                the cancel half of a pair with Submit and invited people to
                leave the form entirely.
              */}
              <button
                type="button"
                onClick={clear}
                className="text-muted hover:text-red-deep text-[15px] font-bold transition-colors"
              >
                Clear and close
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Honeypot, same treatment as the contact form: off-screen rather than
          display:none, out of the tab order, hidden from assistive tech. */}
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden
        className="absolute left-[-9999px] size-px opacity-0"
      />

      {error ? (
        <p id="review-error" role="alert" className="text-red-deep mt-4 text-[15.6px] font-semibold">
          {error}
        </p>
      ) : null}

      {/* Says exactly what goes on the page, because what goes on the page is
          less than people expect: a first name and an initial, a job title and
          a city. The wall carries no surnames and no specialty, so promising
          more here would be promising something the section cannot show. */}
      <p className="text-muted mt-5 text-[15px] leading-[1.5] font-medium">
        We only publish your first name, your surname initial, and your photo if
        you added one. Your surname and customer ID remain private. Upon
        submission, someone from our team will proof-read the review for privacy
        before it gets published.
      </p>

      <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={onClose}
          className="text-muted hover:text-ink px-2 py-3 text-[16.8px] font-bold transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={status === "sending"}
          className="bg-brand-gradient shadow-brand flex-1 rounded-full px-6 py-3.5 text-[18px] font-bold text-white transition-transform duration-200 hover:-translate-y-px disabled:translate-y-0 disabled:opacity-50"
        >
          {status === "sending"
            ? "Sending…"
            : expanded
              ? "Submit review"
              : "Submit rating"}
        </button>
      </div>
    </form>
  );
}

/**
 * The mark on a required label.
 *
 * An asterisk and nothing else on screen, with the word supplied to screen
 * readers: a bare "*" is announced as "star" or skipped entirely depending on
 * the reader, which tells a blind user nothing about what the form will refuse.
 * The inputs still carry `required`, so this is the visible half of a fact the
 * browser already knows.
 */
function Required() {
  return (
    <span className="text-red-deep font-bold">
      <span aria-hidden>*</span>
      <span className="sr-only"> (required)</span>
    </span>
  );
}

function Field({
  name,
  label,
  placeholder,
  autoComplete,
  required,
  optional,
  maxLength,
  invalid,
  value,
  onValue,
}: {
  name: string;
  label: string;
  placeholder: string;
  autoComplete?: string;
  required?: boolean;
  /** Says so in the label, the way the review box does. */
  optional?: boolean;
  maxLength?: number;
  invalid?: boolean;
  /** Supply both to make the field controlled, so its value outlives unmount. */
  value?: string;
  onValue?: (next: string) => void;
}) {
  const id = `review-${name}`;

  return (
    <div>
      <label htmlFor={id} className="block text-[15.6px] font-bold">
        {label} {required ? <Required /> : null}
        {optional ? <span className="text-muted font-medium">(optional)</span> : null}
      </label>
      <input
        id={id}
        name={name}
        type="text"
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={required}
        maxLength={maxLength}
        {...(onValue ? { value: value ?? "", onChange: (e) => onValue(e.target.value) } : {})}
        aria-invalid={invalid || undefined}
        className={[
          "text-ink placeholder:text-muted mt-2 w-full rounded-xl border px-4 py-3",
          "text-[17.4px] outline-none transition-colors focus:border-orange",
          invalid ? "border-red-deep" : "border-line",
        ].join(" ")}
      />
    </div>
  );
}
