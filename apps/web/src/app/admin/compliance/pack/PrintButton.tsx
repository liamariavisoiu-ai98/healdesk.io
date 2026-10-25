"use client";

/** Opens the browser's print dialogue for the pack page; hidden when printing. */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="no-print border-line-strong hover:border-ink inline-flex min-h-9 items-center rounded-full border px-4 py-1.5 text-sm font-bold transition-colors print:hidden"
    >
      Print
    </button>
  );
}
