"use client";

import type { BillingInterval } from "@healdesk/catalog";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  CheckoutFlow,
  type CheckoutProgress,
  type State as CheckoutState,
} from "@/components/checkout/CheckoutFlow";
import { site } from "@/lib/site";

/**
 * The purchase flow, opened over whatever the visitor is already doing.
 *
 * ## Why this exists
 *
 * The homepage's argument is the live demo, and until now it had no path to
 * checkout at all. AYA's own prompt told her to point at a button that only
 * exists on /pricing. A prospect she had just convinced had to find the footer,
 * open another page, and start again. That is the widest leak in the funnel,
 * and it is a routing problem rather than a persuasion one.
 *
 * So the flow opens in place, triggered from the navbar and from inside each
 * demo panel, carrying what the demo already knows.
 *
 * ## Why a native <dialog>
 *
 * `showModal()` supplies the focus trap, the top layer, `::backdrop`, and
 * inert-ing the rest of the document, all of which a hand-rolled overlay gets
 * subtly wrong. What it does NOT supply, and what is handled below: the body
 * still scrolls behind it, backdrop clicks do nothing, and Escape closes
 * unconditionally.
 *
 * That last default is the dangerous one here. The buyer signs a legally
 * binding agreement at step 5, and until it is paired with a payment its id
 * lives only in the browser. Escape is a key people press to dismiss an
 * autocomplete dropdown, in a signature field, of all places. So dismissal is
 * refused from the moment a signature exists, and CheckoutFlow additionally
 * mirrors the agreement into sessionStorage so even a hard close can resume.
 *
 * ## Why the flow stays mounted
 *
 * Unmounting on close would reset a six-step form to step 1, so the dialog is
 * rendered once opened and then kept. A closed dialog is `display: none`, so
 * the cost is a hidden subtree, not a running one.
 */

export type BuyPrefill = {
  /** The specialty the visitor was demoing, so step 1 arrives answered. */
  specialty?: string;
  /** Captured by the chat gate, the best prefill available. */
  email?: string;
};

type BuyCtx = {
  open: (prefill?: BuyPrefill) => void;
};

const Ctx = createContext<BuyCtx | null>(null);

/** null outside a provider, every trigger falls back to its href. */
export function useBuy(): BuyCtx | null {
  return useContext(Ctx);
}

export function BuyModalProvider({
  children,
  initialPlan,
  initialInterval = "month",
}: {
  children: React.ReactNode;
  initialPlan: string;
  /** Monthly unless the page hosting the modal was opened on annual terms. */
  initialInterval?: BillingInterval;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Where focus returns on close. showModal does not restore it for us. */
  const openerRef = useRef<HTMLElement | null>(null);

  const [mounted, setMounted] = useState(false);
  /**
   * Mirrors `dialog.open` into React.
   *
   * The element is the source of truth. Escape and `close()` both bypass React
   * entirely, but the body scroll lock has to react to OPENING too, and a
   * dialog fires no event when it opens. So opening sets this directly and the
   * `close` listener clears it.
   */
  const [isOpen, setIsOpen] = useState(false);
  const [prefill, setPrefill] = useState<BuyPrefill>({});
  const [progress, setProgress] = useState<CheckoutProgress>({
    step: 1,
    signed: false,
    done: false,
  });

  /** Closing here would strand a signature no payment is attached to. */
  const locked = progress.signed && !progress.done;

  const open = useCallback((next?: BuyPrefill) => {
    openerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    // Seeds only the first mount. CheckoutFlow reads it in a lazy initialiser,
    // so reopening never overwrites a form the buyer has already filled in.
    if (next) setPrefill(next);
    setMounted(true);
    // The dialog element is rendered from the first paint, so this works even
    // on the very first open, before CheckoutFlow has mounted inside it.
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
    setIsOpen(true);
  }, []);

  const close = useCallback(() => {
    dialogRef.current?.close();
  }, []);

  // Escape and close() both bypass React, so the element tells us rather than
  // the other way round.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onClose = () => setIsOpen(false);
    dialog.addEventListener("close", onClose);
    return () => dialog.removeEventListener("close", onClose);
  }, []);

  // The body keeps scrolling behind an open modal, showModal inerts the page
  // but does not lock its scroll, and a background that slides under a fixed
  // dialog reads broken. Focus restoration is here too, because showModal does
  // not put it back either.
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

  // Each step starts at the top of its own screen. Without this, step 5 opens
  // scrolled to wherever step 4 was left, in the middle of the agreement.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [progress.step]);

  const value = useMemo(() => ({ open }), [open]);

  return (
    <Ctx.Provider value={value}>
      {children}

      <dialog
        ref={dialogRef}
        className="hd-modal"
        aria-label="Get started with healdesk"
        onCancel={(event) => {
          // Escape. The only place dismissal is refused.
          if (locked) event.preventDefault();
        }}
        onClick={(event) => {
          // A click on the backdrop reports the dialog itself as the target.
          if (event.target === dialogRef.current && !locked) close();
        }}
      >
        <div ref={scrollRef} className="hd-modal-scroll">
          {mounted ? (
            <CheckoutFlow
              initialPlan={initialPlan}
              initialInterval={initialInterval}
              initialState={prefillToState(prefill)}
              onClose={close}
              onProgress={setProgress}
              downloadHost={() => dialogRef.current}
            />
          ) : null}
        </div>
      </dialog>
    </Ctx.Provider>
  );
}

/**
 * Only two fields are carried in, and the omission is deliberate.
 *
 * The voice demo also collects a first name, and it is tempting to seed the
 * contact with it, but `contactName` becomes the buyer's typed signature on
 * the agreement, and "Alex" executed on a business associate contract is worse
 * than an empty field. It stays blank so the signature is entered on purpose.
 */
function prefillToState(prefill: BuyPrefill): Partial<CheckoutState> {
  const seed: Partial<CheckoutState> = {};
  if (prefill.specialty) seed.specialty = prefill.specialty;
  if (prefill.email) seed.contactEmail = prefill.email;
  return seed;
}

/**
 * The primary call to action, everywhere it appears.
 *
 * One component so the navbar and both demo panels cannot drift apart on label,
 * behaviour, or what they hand through as prefill.
 */
export function BuyButton({
  className = "",
  label = site.cta.primary.label,
  prefill,
  variant = "solid",
}: {
  className?: string;
  label?: string;
  prefill?: BuyPrefill;
  variant?: "solid" | "quiet";
}) {
  const buy = useBuy();

  // Flat and rectangular, after jasper.ai: a solid red block and an outlined
  // quiet one, no gradient and no pill. The gradient pill it replaced was the
  // one element on the page still saying 2023.
  const styles =
    variant === "solid"
      ? "bg-red text-white hover:bg-red-deep"
      : "border-line-strong text-ink hover:border-ink border-[1.5px] bg-white";

  const classes = [
    "inline-flex items-center justify-center gap-2 rounded-[6px] px-5 py-2.5 text-sm font-semibold transition-colors duration-200",
    styles,
    className,
  ].join(" ");

  if (!buy) {
    // No provider on this route: go to the standalone flow instead, so the
    // call to action is never dead.
    return (
      <a href={site.cta.primary.href} className={classes}>
        {label}
      </a>
    );
  }

  return (
    <button type="button" onClick={() => buy.open(prefill)} className={classes}>
      {label}
    </button>
  );
}
