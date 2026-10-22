/**
 * Strings written for the ear, not the eye. The assistant's voice channel
 * (lib/assistant/turn.ts and prompt.ts, for the Retell endpoint) reads a
 * phone number through here, so the conversion from data to speech happens
 * once and is tested once: an E.164 number becomes three groups of digits
 * with "oh" for zero ("cero" in Spanish). None of it is model text.
 */

const DIGIT_WORDS = ["oh", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
/** The same digits for a call the caller has taken into Spanish (lib/voice/call-language.ts). */
const DIGIT_WORDS_ES = ["cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve"];

/** The languages a call can be spoken in: those the screens read (@healdesk/catalog, messageLanguage). */
export type SpokenLanguage = "en" | "es";

/**
 * "+14155550199" → "four one five — five five five — oh one nine nine".
 * A US number drops its country code; anything else is read digit by digit
 * in groups of three. The agent gives the practice's own number when it hands
 * a caller to the desk, and a voice model reads "+14155550199" as a sum.
 */
export function spokenPhone(e164: string, language: SpokenLanguage = "en"): string {
  const words = language === "es" ? DIGIT_WORDS_ES : DIGIT_WORDS;
  const digits = e164.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  const groups = national.length === 10 ? [national.slice(0, 3), national.slice(3, 6), national.slice(6)] : chunk(national, 3);
  return groups.map((g) => [...g].map((d) => words[Number(d)]).join(" ")).join(" — ");
}

function chunk(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

const WEEKDAYS_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const HOURS_ES = ["doce", "una", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once"];

/**
 * A booking time as a Spanish speaker says it aloud, in the clinic's zone:
 * "martes 4 de noviembre a las tres de la tarde", "a la una y media de la
 * tarde". The Spanish counterpart of lib/booking/calendar.ts slotLabel,
 * for a call in Spanish only; the day of the month stays a numeral, which
 * a Spanish voice reads as a number.
 */
export function spokenSlotEs(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const h12 = hour % 12;
  const minutes = minute === 0 ? "" : minute === 15 ? " y cuarto" : minute === 30 ? " y media" : ` y ${minute}`;
  const period =
    hour === 12 && minute === 0
      ? "del mediodía"
      : hour < 6
        ? "de la madrugada"
        : hour < 12
          ? "de la mañana"
          : hour < 20
            ? "de la tarde"
            : "de la noche";
  const clock = `${h12 === 1 ? "a la" : "a las"} ${HOURS_ES[h12]}${minutes} ${period}`;
  return `${WEEKDAYS_ES[weekday] ?? ""} ${Number(get("day"))} de ${MONTHS_ES[Number(get("month")) - 1] ?? ""} ${clock}`.trim();
}
