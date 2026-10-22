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

import { scowlWords } from "./english-words";
import { TREATMENT_NAMES } from "./treatment-names";
import { META_TREATMENT_VOCABULARY } from "./treatment-vocabulary";

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
    // Irregular forms of the commonest verbs, and the words of a reply about a booking, a visit or a way there.
    "esté estén estará estarán estaría será serán sería sea sean fueron fuera sido estado tendrá tendrán tendría pondrá pondrán podrá podrán podría podríamos hará harán haría dirá dirán vendrá vendrán saldrá querrá sabrá habrá hubo puse puso pude pudo hice hizo dije dijo vino vine tuve tuvo quise",
    "equipo solicitud solicitudes vuelta coche carro auto transporte público pública edificio entrada piso oficina calle avenida esquina cerca lejos detrás delante enfrente junto lado metro autobús camión taxi parada estación ascensor elevador escaleras recepción sala espera consultorio local horario disponibilidad anticipación aviso política políticas cancelación reprogramar formulario formularios documento identificación correo electrónico mensaje mensajes llamada llamadas enlace pago pagos depósito tarjeta crédito débito efectivo transferencia factura recibo descuento promoción oferta paquete membresía precio total opción opciones pregunta preguntas respuesta información detalles nombre completo preferencia especialista evaluación valoración primera visita revisión seguimiento cuidado cuidados momento rato día tarde noche mañana semana próximo próxima siguiente último última anterior pronto luego después ahorita enseguida rápido lamentablemente desafortunadamente claramente directamente gusta gustan prácticamente practicamente indoloro indolora doler dolerá libras esterlinas pesos euros encantado encantada amable paciencia comprensión disculpe disculpa perdone tranquilo tranquila listo lista agendado agendada confirmado confirmada recibido recibida",
    "quiero queremos necesitamos gustaría podrían pueden ayudar ayudarme llamar llamarme llámeme escribir confirmar confirmo cancelo cambio cambiar mover nombre apellido número teléfono correo dirección ciudad casa trabajo esposo esposa familia amigo amiga primera vez nuevo nueva paciente pacientes clienta cliente gracias muchas muchos todos todas mismo misma otra vez cuál cuáles qué tal bien muy listo lista perfecto ok",
  ].join(" "),
);

/**
 * Spanish verbs a front desk uses, as infinitives, read with their regular
 * forms (isSpanishVerbForm): "responderá", "quedó", "agendada", "avisará",
 * "llamarle". A closed list, not open morphology, so a word of Portuguese
 * or Italian that merely ends like Spanish is not taken for Spanish on that
 * alone; the replies of the 21 October review that read as another language
 * ("el equipo le responderá en un día", "ya quedó agendada su cita") were
 * made of these.
 */
const ES_VERBS = words(
  [
    "agendar ayudar avisar buscar cambiar cancelar confirmar consultar contactar contestar dejar depositar descansar desear empezar encontrar enviar esperar evaluar explicar firmar ganar hablar indicar informar intentar llamar llegar llenar mandar marcar mirar necesitar notificar olvidar pagar pasar preguntar preparar programar quedar reagendar recomendar registrar reservar revisar sacar separar solicitar tardar terminar tomar trabajar tratar usar visitar anotar apuntar apartar acompañar aceptar cobrar costar durar entrar estacionar asegurar alertar organizar retrasar adelantar dudar preocupar presentar agradecer",
    "atender comer conocer creer deber entender leer meter ofrecer parecer poder querer responder resolver ver vender volver aparecer establecer mantener obtener proceder recorrer suceder tener hacer poner saber traer",
    "abrir asistir compartir cubrir decidir describir dirigir escribir existir incluir permitir recibir referir repetir seguir sentir subir vivir venir pedir decir salir elegir corregir medir servir preferir sugerir conseguir",
  ].join(" "),
);

/** The regular endings of an -ar verb, then an -er or -ir verb, longest first, each with the infinitive's ending it stands for. */
const ES_VERB_ENDINGS: readonly (readonly [string, readonly string[]])[] = [
  // Future and conditional: the infinitive and an ending.
  ...["emos", "eis", "iamos", "ias", "ian", "ia", "as", "an", "e", "a"].map((e) => [`r${e}`, ["r"]] as const),
  // Participles, gerunds, the preterite, the present and the subjunctive.
  ...["ados", "adas", "ado", "ada", "ando", "amos", "aron", "aste", "aba", "aban", "abamos", "ar", "an", "as", "en", "es", "o", "a", "e"].map((e) => [e, ["ar"]] as const),
  ...["idos", "idas", "ido", "ida", "iendo", "imos", "emos", "ieron", "iste", "io", "ia", "ian", "er", "ir", "en", "es", "an", "as", "o", "e", "a", "i"].map((e) => [e, ["er", "ir"]] as const),
];

/** Pronouns that join a verb's end: "llamarle", "confirmarselo", "ayudarles". */
const ES_ENCLITIC = /(?:selos|selas|selo|sela|les|los|las|le|lo|la|me|te|nos|se)$/;

/** Whether a word is a regular form of one of ES_VERBS, accents aside: "responderá", "quedó", "agendada", "llamarle". */
function isSpanishVerbForm(word: string): boolean {
  const bare = word.normalize("NFD").replace(/\p{M}+/gu, "");
  if (bare.length < 4 || !/^[a-zñ]+$/.test(bare)) return false;
  const forms = [bare];
  const clitic = ES_ENCLITIC.exec(bare);
  if (clitic && bare.length - clitic[0].length >= 4) forms.push(bare.slice(0, -clitic[0].length));
  for (const form of forms) {
    for (const [ending, infinitives] of ES_VERB_ENDINGS) {
      if (!form.endsWith(ending) || form.length - ending.length < 2) continue;
      const stem = form.slice(0, form.length - ending.length);
      for (const inf of infinitives) {
        // The future and conditional keep the infinitive whole: "responder" + "á".
        const candidate = inf === "r" ? `${stem}r` : `${stem}${inf}`;
        if (ES_VERBS.has(candidate)) return true;
      }
    }
  }
  return false;
}

/** Words of the other Latin-script languages met most often, none of them English or Spanish. */
const OTHER = words(
  [
    // French. Its function words win over the large English list, which holds
    // some of them as English ("sans", "pendant", "pour", "tout").
    "je j' tu nous vous il elle est suis sommes êtes pas ne n' c' ça qu' des du au aux et avec très oui combien coûte être avoir fait faire peut peux veux mon ma mes ton votre vos notre dans chez alors aussi où quel quelle quoi demain plaît voudrais respire respirer chien chat sans pendant pour tout toute tous comme donc toujours jamais rien sur leur cette ces",
    // Portuguese
    "não você vocês eu estou tenho foi vai sua seu equipe unidade passar quanto muito também uma isso isto meu minha seu sua custa quero posso bom boa noite hoje amanhã horário consigo respirar cachorro está abrem abre aberto aberta fechado fechada queria gostaria marcar filho filha marido esposa dor doendo dente dentes unha cabelo rosto preço tudo vocês obrigada onde tem pode fazer mais agora depois ainda nossa nosso efeitos",
    // German
    "ich nicht und ist sind sie das ein eine einen mit bitte kann können haben wir mein meine hallo guten wie viel kostet termin heute morgen hilfe atmen atmet hund auch noch schon aber oder wenn dann muss habe hast sehr dein ihr von für auf",
    // Italian
    "sono che gli della dello vorrei appuntamento oggi domani aiuto respirare riesco non anche molto posso questo quello dove perché niente siamo",
    // Dutch
    "ik niet het een dank je jij wij hoeveel afspraak vandaag alstublieft",
    // Tagalog
    "ako salamat ang ng mga sa ko mo siya hindi oo magkano kailan saan makahinga",
    // Haitian Creole
    "mwen pa ka respire pitit tanpri ede bezwen yon demen",
    // Polish
    "nie mogę oddychać proszę dziękuję jestem",
    // Vietnamese without its marks, romanised Chinese and Arabic
    "toi khong tho duoc ban cua xin cam wo bu neng huxi ana mish mesh ader atnafas atnafes enta enti ayez ayza bokra bekam kam momken mumkin feen fein emta keda yaani leh",
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
  "mon tue tues wed thu thur thurs fri sat sun mo th fr sa su di jan feb mar apr jun jul aug sep sept oct nov dec edt cst cdt mst mdt pst pdt ct mt pt utc gmt",
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

/**
 * English words of a clinic's front desk that a general word list misses or
 * holds only rarely: the words of dentistry, a vet's desk, wellness clinics
 * and access and admin. Counted as English, like the hand list above.
 */
const DOMAIN = words(
  [
    "dentistry dental dentist dentists orthodontist orthodontists orthodontic orthodontics periodontal periodontist periodontics endodontist endodontic oral hygienist hygiene prophylaxis cleaning cleanings checkup checkups exam exams xray xrays x-ray radiograph radiographs cavity cavities filling fillings crown crowns bridge bridges denture dentures implant implants veneer veneers extraction extractions wisdom molar molars gum gums gingivitis fluoride sealant sealants retainer retainers aligner aligners braces bite nightguard mouthguard whitening bleaching pediatric paediatric pediatrician kids sedation sedated anesthesia anaesthesia anesthetic numbing nitrous laughing",
    "wellness infusion infusions iv drip drips hydration vitamin vitamins injection injections shot shots booster boosters pellet pellets hormone hormones hormonal testosterone estrogen progesterone thyroid peptide peptides metabolic weight loss medical medically supervised telehealth telemedicine virtual video consult consults consultation consultations follow-up followup refill refills prescription prescriptions pharmacy labs lab bloodwork blood panel panels draw test tests testing screening screenings results",
    "massage lymphatic drainage contouring sculpting tightening resurfacing rejuvenation microneedling dermaplaning facial facials peel peels lift lifting filler fillers injectable injectables neurotoxin toxin tox wrinkle wrinkles lines spider veins vein veins sclerotherapy cellulite stretch marks pigmentation melasma rosacea acne scarring pores laser lasers hair removal brow brows lash lashes extensions tint lamination wax waxing threading spray tan tanning skincare serum serums retinol sunscreen consultation aesthetic aesthetics esthetic esthetics esthetician aesthetician injector injectors nurse practitioner physician assistant",
    "puppy puppies kitten kittens dog dogs cat cats pet pets wellness vaccine vaccines vaccinations rabies distemper parvo bordetella lepto leptospirosis heartworm flea fleas tick ticks prevention preventive deworming dewormer microchip microchipping spay spayed spaying neuter neutered neutering dental grooming groom groomer bath nails nail trim boarding daycare kennel senior geriatric bloodwork urinalysis fecal stool sample allergy itchy ear ears infection limping limp lump checkup vet veterinarian veterinary clinic hospital exotic exotics rabbit guinea hamster ferret bird reptile",
    "wheelchair accessible accessibility ramp elevator handicap disabled disability ada compliant compliance hipaa insurance insured coverage covered copay deductible financing finance carecredit cherry affirm klarna installment installments payment payments plan plans hsa fsa receipt invoice superbill refund refundable nonrefundable deposit deposits cancellation reschedule rescheduling availability available openings opening slot slots waitlist walk-in walk-ins walkin parking validate validation directions entrance suite downtown location locations hours weekend weekends holiday holidays referral referrals referred records transfer form forms intake paperwork portal login",
    "combo combos package packages bundle bundles membership memberships member members discount discounts promo promos promotion promotions special specials deal deals offer offers gift card cards voucher vouchers credit credits points loyalty rewards price prices pricing cost costs quote estimate rate rates fee fees session sessions treatment treatments service services menu",
    // Texting and the commonest misspellings a front desk gets.
    "appt appts apt tmrw tmr tmrow tomorow tommorow tommorrow tomorro 2moro 2morrow tonite nite thru pls plz thx thanx ty tysm u ur r k kk ok okk okay lmk idk rn bc cuz coz b4 w wk wks hr hrs min mins sec info msg txt bday sched resched reschedual reshedule reschdule cancle cancell appointmnet appoinment appointmet availible availabe avaliable recieve wich wat wanna gonna gotta lemme gimme ya'll y'all yall dont cant wont didnt doesnt isnt im ive id youre theyre thats whats hows wheres",
  ].join(" "),
);

/**
 * Treatment, brand and device names: neutral, neither English nor another
 * language. The catalog's treatment vocabulary (./treatment-vocabulary.ts,
 * ./treatment-names.ts) and the names a US med spa, dentist or wellness
 * clinic lists beside them: "daxxify", "emsculpt neo", "NAD+ infusion".
 */
const BRANDS = words(
  [
    "botox dysport xeomin jeuveau daxxify letybo juvederm voluma volbella vollure volux restylane lyft kysse defyne refyne radiesse sculptra belotero rha versa revanesse skinvive kybella",
    "fraxel halo bbl moxi picosure picoway pico ipl co2 erbium aerolase vbeam alexandrite gentlemax candela sciton lumenis cynosure cutera morpheus8 morpheus potenza vivace secret scarlet ultherapy thermage sofwave emsculpt emsella emface emtone neo coolsculpting coolpeel trusculpt bodytite facetite accutite sculpsure vanquish hydrafacial diamondglow aquagold sylfirm exion profound opus renuvion plexr viora microdermabrasion photofacial",
    "nad nad+ myers glutathione biotin b12 lipo lipo-c lipo-b mic ketamine ozone chelation bpc bpc-157 tb-500 ipamorelin sermorelin cjc tesamorelin semaglutide tirzepatide liraglutide ozempic wegovy mounjaro zepbound saxenda contrave qsymia phentermine metformin hcg trt bhrt estradiol evexipel biote clomid enclomiphene anastrozole",
    "rf hifu microchanneling vs versus glo2facial oxygeneo geneo",
    "invisalign clearcorrect smiledirect lumineers cerec prophy srp zirconia waterpik sonicare nightguard all-on-4 all-on-x",
    "apoquel cytopoint simparica nexgard bravecto heartgard interceptor frontline seresto trifexis credelio proheart dhpp dapp fvrcp felv rimadyl carprofen cerenia convenia",
  ].join(" "),
);

let treatmentWords: ReadonlySet<string> | null = null;

/** The treatment vocabulary's words, built once. */
function treatmentWordSet(): ReadonlySet<string> {
  if (!treatmentWords) {
    const set = new Set<string>(BRANDS);
    for (const term of [...META_TREATMENT_VOCABULARY, ...TREATMENT_NAMES]) {
      for (const word of normaliseTerm(term)) set.add(word);
    }
    treatmentWords = set;
  }
  return treatmentWords;
}

/** A term's words, lower case, accents off, the way tokens are compared. */
function normaliseTerm(term: string): string[] {
  return term
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}+]+/u)
    .filter((w) => w.length > 0);
}

/** A word through the common endings: "booked", "prices", "breathing", "babies". */
function stemsOf(word: string): string[] {
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
  return stems.filter((stem) => stem.length >= 2);
}

/** The hand list and the domain lexicon: full English evidence, short words included. */
function isCoreEnglish(word: string): boolean {
  if (EN.has(word) || DOMAIN.has(word)) return true;
  return stemsOf(word).some((stem) => EN.has(stem) || DOMAIN.has(stem));
}

/**
 * The large list (./english-words.ts, SCOWL size 35). Evidence only for a
 * word of four letters or more that is not a word of another language the
 * check knows: SCOWL holds "pa", "ma", "mesh", "non", "pas", "con" and
 * "boa", which are Haitian, Arabic, Italian, French and Portuguese words
 * as often as English ones, and short words are where the languages meet.
 */
function isListedEnglish(word: string): boolean {
  if (word.length < 4) return false;
  const list = scowlWords();
  if (list.has(word)) return true;
  return stemsOf(word).some((stem) => stem.length >= 4 && list.has(stem));
}

/** Damerau-Levenshtein distance, capped: for a misspelt English word. */
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...Array<number>(b.length).fill(0),
  ]);
  for (let j = 1; j <= b.length; j += 1) d[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let best = cap + 1;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      best = Math.min(best, v);
    }
    if (best > cap) return cap + 1;
  }
  return d[a.length]![b.length]!;
}

let fuzzyTargets: string[] | null = null;

/**
 * A misspelling of an English word a front desk uses ("appointmnet",
 * "availible", "reciept"): one edit away for a word of five to seven
 * letters, two for a longer one, from the hand list and the domain lexicon
 * only. Half evidence, never for a word of another language the check knows.
 */
function isMisspeltEnglish(word: string): boolean {
  if (word.length < 5) return false;
  fuzzyTargets ??= [...EN, ...DOMAIN].filter((w) => w.length >= 4 && /^[a-z]+$/.test(w));
  const cap = word.length >= 8 ? 2 : 1;
  return fuzzyTargets.some((target) => editDistance(word, target, cap) <= cap);
}

/**
 * The Spanish word list, through the plural, except where the plural would
 * be a word of another language the check knows ("das" is German, not the
 * plural of "da").
 */
function isSpanish(word: string): boolean {
  if (ES.has(word)) return true;
  if (OTHER.has(word)) return false;
  if (isSpanishVerbForm(word)) return true;
  if (word.endsWith("es") && ES.has(word.slice(0, -2))) return true;
  return word.endsWith("s") && ES.has(word.slice(0, -1));
}

type Token = { raw: string; word: string; afterTime?: boolean; sentenceStart?: boolean };

function tokensOf(text: string): Token[] {
  const out: Token[] = [];
  let sentenceStart = true;
  for (const raw of text.replace(/[‘’ʼ]/g, "'").split(/(?<=[.!?¿¡])|[^\p{L}\p{N}'/+.!?¿¡-]+/u)) {
    if (!raw) continue;
    if (/^[.!?¿¡]+$/.test(raw) || /[.!?]$/.test(raw)) {
      // A sentence's end: the next word starts one, and is capitalised for that alone.
      const word = raw.replace(/[.!?¿¡]+$/u, "").replace(/^[¿¡]+/u, "");
      if (word) pushToken(out, word, sentenceStart);
      sentenceStart = true;
      continue;
    }
    pushToken(out, raw.replace(/^[¿¡]+/u, ""), sentenceStart);
    sentenceStart = false;
  }
  const tokens = out.filter((t) => t.word.length > 0);
  for (let i = 1; i < tokens.length; i += 1) {
    if (/^\d{1,2}(:\d{2})?(am|pm|a|p)?$/i.test(tokens[i - 1]!.word)) tokens[i]!.afterTime = true;
  }
  return tokens;
}

function pushToken(out: Token[], raw: string, sentenceStart: boolean): void {
  {
    let first = true;
    for (const piece of raw.split(/[-/.]/)) {
      if (!piece) continue;
      // "n'arrive" is "n'" and "arrive"; "can't" and "i'm" stay whole.
      const m = /^([a-z]')(\p{L}+)$/iu.exec(piece);
      if (m && !["i'", "o'"].includes(m[1]!.toLowerCase())) {
        out.push(
          { raw: m[1]!, word: m[1]!.toLowerCase(), sentenceStart: sentenceStart && first },
          { raw: m[2]!, word: m[2]!.toLowerCase() },
        );
      } else {
        out.push({
          raw: piece,
          word: piece.toLowerCase().replace(/^'+|'+$/g, ""),
          sentenceStart: sentenceStart && first,
        });
      }
      first = false;
    }
  }
}

function isTitleCase(raw: string): boolean {
  return /^\p{Lu}[\p{Ll}'.]+$/u.test(raw);
}

/**
 * Whether a token counts for no language: a number, a time, a day, a code,
 * a greeting, a letter, a treatment's or a brand's name, one of the clinic's
 * own terms.
 */
/** What may follow a number and still be a number: a time, an ordinal, a unit, a count. */
const NUMBER_SUFFIX =
  /^\d+(st|nd|rd|th|am|pm|a|p|k|x|h|hr|hrs|min|mins|m|s|d|w|wk|wks|yo|ml|mg|mcg|cc|u|iu|lb|lbs|oz|kg|g|cm|mm|in|ft|\+)?$/i;

/**
 * Arabic written in Latin letters and digits ("2ader", "sa3dooni",
 * "maw3ed"): a digit standing for a letter inside a word. Evidence of
 * another language, never a number. Texting shorthand ("b4", "2day") and the
 * names of things ("co2", "b12", "morpheus8") are read before this.
 */
function isArabizi(word: string): boolean {
  if (!/\p{N}/u.test(word) || NUMBER_SUFFIX.test(word)) return false;
  return /\p{L}[2356789]\p{L}|^[2356789]\p{L}{3,}|\p{L}{3,}[2356789]$/u.test(word);
}

function isNeutral(token: Token, known: ReadonlySet<string>): boolean {
  const { raw, word } = token;
  if (/\p{N}/u.test(word) && (!isArabizi(word) || treatmentWordSet().has(word) || DOMAIN.has(word)))
    return true; // 3pm, 10am, 2nd, 415, co2
  if (!/\p{L}/u.test(word)) return true;
  if (OTHER_SCRIPT.test(raw)) {
    OTHER_SCRIPT.lastIndex = 0;
    return true; // counted on its own, by script (messageLanguage)
  }
  OTHER_SCRIPT.lastIndex = 0;
  if (word.length === 1 && !["a", "i", "y", "o", "u"].includes(word)) return true;
  if (DAYS_AND_ZONES.has(word) || NEUTRAL_WORDS.has(word)) return true;
  if (STATE_CODES.has(raw)) return true;
  // "EST" and "ET" are time zones in capitals or after a time ("6pm est"); in a
  // French sentence "est" and "et" are French.
  if ((word === "est" || word === "et") && (raw === raw.toUpperCase() || token.afterTime))
    return true;
  const bare = normaliseTerm(word).join("");
  if (known.has(bare) || treatmentWordSet().has(bare) || treatmentWordSet().has(word)) return true;
  return false;
}

/** A word with a letter held for emphasis, as the word: "hiii" is "hi", "sooo" is "so", "goood" is "good". */
function unstretched(word: string): string {
  if (!/(\p{L})\1{2,}/u.test(word)) return word;
  const double = word.replace(/(\p{L})\1{2,}/gu, "$1$1");
  if (isCoreEnglish(double) || isListedEnglish(double) || isSpanish(double)) return double;
  return word.replace(/(\p{L})\1{2,}/gu, "$1");
}

/** What the check may be told about the practice. */
export type LanguageOptions = {
  /**
   * The practice's own words: its name, its services, its providers, its
   * address and city. Neutral, like a brand: "is Okonkwo in on Tuesday" and
   * "hydra glow facial price" read as English when the clinic says so.
   */
  knownTerms?: readonly (string | null | undefined)[];
};

function knownWords(options: LanguageOptions): ReadonlySet<string> {
  const set = new Set<string>();
  for (const term of options.knownTerms ?? []) {
    if (!term) continue;
    for (const word of normaliseTerm(term)) if (word.length >= 2) set.add(word);
  }
  return set;
}

/** The counts the decision reads, exported so the tests can see why. */
export function languageScores(
  text: string,
  options: LanguageOptions = {},
): {
  en: number;
  es: number;
  /** Evidence of English or Spanish: one a word, half a misspelt one. */
  screened: number;
  other: number;
  unknown: number;
  tokens: number;
} {
  const known = knownWords(options);
  const list = tokensOf(text.replace(NEUTRAL_PHRASES, " "));
  let en = 0;
  let es = 0;
  let screened = 0;
  let other = 0;
  let unknown = 0;
  for (const [index, original] of list.entries()) {
    // Letters held for emphasis read as the word: "hiii", "helloooo", "sooo".
    const token = { ...original, word: unstretched(original.word) };
    if (isNeutral(token, known)) continue;
    const word = token.word;
    const foreign = OTHER.has(word) || VIETNAMESE.has(word) || isArabizi(word);
    const core = isCoreEnglish(word);
    const spanish = isSpanish(word);
    if (core || spanish) {
      if (core) en += 1;
      if (spanish) es += 1;
      // A Spanish word of one or two letters ("el", "ni", "se") is half
      // evidence on its own: Arabic written in Latin letters, Yoruba and
      // others share them. An English one counts in full.
      const half = !core && word.length <= 2;
      screened += half ? 0.5 : 1;
      if (half) unknown += 0.5;
      continue;
    }
    // A word of another language the check knows wins over the large list.
    if (!foreign && isListedEnglish(word)) {
      en += 1;
      screened += 1;
      continue;
    }
    // A capitalised word no list knows is a name: "Chez Nous", "Sono Bello",
    // "Jean-Pierre". The first word of the message is capitalised anyway, so
    // there a word of another language counts as one ("Magkano po…").
    if (
      isTitleCase(token.raw) &&
      !((index === 0 || token.sentenceStart || word === "ich") && foreign)
    )
      continue;
    if (foreign) {
      other += 1;
      continue;
    }
    // A short word only the large list holds is no evidence either way.
    if (word.length < 4 && scowlWords().has(word)) continue;
    if (isMisspeltEnglish(word)) {
      en += 0.5;
      screened += 0.5;
      unknown += 0.5;
      continue;
    }
    unknown += 1;
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
 * positive evidence (see the file header). Pass the practice's own terms
 * (LanguageOptions) wherever they are known, so its menu and its people
 * count as no language.
 */
export function messageLanguage(
  text: string | null | undefined,
  options: LanguageOptions = {},
): MessageLanguage {
  if (!text || !text.trim()) return "en";
  const scores = languageScores(text, options);
  const screened = scores.screened;
  // Another script, unless it is a name inside an English or Spanish sentence.
  const otherScript = (text.match(OTHER_SCRIPT) ?? []).length;
  const latin = (text.match(LATIN_LETTER) ?? []).length;
  if (otherScript >= 2 && (otherScript > latin || screened === 0)) return "other";
  const vietnamese = (text.match(VIETNAMESE_MARKS) ?? []).length;
  if (vietnamese >= 3 && screened < 2) return "other";
  if (scores.other >= 2 && scores.other > scores.en && scores.other > scores.es) return "other";
  const counted = screened + scores.other + scores.unknown;
  // Nothing but neutral words: a time, a day, a greeting, a name, a treatment.
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
