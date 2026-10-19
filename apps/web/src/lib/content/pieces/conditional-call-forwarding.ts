import type { Piece } from "@/lib/content/types";

/**
 * Piece 11: conditional call forwarding, by carrier and phone system. Every
 * code and menu path is as the carrier's or system's own page gave it on
 * 19 October 2026. Started from packages/catalog/src/forwarding.ts, which is
 * what onboarding shows; where a carrier's page differs from that table, the
 * page here follows the carrier and the difference was reported, not fixed
 * here.
 *
 * Left out because their own help pages could not be opened that day:
 * Spectrum's full star-code guide (spectrum.net needs cookies and script),
 * Spectrum Business (403), Weave (no first-party help page found) and AT&T's
 * per-device wireless guides (rendered by script). AT&T's conditional codes
 * for mobile lines are given only as Google's help page states them.
 */
export const piece: Piece = {
  slug: "conditional-call-forwarding",
  family: "guides",
  title: "How to set conditional call forwarding, by carrier and phone system",
  description:
    "What conditional call forwarding is, the codes and settings US carriers and business phone systems document for it, and how to test and undo it.",
  answer:
    "Conditional call forwarding is usually switched on by dialling the carrier's code and the destination number from the line being forwarded, or by setting a rule in a cloud phone system. " +
    "It sends a call on only when the line is busy, nobody answers or the phone is unreachable, and its codes differ by carrier and often between a carrier's home, mobile and business services.",
  stage: "draft",
  legal: false,
  published: "2026-10-19",
  lastReviewed: "2026-10-19",
  sections: [
    {
      id: "conditional-or-unconditional",
      heading: "What is the difference between conditional and unconditional call forwarding?",
      blocks: [
        {
          kind: "p",
          text:
            "Unconditional forwarding sends every incoming call to another number, which T-Mobile describes as preventing calls to the original number. " +
            "Conditional forwarding lets the original line ring first and forwards a call only when a set condition is met. " +
            "Carriers document three conditions: the line is busy, nobody answers within a set number of rings or seconds, or the phone is off or out of signal range. " +
            "On most of the lines covered below, each condition has its own code to switch it on and another to switch it off.",
          cite: ["tmobile-codes", "verizon-home", "att-phone"],
        },
        {
          kind: "table",
          caption: "Kinds of call forwarding, with example codes from carriers' own pages",
          head: ["Kind", "Forwards a call when", "Start of the code to switch it on (carrier); full codes below"],
          rows: [
            ["Unconditional (all calls)", "Always, at once", "*72 (Verizon home phone, AT&T Phone, Xfinity Voice); **21* (T-Mobile)"],
            ["Busy", "The line is already in use", "*90 (Verizon home phone, AT&T Phone); **67* (T-Mobile)"],
            [
              "No answer",
              "Nobody picks up within the set rings or seconds",
              "*92 (AT&T Phone; Verizon home phone, which names it Call Forwarding Busy Don't Answer); **61* (T-Mobile)",
            ],
            ["Not reachable", "The phone is off, out of signal range or offline", "**62* (T-Mobile)"],
            [
              "Busy or no answer, one code",
              "Either condition",
              "*71 (Verizon mobile, Spectrum Voice); *42 (Verizon home phone, which names it Call Forwarding Busy Line/Don't Answer (Variable))",
            ],
          ],
          cite: ["verizon-home", "verizon-article", "att-phone", "xfinity-qr", "tmobile-codes", "spectrum"],
        },
      ],
    },
    {
      id: "forwarding-for-each-coverage-mode",
      heading: "Which call forwarding setting fits overflow or after-hours answering?",
      blocks: [
        {
          kind: "p",
          text:
            "Forwarding can give an answering service, human or AI, any of the three kinds of coverage below, and each needs a different setting. " +
            "Busy and no-answer forwarding also covers closing hours, when nobody answers the clinic's phone, provided no voicemail or closed-hours greeting on the line answers first. " +
            "Covering only closing hours needs all-call forwarding switched on at closing and off at opening, which a cloud phone system can do with a schedule. " +
            "Comcast Business and Nextiva both document busy forwarding as applying when call waiting is off.",
          cite: ["comcast-managed", "nextiva-busy", "zoom"],
        },
        {
          kind: "table",
          caption: "Three kinds of coverage and the forwarding each needs",
          head: ["Coverage", "Calls that reach the service", "Forwarding to set", "What to watch"],
          rows: [
            ["All calls", "All calls, open or closed", "Unconditional", "Staff do not get the line back until the forwarding is cancelled"],
            [
              "Overflow and after hours",
              "Calls staff miss or cannot take while open, and all calls while closed",
              "Busy and no answer, plus not reachable on a mobile line",
              "Busy forwarding may need call waiting switched off",
            ],
            [
              "After hours only",
              "All calls while closed, none while open",
              "Unconditional, switched on at closing and off at opening, or a rule that follows opening hours",
              "On a landline that means two codes every day unless the line can schedule it",
            ],
          ],
        },
      ],
    },
    {
      id: "verizon-att-t-mobile-codes",
      heading: "What are the call forwarding codes for Verizon, AT&T and T-Mobile?",
      blocks: [
        {
          kind: "p",
          text:
            "The codes below are as each carrier documents them on its own support pages, opened on 19 October 2026. " +
            "Dial them from the line being forwarded and enter the destination as each carrier gives it: 10 digits on Verizon mobile, and 1 before the number on T-Mobile. " +
            "On AT&T's traditional home phone, a long-distance destination takes 1 and the 10-digit number, and forwarding starts only if the destination answers the call the system places after the confirmation tone. " +
            "Verizon notes that its home-phone codes may not be available in all areas, and AT&T that some features need a monthly subscription or carry a usage fee.",
          cite: ["verizon-home", "verizon-faq", "att-features", "att-traditional", "tmobile-codes"],
        },
        {
          kind: "table",
          caption: "Forwarding codes by carrier and service, as each carrier's own page gives them",
          head: ["Carrier and service", "All calls (on / off)", "Busy (on / off)", "No answer (on / off)", "Not reachable (on / off)"],
          rows: [
            [
              "Verizon home phone (Fios Digital Voice and traditional)",
              "*72 / *73",
              "*90 / *91; *42 / *43 for what Verizon names Call Forwarding Busy Line/Don't Answer (Variable)",
              "*92 / *93, which Verizon names Call Forwarding Busy Don't Answer",
              "Not listed",
            ],
            ["Verizon mobile", "*72 + number / *73", "*71 + number / *73, covering busy and no answer together", "*71 + number / *73", "Not listed"],
            ["AT&T Phone, for homes and businesses", "*72, number, # / *73#", "*90, number, # / *91#", "*92, number, # / *93#", "Not listed"],
            ["AT&T traditional home phone", "*72 or 72#, then the number / *73 or 73#", "By calling AT&T on 800.288.2020", "By calling AT&T on 800.288.2020", "Not listed"],
            ["T-Mobile", "**21*1+number# / ##21#", "**67*1+number# / ##67#", "**61*1+number# / ##61#", "**62*1+number# / ##62#"],
          ],
          cite: ["verizon-home", "verizon-faq", "verizon-article", "att-phone", "att-business", "att-traditional", "tmobile-codes"],
        },
        {
          kind: "p",
          text:
            "On T-Mobile, the no-answer delay can be set from 5 to 30 seconds by dialling **61*1+number**seconds#, and ##004# resets call forwarding to its default. " +
            "T-Mobile describes its busy forwarding as applying when a call arrives while the phone is dialling out. " +
            "T-Mobile and Verizon both say calls cannot be forwarded to international numbers.",
          cite: ["tmobile-codes", "tmobile-calling", "verizon-faq"],
        },
        {
          kind: "p",
          text:
            "AT&T's pages opened for this guide give #21# to turn forwarding off on a mobile phone, and *21*, the number and # to forward all calls from its Wireless Home Phone device. " +
            "They do not list codes for busy, no-answer or unreachable forwarding on an AT&T mobile line. " +
            "Google's Voice help page, in an example for AT&T Wireless customers, gives *67*number# for busy, *61*number# for no answer and *62*number# for unreachable, cancelled with ##67#, ##61# and ##62#.",
          cite: ["att-wireless", "att-wireless-home-phone", "google-voice-carriers"],
        },
      ],
    },
    {
      id: "spectrum-xfinity-comcast-business",
      heading: "How do you forward calls on Spectrum, Xfinity or Comcast Business lines?",
      blocks: [
        {
          kind: "p",
          text:
            "Spectrum's own page on its Voice service gives *72 followed by the number to forward all calls, *71 to forward only unanswered or busy calls, and *73 to turn off either. " +
            "Spectrum's full calling-features guide could not be opened for this page, so these codes are worth confirming on the line itself. " +
            "Xfinity's quick reference for Xfinity Voice lists *72 and *73 for call forwarding, and *63 and *83 for selective call forwarding. " +
            "Its advanced call forwarding has no star code and is set in the Voice settings on xfinity.com, and none of the three is included with the Xfinity Voice Unlimited Saver plan.",
          cite: ["spectrum", "xfinity-qr"],
        },
        {
          kind: "p",
          text:
            "Comcast Business's handset guides for its VoiceEdge and managed voice services, both from 2017, give *72 and *73 for all calls, *92 and *93 for no answer, and *90 and *91 for busy. " +
            "The busy code applies, in the guides' words, \"if call waiting is not enabled\". " +
            "The VoiceEdge guide adds that forwarding can also be turned on and off in the Comcast Business online account.",
          cite: ["comcast-voiceedge", "comcast-managed"],
        },
      ],
    },
    {
      id: "cloud-phone-systems",
      heading: "How do you set call forwarding in RingCentral, Zoom Phone, Nextiva, 8x8 or Google Voice?",
      blocks: [
        {
          kind: "p",
          text:
            "The cloud phone systems below set forwarding as a rule in an app or an admin portal, and several let a rule follow business hours. " +
            "The table gives each system's menu path as its own help page described it on 19 October 2026. " +
            "Menu labels change between versions, so the wording on screen may differ from the labels quoted here.",
        },
        {
          kind: "table",
          caption: "Where each business phone system sets forwarding, from its own help pages",
          head: ["System", "Where to set it", "Conditions offered", "Notes"],
          rows: [
            [
              "RingCentral (app)",
              "Settings > Phone > Call handling > Edit, then Missed calls > Forward to external number",
              "Work and After hours set separately; Edit Schedule sets custom hours",
              "With work hours set to 24 hours, 7 days a week, after hours uses the same settings",
            ],
            [
              "Zoom Phone (Zoom Workplace app)",
              "Settings > Phone > Voicemail and forwarding, on the Business hours and Closed hours tabs",
              "When I'm busy on another call; When a call goes unanswered; each can Forward to External Contacts if the account has a directory of external users",
              "Needs a direct number (DID); the optional Send unanswered calls to my voicemail toggle makes the contact press 1 before the call connects",
            ],
            [
              "Nextiva (voice portal, administrator)",
              "Users > Voice Settings > Forwarding",
              "Call forwarding (always), (busy) and (unanswered, with a number of rings); If Number Unreachable",
              "Forwards direct calls only, not call centre or call group calls; *72, the number or extension and # switch all-call forwarding on, and *73 off",
            ],
            [
              "Nextiva Location Forwarding",
              "Locations > Manage Locations > Location Features > Location Forwarding",
              "On; Off; Automatic On, which forwards when the business is closed",
              "Covers every number at the location, following a regular and a holiday schedule",
            ],
            [
              "8x8 (Admin Console)",
              "Users > Edit > Call forwarding rules",
              "Forward all Calls; When Internet Connection is Down; When User is Busy; When User does not Answer the Call",
              "External numbers need the country code",
            ],
            [
              "Google Voice",
              "Settings > Calls > Call forwarding, to numbers linked under Settings > Account",
              "Rings linked numbers, each verified by a code sent by text or call",
              "Google says forwarding calls from a Google Voice number to an automated system is unsupported",
            ],
          ],
          cite: [
            "ringcentral",
            "zoom",
            "nextiva-always",
            "nextiva-busy",
            "nextiva-no-answer",
            "nextiva-not-reachable",
            "nextiva-location",
            "eight-by-eight",
            "google-voice-linked",
          ],
        },
      ],
    },
    {
      id: "how-to-test",
      heading: "How do you test that call forwarding is working?",
      blocks: [
        {
          kind: "list",
          ordered: true,
          items: [
            "Call the clinic's published number from a phone that is not on the clinic's account, such as a personal mobile.",
            "For no-answer forwarding, let it ring without picking up, and count the rings before the call moves to the forwarding number.",
            "For busy forwarding, keep the line in use and call again; on some systems this works only with call waiting switched off.",
            "Check how the forwarded call arrives, including which number it shows as the caller.",
            "Repeat the test once inside and once outside opening hours, so that any schedule, voicemail or closed-hours greeting on the line is tested too.",
            "Cancel the forwarding, call again, and confirm the call rings at the clinic as it did before.",
          ],
          cite: ["comcast-managed", "nextiva-busy"],
        },
      ],
    },
    {
      id: "how-to-turn-off",
      heading: "How do you turn off call forwarding?",
      blocks: [
        {
          kind: "p",
          text:
            "Where each condition has its own code, cancelling one leaves the others in place, so each one switched on needs its own cancel code. " +
            "On Verizon home phones the cancel codes are *73, *91, *93 and *43, on AT&T Phone *73#, *91# and *93#, and on Comcast Business *73, *91 and *93. " +
            "Verizon mobile and Spectrum Voice use *73 for both kinds, and Verizon notes that its confirmation may sound like a busy signal. " +
            "T-Mobile uses ##21#, ##61#, ##62# and ##67#, and ##004# resets its call forwarding to the default. " +
            "On a cloud phone system, the rule is removed or changed in the same screen that created it.",
          cite: ["verizon-home", "att-phone", "comcast-managed", "verizon-article", "verizon-faq", "spectrum", "tmobile-codes"],
        },
      ],
    },
    {
      id: "does-call-forwarding-cost-extra",
      heading: "Does call forwarding cost extra?",
      blocks: [
        {
          kind: "p",
          text:
            "Verizon says there is no monthly fee for call forwarding on most of its mobile plans, though a fee may apply on certain older plans. " +
            "Without unlimited minutes, Verizon bills forwarded calls according to the plan, as if they had been answered on the mobile phone. " +
            "AT&T says additional local and long-distance charges may apply when a traditional home phone forwards a call. " +
            "Xfinity does not include call forwarding with its Xfinity Voice Unlimited Saver plan. " +
            "Spectrum says call forwarding is included with Spectrum Voice at no additional cost.",
          cite: ["verizon-faq", "att-traditional", "xfinity-qr", "spectrum"],
        },
      ],
    },
    {
      id: "if-the-answering-service-is-down",
      heading: "Where do forwarded calls go if the answering service is down?",
      blocks: [
        {
          kind: "p",
          text:
            "Once forwarding is on, the carrier sends the selected calls to the answering service's number, so an outage at the service reaches the callers it would have answered. " +
            "A service that sends calls back to the clinic during an outage needs a second clinic number that is not itself forwarded, or the returned call would be forwarded again. " +
            "AT&T Phone for Business also offers Safe Call Forwarding, switched on with *372, the forwarding number and #, and off with *373#. " +
            "AT&T says it forwards calls during a network outage, or a power outage once battery backup is exhausted, so it applies to an outage on the clinic's own line, not at the answering service. " +
            "The questions to put to a vendor about failures are in [Questions to ask any AI receptionist vendor](/standards/questions-to-ask-an-ai-receptionist-vendor).",
          cite: ["att-business"],
        },
      ],
    },
  ],
  aya: [
    "AYA is built to answer the calls a clinic forwards to it, in the coverage mode the clinic picks: all calls, overflow and after hours, or after hours only.",
    "The default is overflow and after hours, so the clinic's staff keep answering first.",
    "Where the clinic has given a direct line, AYA is designed to transfer calls to it while paused, suspended or stopped at its allowance, and when its AI model fails twice running.",
  ],
  sources: [
    {
      id: "verizon-home",
      title: "Fios Digital Voice & Traditional Star Codes & Other Calling Features",
      publisher: "Verizon",
      url: "https://www.verizon.com/support/residential/homephone/calling-features/star-codes-other-features",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "verizon-faq",
      title: "Call Forwarding FAQs",
      publisher: "Verizon",
      url: "https://www.verizon.com/support/call-forwarding-faqs/",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "verizon-article",
      title: "Call Forwarding: Everything You Need to Know",
      publisher: "Verizon",
      url: "https://www.verizon.com/articles/verizon-unlimited-plans/call-forwarding-everything-you-need-to-know/",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "att-phone",
      title: "Learn about phone calling features and star codes",
      publisher: "AT&T",
      url: "https://www.att.com/support/article/home-phone/KM1000459/",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "att-business",
      title: "Manage Call Forwarding",
      publisher: "AT&T Business",
      url: "https://www.att.com/support/smallbusiness/article/smb-local-long-distance/KM1181691/",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "att-traditional",
      title: "Learn how to forward calls",
      publisher: "AT&T",
      url: "https://www.att.com/support/article/home-phone/KM1000582/",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "att-features",
      title: "Learn about calling features and star codes",
      publisher: "AT&T",
      url: "https://www.att.com/support/article/home-phone/KM1052856/",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "att-wireless",
      title: "Troubleshoot AT&T Wireless Call Issues",
      publisher: "AT&T",
      url: "https://www.att.com/support/article/wireless/KM1062174/",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "att-wireless-home-phone",
      title: "User Guide - AT&T Wireless Home Phone",
      publisher: "AT&T",
      url: "https://www.att.com/support_static_files/manuals/ATT_Wireless_Home_Phone_WF721.pdf",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "tmobile-codes",
      title: "Self-service & short codes",
      publisher: "T-Mobile",
      url: "https://www.t-mobile.com/support/plans-features/self-service-short-codes",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "tmobile-calling",
      title: "Calling services",
      publisher: "T-Mobile",
      url: "https://www.t-mobile.com/support/plans-features/calling-services",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "spectrum",
      title: "How to Get the Most from Your Home Phone Service",
      publisher: "Spectrum",
      url: "https://www.spectrum.com/resources/home-phone/how-to-get-the-most-from-your-home-phone-service",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "xfinity-qr",
      title: "Xfinity Voice features quick reference guide",
      publisher: "Xfinity",
      url: "https://www.xfinity.com/support/articles/phone-quick-reference-guide",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "comcast-voiceedge",
      title: "Comcast Business VoiceEdge Quick Reference Guide for Panasonic KX-TPA65",
      publisher: "Comcast Business",
      url: "https://cdn.pdc.business.comcast.com/~/media/business_comcast_com/PDFs/getstarted/phone%20guides/CB_VoiceEdge-QRG_KX-TPA65_Web_QRG90387_4.17.pdf",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "comcast-managed",
      title: "Welcome to Comcast Business Managed Voice (Panasonic TPA60 user guide)",
      publisher: "Comcast Business",
      url: "https://business.comcast.com/~/media/business_comcast_com/PDFs/mv/CB-DECT-User-Guide-TPA60-r3.pdf",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "ringcentral",
      title: "Setting up user call forwarding in the RingCentral app desktop and web",
      publisher: "RingCentral",
      url: "https://support.ringcentral.com/shared/content/app/setting-up-user-call-forwarding-in-the-ringcentral-app-desktop-a.html",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "zoom",
      title: "Changing Zoom Phone voicemail and forwarding settings in the Zoom Workplace app",
      publisher: "Zoom",
      url: "https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0083324",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "nextiva-always",
      title: "Call Forwarding Always",
      publisher: "Nextiva",
      url: "https://help.nextiva.com/article/call-forwarding-always",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "nextiva-busy",
      title: "Call Forward Busy",
      publisher: "Nextiva",
      url: "https://help.nextiva.com/article/call-forward-busy",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "nextiva-no-answer",
      title: "Call Forward No Answer",
      publisher: "Nextiva",
      url: "https://help.nextiva.com/article/call-forward-no-answer",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "nextiva-not-reachable",
      title: "Call Forward Not Reachable",
      publisher: "Nextiva",
      url: "https://help.nextiva.com/article/call-forward-not-reachable",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "nextiva-location",
      title: "Location Forwarding",
      publisher: "Nextiva",
      url: "https://help.nextiva.com/article/location-forwarding-np3",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "eight-by-eight",
      title: "Set Up Call Forwarding in 8x8 Admin Console",
      publisher: "8x8",
      url: "https://help.8x8.com/docs/set-up-call-forwarding-in-8x8-admin-console",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "google-voice-linked",
      title: "Set up your phone to make & receive Google Voice calls",
      publisher: "Google",
      url: "https://support.google.com/voice/answer/165221?hl=en&co=GENIE.Platform%3DDesktop",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "google-voice-carriers",
      title: "Send your mobile phone calls to Google Voice voicemail",
      publisher: "Google",
      url: "https://support.google.com/voice/answer/165656?hl=en",
      kind: "vendor",
      checked: "2026-10-19",
    },
  ],
  related: [
    "phone-booking-and-missed-call-statistics",
    "questions-to-ask-an-ai-receptionist-vendor",
    "ai-call-transcription-consent-by-state",
  ],
};
