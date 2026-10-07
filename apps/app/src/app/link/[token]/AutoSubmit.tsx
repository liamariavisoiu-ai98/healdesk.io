"use client";

import { useEffect } from "react";

/**
 * Submits the "Continue" form as soon as the page loads, for the one link that
 * may skip the click: the checkout link, which /welcome hands to the browser
 * that has just paid. Every emailed link keeps the button, because a mail
 * scanner opening it must not sign anyone in.
 */
export function AutoSubmit({ formId }: { formId: string }) {
  useEffect(() => {
    const form = document.getElementById(formId);
    if (form instanceof HTMLFormElement) form.requestSubmit();
  }, [formId]);
  return null;
}
