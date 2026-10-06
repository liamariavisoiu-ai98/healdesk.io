import { describe, expect, test } from "vitest";

import {
  deviceKindFrom,
  suggestedDeviceLabel,
  unlockWord,
  validateDeviceLabel,
} from "@/lib/factors/device";

/**
 * The device a passkey is added on (plan Part D3): the page's wording follows
 * it ("use Face ID" on an iPhone or iPad, Touch ID on a Mac, the screen lock
 * elsewhere), the suggested name is its type, and the name the person types
 * is kept within what the access log can show honestly.
 */

const UA = {
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  ipadClassic:
    "Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  android:
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  androidTablet:
    "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  chromebook:
    "Mozilla/5.0 (X11; CrOS x86_64 16093.68.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0",
};

describe("the device, its unlock and its suggested name", () => {
  test("each device is recognised, and an iPad that says it is a Mac is told by its touch screen", () => {
    expect(deviceKindFrom({ userAgent: UA.iphone })).toBe("iphone");
    expect(deviceKindFrom({ userAgent: UA.ipadClassic })).toBe("ipad");
    expect(deviceKindFrom({ userAgent: UA.mac })).toBe("mac");
    expect(deviceKindFrom({ userAgent: UA.mac, maxTouchPoints: 5 })).toBe("ipad");
    expect(deviceKindFrom({ userAgent: UA.android })).toBe("android_phone");
    expect(deviceKindFrom({ userAgent: UA.androidTablet })).toBe("android_tablet");
    expect(deviceKindFrom({ userAgent: UA.windows })).toBe("windows");
    expect(deviceKindFrom({ userAgent: UA.chromebook })).toBe("chromebook");
    expect(deviceKindFrom({ userAgent: UA.linux })).toBe("other");
    expect(deviceKindFrom({ userAgent: null })).toBe("other");
  });

  test("Face ID on iPhone and iPad, Touch ID on a Mac, the screen lock otherwise", () => {
    expect(unlockWord("iphone")).toBe("Face ID");
    expect(unlockWord("ipad")).toBe("Face ID");
    expect(unlockWord("mac")).toBe("Touch ID");
    for (const kind of [
      "android_phone",
      "android_tablet",
      "windows",
      "chromebook",
      "other",
    ] as const) {
      expect(unlockWord(kind)).toBe("this device's screen lock");
    }
  });

  test("the suggestion is the device's type, which the person then makes their own", () => {
    expect(suggestedDeviceLabel("iphone")).toBe("iPhone");
    expect(suggestedDeviceLabel("mac")).toBe("Mac");
    expect(suggestedDeviceLabel("windows")).toBe("Windows PC");
  });
});

describe("a device's name", () => {
  test("is trimmed and its spaces collapsed, up to sixty characters counted as people count them", () => {
    expect(validateDeviceLabel("  Front   desk\tMac ")).toEqual({
      ok: true,
      label: "Front desk Mac",
    });
    expect(validateDeviceLabel("Maria's iPhone")).toEqual({ ok: true, label: "Maria's iPhone" });
    // Sixty emoji are sixty characters to Postgres, a hundred and twenty to JavaScript.
    expect(validateDeviceLabel("📱".repeat(60))).toMatchObject({ ok: true });
    expect(validateDeviceLabel("x".repeat(61))).toEqual({ ok: false, reason: "too_long" });
    expect(validateDeviceLabel("   ")).toEqual({ ok: false, reason: "empty" });
  });

  test("refuses control characters and the bidirectional marks that make one name look like another", () => {
    for (const bad of [
      "Front\u0000desk",
      "Front\u202edesk",
      "Mac\u2066",
      "\u200fMac",
      "Mac\u007f",
      7,
      null,
      undefined,
    ]) {
      expect(validateDeviceLabel(bad), JSON.stringify(bad)).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
  });
});
