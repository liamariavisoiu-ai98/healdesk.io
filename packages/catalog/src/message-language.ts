/**
 * Which language a message is in, as far as the screens need to know: English
 * or Spanish, the two the assistant may answer in because the urgent screen
 * (./urgent-content.ts) and the clinical screen (./clinical-content.ts) read
 * them, or another language, which no screen reads.
 *
 * A message in another language never reaches the model: the urgent screen
 * cannot see "Je n'arrive pas à respirer", so the only safe answer is a fixed
 * line, in English and in Spanish, that gives 911 and the practice's number
 * (./urgent-replies.ts, otherLanguageReply). The same check reads the
 * model's reply, so a reply written in another language is never sent.
 *
 * A closed, cheap check, not a language model:
 *   - letters of another script (Cyrillic, Greek, Arabic, Hebrew, the
 *     Indic scripts, Thai, Chinese, Japanese, Korean) where they are a real
 *     part of the message, not a name in an English sentence;
 *   - Vietnamese, by its own letters together with its words;
 *   - the Latin-script languages most often met (French, Portuguese,
 *     German, Italian, Dutch, Tagalog), by their function words and their
 *     own letters, against the English and Spanish ones.
 * When it is not sure, it says English: a Spanish or English message must
 * not be turned away. The cost of that choice is a message in another
 * language with too few of its own words to tell (one word, a name and a
 * number) reaching the model, which is told to answer only in the clinic's
 * languages; the reply is read again on the way out.
 */

export type MessageLanguage = "en" | "es" | "other";

const words = (list: string): ReadonlySet<string> => new Set(list.split(/\s+/).filter(Boolean));

/** English function words and front-desk words. */
const EN = words(
  "the is are was were i i'm i've i'd you your you're my me we our us it it's this that these those what when where which who how why can could would should will do does did don't can't have has had need want like please thanks thank hi hello hey and or but with for from about book booking appointment price cost much any some there here open closed today tomorrow yes no okay ok",
);

/** Spanish words that are not English ones. */
const ES = words(
  "el la los las un una unos unas que qué por para con pero como cómo está están estoy estás tengo tiene tienen hola gracias quiero quisiera puedo puede necesito cuánto cuanto cuesta cuestan dónde donde cuándo cuando sí usted ustedes mi mis tu muy también horario horarios cita citas precio precios buenos buenas días tardes noches porque esto esta este ella él nosotros soy es y mañana hoy ayuda señor señora del al se lo nada algo todo tarde agendar preciso consigo",
);

/** Words of the other Latin-script languages met most often, none of them English or Spanish. */
const OTHER = words(
  [
    // French
    "je j' tu nous vous il est suis sommes êtes pas ne n' c' ça qu' des du au aux et avec très oui bonjour bonsoir merci combien coûte être avoir fait peux veux mon ma mes ton votre vos notre dans chez alors aussi où quel quelle quoi demain plaît",
    // Portuguese
    "não você vocês eu estou tenho obrigado obrigada olá oi muito também uma isso isto meu minha seu sua custa quero posso bom boa noite ajuda hoje amanhã horário",
    // German
    "ich nicht und ist sind sie das ein eine einen mit bitte kann können haben wir mein meine danke hallo guten wie viel kostet termin heute morgen hilfe atmen",
    // Italian
    "sono che gli della dello ciao grazie buongiorno vorrei appuntamento oggi domani aiuto respirare",
    // Dutch
    "ik niet het een dank je jij wij hoeveel afspraak vandaag morgen alstublieft",
    // Tagalog
    "ako po salamat ang ng mga sa ko mo siya hindi oo magkano kailan saan",
  ].join(" "),
);

/** Spanish letters and marks English never has. */
const ES_MARKS = /[ñ¿¡]/i;
/** Letters only Portuguese, French or German use among these languages. */
const OTHER_MARKS = /[ãõçêèàùœâîôûëïßäö]/i;
/** Vietnamese letters (horn, breve, d-bar and the dot-below and hook-above vowels). */
const VIETNAMESE_MARKS = /[ơưđăạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/gi;
const VIETNAMESE = words(
  "tôi không bạn được của là có và cho em anh chị xin cảm ơn thở giúp bao nhiêu",
);
/** Letters of a script other than Latin. */
const OTHER_SCRIPT =
  /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Thai}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Armenian}\p{Script=Georgian}\p{Script=Ethiopic}\p{Script=Khmer}\p{Script=Lao}\p{Script=Myanmar}]/gu;

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .split(/[^\p{L}']+/u)
    .flatMap((t) => {
      // "n'arrive" is "n'" and "arrive"; "can't" stays whole.
      const m = /^([a-z]')(\p{L}+)$/u.exec(t);
      return m && !["i'", "o'"].includes(m[1]!) ? [m[1]!, m[2]!] : [t];
    })
    .filter(Boolean);
}

/** The counts the decision reads, exported so the tests can see why. */
export function languageScores(text: string): {
  en: number;
  es: number;
  other: number;
  tokens: number;
} {
  const list = tokens(text);
  let en = 0;
  let es = 0;
  let other = 0;
  for (const t of list) {
    if (EN.has(t)) en += 1;
    if (ES.has(t)) es += 1;
    if (OTHER.has(t) || VIETNAMESE.has(t)) other += 1;
  }
  if (ES_MARKS.test(text)) es += 2;
  if (OTHER_MARKS.test(text)) other += 1;
  return { en, es, other, tokens: list.length };
}

/**
 * English, Spanish or another language. Unsure means English (see the file
 * header): only a confident "other" turns a message away.
 */
export function messageLanguage(text: string | null | undefined): MessageLanguage {
  if (!text || !text.trim()) return "en";
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  const otherScript = (text.match(OTHER_SCRIPT) ?? []).length;
  const scores = languageScores(text);
  // Another script, unless it is a name or a word inside an English or Spanish sentence.
  if (
    otherScript >= 2 &&
    (otherScript / Math.max(letters, 1) >= 0.3 || scores.en + scores.es < 2)
  ) {
    return "other";
  }
  const vietnamese = (text.match(VIETNAMESE_MARKS) ?? []).length;
  if (vietnamese >= 3 && scores.en + scores.es < 2) return "other";
  if (scores.other >= 2 && scores.other > scores.en && scores.other > scores.es) return "other";
  // One or two words with nothing English or Spanish about them: "Bonjour", "Obrigado".
  if (scores.other >= 1 && scores.en === 0 && scores.es === 0 && scores.tokens <= 3) return "other";
  if (scores.es >= 2 && scores.es > scores.en) return "es";
  return "en";
}

/** Whether a message leans Spanish at all: one Spanish word more than English ones. For a fixed reply's language. */
export function leansSpanish(text: string): boolean {
  const scores = languageScores(text);
  return scores.es >= 1 && scores.es > scores.en;
}
