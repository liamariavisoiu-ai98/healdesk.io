"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { US_STATES, loadCities, type CitiesByState } from "@/lib/us-places";

/**
 * City and state, for the review form.
 *
 * ## Why this is not a <select>
 *
 * There are 32,000 places in the United States. A select with 32,000 options
 * takes seconds to open in Safari and is unusable with a thumb; a datalist is
 * not much better and gives no control over what is shown. So: a text input
 * that filters as you type, showing at most eight matches, backed by the full
 * list in memory. The DOM stays at nine nodes no matter how big the data gets.
 *
 * ## Why the list is not loaded until you open the dialog
 *
 * It is around 130KB gzipped. `loadCities()` is a dynamic import fired on
 * mount, which is the first time the dialog is opened and not before, so the
 * homepage bundle is unchanged and a visitor who never leaves a review never
 * downloads a single byte of it. Until it lands the field still works: you can
 * type a town and pick a state by hand, and nothing is blocked on the fetch.
 *
 * ## "Other" is a real answer, and it is first
 *
 * A clinic in a town of four thousand is identifiable from its town and its
 * discipline together, and some reviewers will not want to be. "Other" clears
 * the town and leaves the state, which is why several of the published cards
 * read "Owner, Colorado" rather than naming a place. It sits at the top of the
 * list rather than the bottom, because a reader looking for it is looking for
 * a way out and should not have to scroll a filtered list to find one.
 *
 * ## The state is filled in, not locked
 *
 * Picking a town sets the state beside it, since a town knows what state it is
 * in. It stays a normal select afterwards: the list has duplicates across
 * states (there are eleven Springfields), and the person filling the form is a
 * better judge of which one they meant than a first match is.
 */

/** More than this and the list stops being scannable. */
const MAX_MATCHES = 8;

export function CitySelect({
  city,
  state,
  onCity,
  onState,
}: {
  city: string;
  state: string;
  onCity: (value: string) => void;
  onState: (value: string) => void;
}) {
  const [cities, setCities] = useState<CitiesByState | null>(null);
  const [open, setOpen] = useState(false);
  /** Which row the keyboard is on. -1 is "Other". */
  const [cursor, setCursor] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    // A failure here is survivable, so it is swallowed: the field degrades to
    // a plain text input and a state picker, which is the whole job anyway.
    loadCities()
      .then((data) => live && setCities(data))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  /**
   * Every place, flattened once, as "Town|ST".
   *
   * Built when the data lands rather than on each keystroke: 32,000 strings is
   * nothing to hold and a great deal to rebuild sixty times a second.
   */
  const all = useMemo(() => {
    if (!cities) return [] as { city: string; state: string }[];
    return Object.entries(cities).flatMap(([code, names]) =>
      names.map((name) => ({ city: name, state: code })),
    );
  }, [cities]);

  const matches = useMemo(() => {
    const term = city.trim().toLowerCase();
    if (term.length < 2) return [];

    // Prefix matches first, then anything containing the term. Typing "port"
    // should offer Portland before Newport, which a plain filter does not do.
    const starts: typeof all = [];
    const contains: typeof all = [];
    for (const place of all) {
      const name = place.city.toLowerCase();
      if (name.startsWith(term)) starts.push(place);
      else if (name.includes(term)) contains.push(place);
      if (starts.length >= MAX_MATCHES) break;
    }
    return [...starts, ...contains].slice(0, MAX_MATCHES);
  }, [all, city]);

  // A click anywhere else closes the list. Pointerdown rather than click, so
  // it fires before focus moves and the list is gone by the time it does.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const choose = (index: number) => {
    if (index < 0) {
      // "Other": no town, keep whatever state is set, and let them change it.
      onCity("");
    } else {
      const place = matches[index];
      if (!place) return;
      onCity(place.city);
      onState(place.state);
    }
    setOpen(false);
    setCursor(-1);
  };

  const rows = matches.length + 1; // the matches, plus "Other"

  return (
    <div className="grid gap-2.5 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div ref={boxRef} className="relative">
        <label htmlFor="review-city" className="block text-[15.6px] font-bold">
          City <span className="text-muted font-medium">(optional)</span>
        </label>
        <input
          id="review-city"
          name="city"
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls="review-city-list"
          aria-autocomplete="list"
          autoComplete="off"
          placeholder="Start typing"
          value={city}
          maxLength={80}
          onChange={(event) => {
            onCity(event.target.value);
            setOpen(true);
            setCursor(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              return;
            }
            if (event.key === "Enter" && open) {
              event.preventDefault();
              choose(cursor);
              return;
            }
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            setOpen(true);
            // Wraps through "Other" at -1, so the escape hatch is one press up
            // from the top of the list rather than a scroll away.
            setCursor((current) => {
              const next = current + (event.key === "ArrowDown" ? 1 : -1);
              if (next >= matches.length) return -1;
              if (next < -1) return matches.length - 1;
              return next;
            });
          }}
          className="border-line focus:border-orange text-ink placeholder:text-muted mt-2 w-full rounded-xl border px-4 py-3 text-[17.4px] outline-none transition-colors"
        />

        {open && rows > 0 ? (
          <ul
            id="review-city-list"
            role="listbox"
            className="border-line absolute z-20 mt-1 max-h-[268px] w-full overflow-auto rounded-xl border bg-white py-1 shadow-[0_18px_40px_-16px_rgb(23_42_58/0.35)]"
          >
            <li
              role="option"
              aria-selected={cursor === -1}
              onPointerDown={(event) => {
                event.preventDefault();
                choose(-1);
              }}
              className={[
                "border-line text-muted cursor-pointer border-b px-4 py-2.5 text-[15.6px] font-bold",
                cursor === -1 ? "bg-paper-2" : "",
              ].join(" ")}
            >
              Other
              <span className="text-muted ml-1.5 font-medium">
                (just show my state)
              </span>
            </li>

            {matches.map((place, index) => (
              <li
                key={`${place.city}-${place.state}`}
                role="option"
                aria-selected={cursor === index}
                onPointerDown={(event) => {
                  event.preventDefault();
                  choose(index);
                }}
                className={[
                  "flex cursor-pointer items-baseline justify-between gap-3 px-4 py-2.5 text-[16.8px]",
                  cursor === index ? "bg-paper-2" : "",
                ].join(" ")}
              >
                <span>{place.city}</span>
                <span className="text-muted text-[14.4px] font-bold">{place.state}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div>
        <label htmlFor="review-state" className="block text-[15.6px] font-bold">
          State
        </label>
        <select
          id="review-state"
          name="state"
          required
          value={state}
          onChange={(event) => onState(event.target.value)}
          className="border-line focus:border-orange text-ink mt-2 w-full rounded-xl border bg-white px-4 py-3 text-[17.4px] outline-none transition-colors"
        >
          <option value="">Choose</option>
          {/* The code, not the name: it is what the published card shows, so
              the picker should not promise something the card will not print. */}
          {US_STATES.map((option) => (
            <option key={option.code} value={option.code} title={option.name}>
              {option.code}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
