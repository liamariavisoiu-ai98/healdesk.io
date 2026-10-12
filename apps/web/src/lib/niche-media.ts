/**
 * Card artwork per niche.
 *
 * Kept out of lib/specialties.ts on purpose: that file is domain knowledge the
 * chat agent and the calculator both read, and it should not gain a dependency
 * on which images happen to have been exported yet. A niche with no entry here
 * simply does not appear in the stack.
 *
 * Every still is the first frame of its own clip at the same crop, so the
 * cross-fade from poster to footage reveals nothing. `video` is the path
 * WITHOUT an extension; the card offers .webm then .mp4.
 */
export type NicheMedia = {
  still: string;
  video?: string;
  /**
   * The still at 16px wide, inline, painted blurred under the card until the
   * still itself has loaded (owner, 12 October 2026: the cards showed as flat
   * grey until then). A few hundred bytes each. Made from the still with
   * Pillow (resize to 16px wide, WebP at quality 40, base64); make it again
   * whenever the still changes.
   */
  blur: string;
};

export const NICHE_MEDIA: Record<string, NicheMedia> = {
  "med-spa": {
    still: "/niches/med-spa.webp",
    video: "/niches/med-spa",
    blur: "data:image/webp;base64,UklGRrYAAABXRUJQVlA4IKoAAADQBACdASoQABYAPu1iqU2ppaOiMAgBMB2JZACdMoMxg0lR2V3h/AzyGzX4fjHvoAD+7E2qgqBIgndYOndjt56y+WNjjYh0yVkpDrEghZrqZmJ+qsIITSR5jRVD+iq3RxKtjApzjJob5bwsurZv6PzrwRP1DVCMqISh5F6ukVW/pbdEW5StY4W01+r2T9ha3xfinUjs45hitCxq2tSpsZKpuUksr9FHdvAAAA==",
  },
  "plastic-surgery": {
    still: "/niches/plastic-surgery.webp",
    video: "/niches/plastic-surgery",
    blur: "data:image/webp;base64,UklGRsoAAABXRUJQVlA4IL4AAABwBACdASoQABYAPu1iqU2ppaOiMAgBMB2JQBOmUAS0QvsmTQy8678F89XQcAD+8NeahRK01tB8TXbzlqByXiQJS6ewpzJDAqNILAbWK5RSAkDxErHa883HM8UNeNjiOL/kdOlafXZXYfgci90lXAW8jLLlpnQhd2J5aQphD27hcs/f95TXR2+y9GcAE067/0/uxjcn5p9UWflCtK/f21bgG+65V4VE6QyoM2IoGKJTRhUP1Fldp4RhVa87OGAA",
  },
  fertility: {
    still: "/niches/fertility.webp",
    video: "/niches/fertility",
    blur: "data:image/webp;base64,UklGRnQAAABXRUJQVlA4IGgAAACQAwCdASoQABYAPu1iqU2ppaOiMAgBMB2JQAAK+ILVa8IHHYYYAP70MsfWPCAgRTugqXq7DEZSSOiq0Y++HNdSdocdwdRxuQhcAxz+nWvqbvPdV5iJkHserK4bdrofai5Dw36Bj24AAA==",
  },
  dental: {
    still: "/niches/dental.webp",
    video: "/niches/dental",
    blur: "data:image/webp;base64,UklGRqIAAABXRUJQVlA4IJYAAABQBACdASoQABYAPu1iqU2ppaOiMAgBMB2JaACdABxuziXQNZKet/dPNowAAM374Q5i680eBAlcjW4iEnIZaEKFRzMKJAYQeSjYYrIE4izH993F7WNYs6UCTFCL9/YTUXtAn4HX02TITZiC5xBVdPciNzkgUZHso/vUEv3yeMtSby/6/nK/2/9bdVre1p7r9Jk+yxKAAAA=",
  },
  glp1: {
    still: "/niches/glp1.webp",
    video: "/niches/glp1",
    blur: "data:image/webp;base64,UklGRlQAAABXRUJQVlA4IEgAAADwAwCdASoQABYAPu1iqk2ppaQiMAgBMB2JaQAAUrllCXHieA3wIvQAAM3ASnBw1mpVtM+6YHxAubnJDOnsW/aRpLmEVS8OAAA=",
  },
  "hair-restoration": {
    still: "/niches/hair-restoration.webp",
    video: "/niches/hair-restoration",
    blur: "data:image/webp;base64,UklGRpwAAABXRUJQVlA4IJAAAACQBACdASoQABYAPu1iqU2ppaOiMAgBMB2JYgCdMoAC/2Xexir/1N64bFC8yIAA/udPNUtE77CmY4UTUVXwW3I4TYwbQ58H/CuXl5D9CcDk8J7/TVuYo5qd4yTDdO8+X+8wO6nMdgAVY1w2hEDBWzORhVnbOHk9sH3zxSbpccHy5t8hQryCoOF4FehNptAAAAA=",
  },
  veterinary: {
    still: "/niches/veterinary.webp",
    video: "/niches/veterinary",
    blur: "data:image/webp;base64,UklGRp4AAABXRUJQVlA4IJIAAADwAwCdASoQABYAPu1kq04ppaQiMAgBMB2JYwAAW4Qr96E+CequCCCAAP7qdOfTCZqkW2ARKe20pi7DjJ+gVT4CxdtOf6Fw/8DuiTM2/MDWLteS21+XExhdsAD0mbogtueDk9df+WVJtVJAP7ivnO5eB3S/B/YIR38v2el5Iu4HWDzOfnwyD3KspLxjda7wSMAAAA==",
  },
  "massage-chiro": {
    still: "/niches/massage-chiro.webp",
    video: "/niches/massage-chiro",
    blur: "data:image/webp;base64,UklGRpIAAABXRUJQVlA4IIYAAAAwBACdASoQABYAPu1iqU2ppaOiMAgBMB2JQBTihEGhwL15yKlkHA4OgQAA/uFuPT/CteD7gMXutUzyJy2OTMGHXUlu+5VdYr6usf7dWFwLcs7GLcbTCzyI4fV5k2nUydOoR0EPlUAY++d8IPi/Q/wadW264xg6ajRORbcx96AHh2FiH+QAAA==",
  },
};
