/**
 * The device a passkey is added on: what to call its screen lock, what to
 * suggest as its name, and which names are acceptable (plan Part D3).
 *
 * Pure, with no imports: the browser bundle reads it to word the page, and
 * db/schema.ts reads DEVICE_LABEL_MAX from it outside the app, the way it
 * reads lib/email/kinds.ts.
 */

/** The longest name a person may give a device. A CHECK on user_factors holds the same line. */
export const DEVICE_LABEL_MAX = 60;

export type DeviceKind =
  | "iphone"
  | "ipad"
  | "mac"
  | "android_phone"
  | "android_tablet"
  | "windows"
  | "chromebook"
  | "other";

/**
 * What the browser says it runs on. `maxTouchPoints` tells an iPad from a
 * Mac: iPadOS Safari reports itself as a Mac, and only the touch screen
 * gives it away.
 */
export function deviceKindFrom(input: {
  userAgent: string | null | undefined;
  maxTouchPoints?: number;
}): DeviceKind {
  const ua = input.userAgent ?? "";
  if (/iPhone|iPod/.test(ua)) return "iphone";
  if (/iPad/.test(ua)) return "ipad";
  if (/Macintosh|Mac OS X/.test(ua)) return (input.maxTouchPoints ?? 0) > 1 ? "ipad" : "mac";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "android_phone" : "android_tablet";
  if (/CrOS/.test(ua)) return "chromebook";
  if (/Windows/.test(ua)) return "windows";
  return "other";
}

/**
 * The words for the unlock the browser will ask for: Face ID on an iPhone or
 * iPad, Touch ID on a Mac, and on anything else the screen lock, which is
 * what Android, Windows Hello and ChromeOS all amount to.
 */
export function unlockWord(kind: DeviceKind): string {
  if (kind === "iphone" || kind === "ipad") return "Face ID";
  if (kind === "mac") return "Touch ID";
  return "this device's screen lock";
}

/**
 * The name suggested before the person types their own: the device type,
 * which they then make specific ("Maria's iPhone", "Front desk Mac").
 */
export function suggestedDeviceLabel(kind: DeviceKind): string {
  switch (kind) {
    case "iphone":
      return "iPhone";
    case "ipad":
      return "iPad";
    case "mac":
      return "Mac";
    case "android_phone":
      return "Android phone";
    case "android_tablet":
      return "Android tablet";
    case "windows":
      return "Windows PC";
    case "chromebook":
      return "Chromebook";
    case "other":
      return "This computer";
  }
}

export type DeviceLabelCheck =
  { ok: true; label: string } | { ok: false; reason: "empty" | "too_long" | "invalid" };

/**
 * Bidirectional overrides and isolates, and the marks that steer them: a name
 * carrying one can display as a different device's name in the access log.
 */
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/**
 * A device name as it will be stored and shown: trimmed, inner whitespace
 * collapsed, 1 to 60 characters counted as the database counts them (code
 * points, so an emoji is one), and no control or bidirectional character.
 * The CHECK on user_factors refuses whatever this lets through by mistake.
 */
export function validateDeviceLabel(raw: unknown): DeviceLabelCheck {
  if (typeof raw !== "string") return { ok: false, reason: "invalid" };
  if (CONTROL.test(raw.replace(/[\t\n\r]/g, " ")) || BIDI_CONTROLS.test(raw)) {
    return { ok: false, reason: "invalid" };
  }
  const label = raw.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (label.length === 0) return { ok: false, reason: "empty" };
  if ([...label].length > DEVICE_LABEL_MAX) return { ok: false, reason: "too_long" };
  return { ok: true, label };
}
