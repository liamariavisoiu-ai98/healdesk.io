/**
 * Which language a message is in, as far as the screens need to know: English
 * or Spanish, the two the assistant may answer in because the urgent screen
 * (./urgent-content.ts) and the clinical screen (./clinical-content.ts) read
 * them, or another language, which no screen reads.
 *
 * A message in another language never reaches the model: the urgent screen
 * cannot see "Mwen pa ka respire" or "Nie mogę oddychać", so the only safe
 * answer is a fixed line, in English and in Spanish, that gives 911 and the
 * practice's number (./urgent-replies.ts, otherLanguageReply). The same
 * check reads the model's reply, so a reply in another language is never
 * sent.
 *
 * It is closed: a message is English or Spanish only on positive evidence.
 * Its words are looked up in an English and a Spanish word list (common
 * words, front-desk words and the words of an emergency), and at least
 * SCREENED_SHARE of the words that are not neutral must be found there.
 * Anything else is another language, including a language no list here
 * names (Haitian Creole, Polish, romanised Arabic or Chinese, Shona).
 *
 * Neutral words count for neither side, so a short message made only of them
 * passes as English: numbers and times ("3pm", "9am EST"), day and month
 * abbreviations ("Mon", "Sa"), a state's postal code in capitals ("Boston
 * MA"), "PO", greetings and thanks in the languages a front desk hears
 * ("Bonjour", "merci beaucoup", "Danke", "Ciao", "Oi", "à demain"), single
 * letters, and a capitalised word no list knows, which is a name ("Chez Nous
 * Aesthetics", "Sono Bello", "Jean-Pierre"). A name in another script inside
 * an English sentence ("my name is Мария", "I'm Kim 김민지") is a name too.
 *
 * The cost of being closed: a message whose words are mostly misspelt, or
 * mostly words the lists do not hold, is turned away with the fixed line,
 * which gives the practice's number. Its benefit: no emergency written in a
 * language the screens cannot read is ever answered by the model.
 */

export type MessageLanguage = "en" | "es" | "other";

const words = (list: string): ReadonlySet<string> => new Set(list.split(/\s+/).filter(Boolean));

/**
 * The share of a message's words that must be English or Spanish for it to
 * count as either: below it, the message is another language.
 */
export const SCREENED_SHARE = 0.4;

/** English: the common words, a front desk's, a clinic's, an emergency's, and chat shorthand. */
const EN = words(
  [
    // Function words and the commonest verbs.
    "a an the and or but if so as at by for from in into of off on onto out over to up with without about above after again against all also am among any are around as away back be because been before being below between both can can't cannot could couldn't did didn't do does doesn't doing don't done down during each either else even ever every few further had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's however i i'd i'll i'm i've is isn't it it'd it'll it's its itself just least less let let's like many may maybe me might mine more most much must mustn't my myself neither never no nor not now of often once only other others otherwise ought our ours ourselves own perhaps please quite rather really same shall she she'd she'll she's should shouldn't since so some such than that that's their theirs them themselves then there there's these they they'd they'll they're they've this those though through thus till too under unless until upon us very was wasn't we we'd we'll we're we've well were weren't what what's whatever when when's where where's whether which while who who's whom whose why why's will with won't would wouldn't yet you you'd you'll you're you've your yours yourself yourselves",
    "able across actually add after afternoon again ago ahead alone along already alright always another answer anyone anything anyway anywhere ask asked asking available bad because become before begin behind believe best better big bit bring brought busy buy call called calling came care carry case change check close come coming continue cost could day days different do done during early easy else end enough evening everyone everything exactly fact far fast feel few fill find fine first follow found free full get give given go going gone good got great group guess half happen happy hard hear help here high hold home hope hour hours idea important keep kind know last late later learn leave left let life little live long look looking lot love low made make man many matter mean meet message mind minute minutes miss moment month months morning move need never new next nice night nothing number off old once open order pay people person pick place plan point possible probably problem put question quick quickly ready real reason remember right room run said same saw say see seem send set show side since small something soon sorry sound speak start stay still stop sure take talk tell thank thanks thing things think time today together told tomorrow tonight took try trying turn understand use used wait want wanted way week weeks weekend well went whole wish woman word work working world worry would write wrong yeah year years yes yesterday yet young",
    // The front desk.
    "box mail appointment appointments availability booking booked book cancel cancellation consult consultation consultations deposit deposits discount fee fees hours location locations office open closed opening closing parking park price prices pricing cost costs quote package packages membership member special specials offer offers promo promotion reschedule schedule scheduled slot slots spot spots time times visit visits website online phone text email address street suite floor building downtown near nearby directions card cash credit debit payment pay paid financing insurance receipt refund gift certificate voucher staff team front desk receptionist manager owner provider doctor dr nurse injector practitioner esthetician aesthetician surgeon dentist hygienist vet veterinarian clinic practice spa medspa med service services treatment treatments session sessions procedure procedures package new existing patient patients client clients first last name hi hello hey morning afternoon evening thanks thank cheers bye goodbye welcome sorry excuse sir madam ma'am monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december am pm noon midnight week weekday weekdays weekend",
    // A clinic's words.
    "botox dysport xeomin jeuveau filler fillers lip lips juvederm restylane sculptra kybella facial facials hydrafacial peel peels chemical microneedling laser lasers ipl hair removal skin tightening tattoo wax waxing brow brows lash lashes eyebrow eyelash massage chiropractic chiropractor adjustment teeth tooth whitening cleaning cleanings filling crown implant implants braces invisalign aligner aligners retainer root canal extraction dental cosmetic surgery surgeon lift facelift tummy tuck breast augmentation lipo liposuction rhinoplasty nose eyelid weight loss semaglutide ozempic wegovy tirzepatide mounjaro glp ivf fertility egg freezing iui embryo transplant prp stem therapy iv drip vitamin b12 injection injections forehead frown lines wrinkles crows feet chin jaw jawline cheek cheeks neck face body arm arms leg legs back underarm bikini acne scar scars spots pores sun damage pigment",
    // An emergency's words, and a vet's.
    "breathe breathing breath chest pain hurt hurts hurting bleeding blood swelling swollen allergic reaction emergency urgent ambulance hospital collapsed fainted dizzy numb vomiting throwing seizure stroke heart attack choking unconscious awake wake pills overdose poison poisoned die dying dead kill suicide fever infection burn burned rash itchy sick ill unwell worse bad badly dog dogs puppy puppies cat cats kitten kittens pet pets animal animals horse bird rabbit vaccine vaccines vaccination shots spay neuter microchip grooming boarding nails chocolate grapes antifreeze",
    // More of the commonest English words: numbers, time, people, places, things, actions, qualities.
    "one two three four five six seven eight nine ten eleven twelve twenty thirty forty fifty hundred thousand first second third fourth fifth once twice half quarter dozen several couple single double each per extra total amount percent dollar dollars cent cents price",
    "minute hour day week month year morning noon evening night today tonight tomorrow yesterday soon later earlier early late now then always usually sometimes often rarely never already still yet again ago since until while during before after recently currently daily weekly monthly annual yearly",
    "people person man men woman women child children kid kids baby babies boy girl son daughter husband wife partner boyfriend girlfriend mother mom mum father dad parent parents brother sister family friend friends neighbor neighbour guy lady ladies gentleman everyone someone somebody anyone anybody nobody myself yourself ourselves themselves",
    "house home apartment room door window floor level elevator stairs lobby entrance exit side front back left right top bottom middle inside outside behind next corner street road avenue ave blvd boulevard drive lane highway city town state country area place places site location map lot garage car cars bus train uber lyft taxi walk walking drive driving traffic",
    "thing things stuff item items way ways part parts kind type sort lot lots bit piece list form forms paper papers document documents id license photo photos picture pictures video call calls text texts email emails link links app account login password website page site online internet code number numbers address",
    "ask answer arrive bring buy call cancel change check choose come complete confirm contact continue decide do drop email expect explain feel fill find finish fix follow forget get give go happen have hear help hold hope include keep know learn leave let like listen live look lose love make mean meet mention miss move need note offer open pay pick plan prefer prepare provide put reach read receive recommend remember remind reply request reschedule return review run save say schedule see seem sell send serve set share show sign sit sleep speak spend start stay stop suggest take talk tell thank think touch try turn understand update use visit wait wake walk want wash watch wear work worry write",
    "able available beautiful better big busy careful certain clean clear close cold common comfortable complete correct dark different difficult easy empty entire exact extra fair familiar fast fine free fresh full general gentle glad good great happy hard healthy heavy helpful high hot important interested kind large last late light little local long loose low main minor mild natural nervous new nice normal old open other perfect personal pleasant popular possible pretty private professional quick quiet ready real recent regular safe same serious short sick similar simple slow small smooth soft sore sorry special strong sure sweet tight tiny tired total true typical unable usual warm weak whole wonderful worried wrong young",
    "also almost already alone along although anyway approximately around away basically certainly definitely directly else especially even exactly finally fully generally hopefully however instead just kindly likely mainly maybe mostly nearly normally obviously only otherwise particularly perhaps possibly probably quickly quite rather really simply slightly so somewhat soon still sure totally truly unfortunately usually very",
    // Health, aftercare and the words a clinical reply is made of.
    "health healthy medical medicine medicines medication medications pill pills tablet tablets drug drugs dose doses dosage prescription allergy allergies allergic condition conditions disease diseases infection diabetes diabetic cancer lupus asthma epilepsy hiv aids positive negative test tests tested result results blood pressure thinner thinners heart lung lungs kidney liver thyroid pregnant pregnancy breastfeeding nursing surgery surgical recovery recover healing heal swelling bruise bruises bruising redness lump lumps bump bumps numb numbing cream ointment ice cold compress risk risks side effect effects symptom symptoms pain painful hurt sore tender itch itching tingling burning bleed bleeding scar scarring downtime aftercare touch-up touchup upright water alcohol exercise workout gym makeup sun sunscreen tylenol ibuprofen aspirin advil motrin aleve arnica fish oil vitamin supplements unit units syringe syringes vial vials ml cc kick kicks wear wears last lasts younger older look looks appearance result smooth fuller natural",
    // Chat shorthand.
    "ok okay k kk thx ty pls plz u ur r lol omg btw asap appt appts info msg tmrw tmr hrs hr mins min wknd yep yup nope sure cool great awesome perfect",
  ].join(" "),
);

/** Spanish: the common words, a front desk's, a clinic's and an emergency's. */
const ES = words(
  [
    "el la los las un una unos unas lo le les del al de que qué por para con sin pero como cómo cuál cual cuáles quién quien dónde donde cuándo cuando cuánto cuanto cuánta cuántos cuántas porque pues si sí también tampoco ya aún todavía muy más menos mucho mucha muchos muchas poco poca todo toda todos todas nada algo alguien nadie otro otra otros este esta esto estos estas ese esa eso esos esas aquí allí ahí y o ni e u ser es son era fue soy eres somos estar está están estoy estás estamos estaba haber hay ha he han había tener tengo tiene tienen tenemos tenía hacer hago hace hacen hizo poder puedo puede pueden podría querer quiero quiere quieren quisiera quisiéramos necesito necesita necesitamos ir voy va van vamos venir vengo viene saber sé sabe dar doy da decir digo dice ver veo mi mis tu tus su sus nuestro nuestra usted ustedes yo él ella ellos ellas nosotros me te se nos",
    "hola buenos buenas días dia día tardes tarde noches noche gracias favor perdón disculpe adiós saludos señor señora señorita claro vale bueno bien mal hoy mañana ayer semana fin lunes martes miércoles jueves viernes sábado domingo hora horas minutos mes meses año años cita citas consulta consultas horario horarios precio precios costo costos cuesta cuestan pagar pago depósito tarjeta efectivo seguro dirección estacionamiento llamar llame llamada teléfono número correo reservar reserva agendar cancelar cambiar disponible abierto cerrado clínica doctor doctora médico enfermera tratamiento tratamientos servicio servicios relleno labios cara piel facial depilación láser bótox dientes limpieza ortodoncia",
    "ayuda ayúdeme ayúdenme urgente emergencia ambulancia hospital dolor duele respirar respira sangre sangrando hinchado hinchada hinchazón alergia alérgica reacción desmayo desmayé mareo vómito vomitando fiebre pecho garganta labio ojo ojos hijo hija hijos esposo esposa marido mujer bebé niño niña mamá papá madre padre perro perra perrito gato gata gatito mascota veterinario pastillas comió tomó no",
    "tomo tomar toma tomando problema problemas efecto efectos dura durar duran quedar quedan van poner ponerme ponga póngase hacerme hacer quitar quitarme lunar bulto bultos embarazada embarazo lactando lactancia pecho frente unidades unidad jeringa normal peligroso peligrosa seguro segura riesgo riesgos cáncer diabetes medicamento medicamentos medicina medicinas resultados resultado meses semanas días después antes durante hielo ejercicio alcohol maquillaje moretones moretón sol crema dolor algún alguna ningún ninguna mucho poquito poco cómo puedo podemos podría debo debe deben tiene tengo sale salió pusieron puso marcas efecto piel cara labios relleno láser",
    "quiero queremos necesitamos gustaría podrían pueden ayudar ayudarme llamar llamarme llámeme escribir confirmar confirmo cancelo cambio cambiar mover nombre apellido número teléfono correo dirección ciudad casa trabajo esposo esposa familia amigo amiga primera vez nuevo nueva paciente pacientes clienta cliente gracias muchas muchos todos todas mismo misma otra vez cuál cuáles qué tal bien muy listo lista perfecto ok",
  ].join(" "),
);

/** Words of the other Latin-script languages met most often, none of them English or Spanish. */
const OTHER = words(
  [
    // French
    "je j' tu nous vous il est suis sommes êtes pas ne n' c' ça qu' des du au aux et avec très oui combien coûte être avoir fait peux veux mon ma mes ton votre vos notre dans chez alors aussi où quel quelle quoi demain plaît voudrais respire respirer chien chat",
    // Portuguese
    "não você vocês eu estou tenho quanto muito também uma isso isto meu minha seu sua custa quero posso bom boa noite hoje amanhã horário consigo respirar cachorro está",
    // German
    "ich nicht und ist sind sie das ein eine einen mit bitte kann können haben wir mein meine hallo guten wie viel kostet termin heute morgen hilfe atmen atmet hund",
    // Italian
    "sono che gli della dello vorrei appuntamento oggi domani aiuto respirare riesco non",
    // Dutch
    "ik niet het een dank je jij wij hoeveel afspraak vandaag alstublieft",
    // Tagalog
    "ako salamat ang ng mga sa ko mo siya hindi oo magkano kailan saan makahinga",
    // Haitian Creole
    "mwen pa ka respire pitit tanpri ede bezwen yon demen",
    // Polish
    "nie mogę oddychać proszę dziękuję jestem",
    // Vietnamese without its marks, romanised Chinese and Arabic
    "toi khong tho duoc ban cua xin cam wo bu neng huxi ana mish ader atnafas",
  ].join(" "),
);

/** Greetings and thanks a front desk hears in any language: neutral, never a reason to turn a message away. */
const NEUTRAL_WORDS = words(
  "merci beaucoup bonjour bonsoir salut ciao danke schön schoen grazie mille obrigado obrigada oi olá aloha shalom namaste arigato shukran xiexie po",
);
const NEUTRAL_PHRASES =
  /(?<![\p{L}])(à demain|à bientôt|a demain|a bientot|au revoir|bonne journée|bonne soirée|bon week-end|merci beaucoup|danke schön|grazie mille)(?![\p{L}])/giu;

/** Day and month abbreviations, and time zones. */
const DAYS_AND_ZONES = words(
  "mon tue tues wed thu thur thurs fri sat sun mo th fr sa su di jan feb mar apr jun jul aug sep sept oct nov dec est edt cst cdt mst mdt pst pdt et ct mt pt utc gmt",
);
/** US postal codes for the states, read only in capitals: "Boston MA". */
const STATE_CODES = words(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC",
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
const LATIN_LETTER = /\p{Script=Latin}/gu;

/** The English word list, through the common endings: "booked", "prices", "breathing", "babies". */
function isEnglish(word: string): boolean {
  if (EN.has(word)) return true;
  const stems: string[] = [];
  if (word.endsWith("'s")) stems.push(word.slice(0, -2));
  if (word.endsWith("s'")) stems.push(word.slice(0, -1));
  if (word.endsWith("ies")) stems.push(`${word.slice(0, -3)}y`);
  if (word.endsWith("es")) stems.push(word.slice(0, -2));
  if (word.endsWith("s")) stems.push(word.slice(0, -1));
  if (word.endsWith("ed")) stems.push(word.slice(0, -2), word.slice(0, -1), word.slice(0, -3));
  if (word.endsWith("ing"))
    stems.push(word.slice(0, -3), `${word.slice(0, -3)}e`, word.slice(0, -4));
  if (word.endsWith("ly")) stems.push(word.slice(0, -2));
  if (word.endsWith("er")) stems.push(word.slice(0, -2), word.slice(0, -1));
  return stems.some((stem) => stem.length >= 2 && EN.has(stem));
}

/** The Spanish word list, through the plural. */
function isSpanish(word: string): boolean {
  if (ES.has(word)) return true;
  if (word.endsWith("es") && ES.has(word.slice(0, -2))) return true;
  return word.endsWith("s") && ES.has(word.slice(0, -1));
}

type Token = { raw: string; word: string };

function tokensOf(text: string): Token[] {
  const out: Token[] = [];
  for (const raw of text.replace(/[‘’ʼ]/g, "'").split(/[^\p{L}\p{N}'/-]+/u)) {
    if (!raw) continue;
    for (const piece of raw.split(/[-/]/)) {
      if (!piece) continue;
      // "n'arrive" is "n'" and "arrive"; "can't" and "i'm" stay whole.
      const m = /^([a-z]')(\p{L}+)$/iu.exec(piece);
      if (m && !["i'", "o'"].includes(m[1]!.toLowerCase())) {
        out.push(
          { raw: m[1]!, word: m[1]!.toLowerCase() },
          { raw: m[2]!, word: m[2]!.toLowerCase() },
        );
      } else {
        out.push({ raw: piece, word: piece.toLowerCase().replace(/^'+|'+$/g, "") });
      }
    }
  }
  return out.filter((t) => t.word.length > 0);
}

function isTitleCase(raw: string): boolean {
  return /^\p{Lu}[\p{Ll}'.]+$/u.test(raw);
}

/** Whether a token counts for no language: a number, a time, a day, a code, a greeting, a letter, a name. */
function isNeutral(token: Token): boolean {
  const { raw, word } = token;
  if (/\p{N}/u.test(word)) return true; // 3pm, 10am, 2nd, 415
  if (!/\p{L}/u.test(word)) return true;
  if (OTHER_SCRIPT.test(raw)) {
    OTHER_SCRIPT.lastIndex = 0;
    return true; // counted on its own, by script (messageLanguage)
  }
  OTHER_SCRIPT.lastIndex = 0;
  if (
    word.length === 1 &&
    word !== "a" &&
    word !== "i" &&
    word !== "y" &&
    word !== "o" &&
    word !== "u"
  )
    return true;
  if (DAYS_AND_ZONES.has(word) || NEUTRAL_WORDS.has(word)) return true;
  if (STATE_CODES.has(raw)) return true;
  return false;
}

/** The counts the decision reads, exported so the tests can see why. */
export function languageScores(text: string): {
  en: number;
  es: number;
  /** Words found in either list, each counted once. */
  screened: number;
  other: number;
  unknown: number;
  tokens: number;
} {
  const list = tokensOf(text.replace(NEUTRAL_PHRASES, " "));
  let en = 0;
  let es = 0;
  let screened = 0;
  let other = 0;
  let unknown = 0;
  for (const [index, token] of list.entries()) {
    if (isNeutral(token)) continue;
    const english = isEnglish(token.word);
    const spanish = isSpanish(token.word);
    if (english || spanish) {
      if (english) en += 1;
      if (spanish) es += 1;
      screened += 1;
      continue;
    }
    const foreign = OTHER.has(token.word) || VIETNAMESE.has(token.word);
    // A capitalised word no list knows is a name: "Chez Nous", "Sono Bello",
    // "Jean-Pierre". The first word of the message is capitalised anyway, so
    // there a word of another language counts as one ("Magkano po…").
    if (isTitleCase(token.raw) && !(index === 0 && foreign)) continue;
    if (foreign) other += 1;
    else unknown += 1;
  }
  // Spanish marks ("¿", "ñ") are evidence of Spanish, and so of a screened language.
  if (ES_MARKS.test(text)) {
    es += 2;
    screened += 1;
  }
  if (OTHER_MARKS.test(text.replace(NEUTRAL_PHRASES, " "))) other += 1;
  return { en, es, screened, other, unknown, tokens: list.length };
}

/**
 * English, Spanish or another language, closed: English or Spanish only on
 * positive evidence (see the file header).
 */
export function messageLanguage(text: string | null | undefined): MessageLanguage {
  if (!text || !text.trim()) return "en";
  const scores = languageScores(text);
  const screened = scores.screened;
  // Another script, unless it is a name inside an English or Spanish sentence.
  const otherScript = (text.match(OTHER_SCRIPT) ?? []).length;
  const latin = (text.match(LATIN_LETTER) ?? []).length;
  if (otherScript >= 2 && (otherScript > latin || screened === 0)) return "other";
  const vietnamese = (text.match(VIETNAMESE_MARKS) ?? []).length;
  if (vietnamese >= 3 && screened < 2) return "other";
  if (scores.other >= 2 && scores.other > scores.en && scores.other > scores.es) return "other";
  const counted = screened + scores.other + scores.unknown;
  // Nothing but neutral words: a time, a day, a greeting, a name.
  if (counted === 0) return "en";
  if (screened / counted < SCREENED_SHARE) return "other";
  if (scores.es >= 2 && scores.es > scores.en) return "es";
  return "en";
}

/** Whether a message leans Spanish at all: one Spanish word more than English ones. For a fixed reply's language. */
export function leansSpanish(text: string): boolean {
  const scores = languageScores(text);
  return scores.es >= 1 && scores.es > scores.en;
}
