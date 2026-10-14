/**
 * The two hard navigations PatientPageGuard makes, in a module of their own
 * so a test can watch them. Both load a document from the server: a patient
 * page's payload leaves the browser's memory with the old one, which a
 * client-side navigation or router.refresh() would not guarantee.
 */

/**
 * Leave a patient page for the step-up page. `replace`, so the page's history
 * entry is gone: Back does not return to it, and the browser's back-forward
 * cache has nothing of it to restore.
 */
export function leavePatientPage(url: string): void {
  window.location.replace(url);
}

/** Load this page again from the server, which checks the step-up and logs the open again. */
export function reloadPatientPage(): void {
  window.location.reload();
}
