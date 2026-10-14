/**
 * Strings written for the ear, not the eye. The assistant's voice channel
 * (lib/assistant/turn.ts and prompt.ts, for the Retell endpoint) reads a
 * phone number through here, so the conversion from data to speech happens
 * once and is tested once: an E.164 number becomes three groups of digits
 * with "oh" for zero. None of it is model text.
 */

const DIGIT_WORDS = ["oh", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/**
 * "+14155550199" → "four one five — five five five — oh one nine nine".
 * A US number drops its country code; anything else is read digit by digit
 * in groups of three. The agent gives the practice's own number when it hands
 * a caller to the desk, and a voice model reads "+14155550199" as a sum.
 */
export function spokenPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  const groups = national.length === 10 ? [national.slice(0, 3), national.slice(3, 6), national.slice(6)] : chunk(national, 3);
  return groups.map((g) => [...g].map((d) => DIGIT_WORDS[Number(d)]).join(" ")).join(" — ");
}

function chunk(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}
