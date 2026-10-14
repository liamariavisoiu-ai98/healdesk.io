/**
 * Hand the browser an export as a file. The export arrives as the server
 * action's answer, behind the step-up; this saves it under the name the
 * server chose, which carries the clinic's slug or a time, never a person.
 * Browser only.
 */
export function downloadJson(filename: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Long enough for the browser to start the save; the object is the export, so it goes after.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
