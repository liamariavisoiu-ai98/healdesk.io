import type { Piece } from "@/lib/content/types";

/**
 * Piece 4: the phone-booking, unanswered-call and no-show figures that vendor
 * pages repeat, each followed back to the earliest page found that states it.
 * Built on the second specimen in the house style. Every source was opened on
 * 19 October 2026; the two PubMed records were read through NCBI's E-utilities
 * because pubmed.ncbi.nlm.nih.gov served a cookie wall to the fetcher.
 *
 * What the recheck changed from the specimen: the DialogTech infographic says
 * "a third study in 2016", not "one study" (that wording is MarketingProfs'
 * summary of it); Invoca's 2026 figure is drawn from "over 70 million phone
 * calls", and only its press release calls them voice and SMS conversations.
 * A 2016 Sequence survey that search results tie to the 88 percent could not
 * be opened (eweek.com blocked the fetcher), so it is not used.
 */
export const piece: Piece = {
  slug: "phone-booking-and-missed-call-statistics",
  family: "research",
  title: "Phone-booking, unanswered-call and no-show statistics, traced to their sources",
  description:
    "Where the 88 percent phone-booking claim, unanswered-call rates and no-show figures come from, with each source's publisher and method.",
  answer:
    "The phone-booking figure repeated most often, that 88 percent of appointments are made by telephone, traces to vendor material from 2017 that gives no source or method. " +
    "Peer-reviewed studies in which researchers posed as patients found that most calls did not end with an appointment or scheduling information, but none found covers cash-pay elective practices.",
  stage: "draft",
  legal: false,
  published: "2026-10-19",
  lastReviewed: "2026-10-19",
  sections: [
    {
      id: "where-does-88-percent-come-from",
      heading: "Where does the statistic that 88% of appointments are booked by phone come from?",
      blocks: [
        {
          kind: "p",
          text:
            "The claim that 88 percent of appointments are still made by telephone appears on vendor pages and in trade coverage. " +
            "The earliest source found is an April 2017 commentary on the trade site Healthcare Innovation by Jamie Gier, chief marketing officer of SCI Solutions. " +
            "SCI operated a cloud-based service that physician practices and hospitals used to schedule patients, obtain insurance authorisations and automate referrals. " +
            "The infographic published with the commentary says \"88% of appointments are still scheduled by phone\", and neither the infographic nor the text names a source or a method for it.",
          cite: ["hci-2017"],
        },
        {
          kind: "p",
          text:
            "A parallel chain of citations ends at a 2017 infographic by DialogTech, which on the same graphic recommends call tracking to healthcare marketers. " +
            "It says that \"a third study in 2016\" found 88 percent \"of doctors' appointments are scheduled by phone\", without naming the study. " +
            "Its footer lists seven sources, from Google to Televox, but does not say which one supports which figure. " +
            "No 2016 study stating the figure could be opened for this page, so the 2017 commentary remains the earliest source found.",
          cite: ["dialogtech-2017"],
        },
      ],
    },
    {
      id: "do-missed-appointments-cost-150-billion",
      heading: "Do missed appointments cost the US health system $150 billion a year?",
      blocks: [
        {
          kind: "p",
          text:
            "The same April 2017 commentary puts the total yearly cost of missed healthcare appointments in the United States at \"$150 billion\". " +
            "It names no source, and its only support is that each unused slot costs \"a physician 60 minutes and $200 on average\" and that no-show rates run \"as high as 30% nationwide\". " +
            "The commentary does not show how those inputs produce the total, so the figure is a vendor estimate without a stated method. " +
            "The 2017 DialogTech infographic repeats the $150 billion, again without saying which of its listed sources supports it.",
          cite: ["hci-2017", "dialogtech-2017"],
        },
      ],
    },
    {
      id: "how-many-calls-go-unanswered",
      heading: "How many calls to healthcare practices go unanswered?",
      blocks: [
        {
          kind: "p",
          text:
            "Invoca, a call-tracking vendor, published benchmarks in July 2026 drawn from over 70 million phone calls tracked on its platform across ten industries. " +
            "In this vendor data, 54 percent of all inbound calls to its healthcare customers were answered by a person, rising to 65 percent for calls longer than 15 seconds. " +
            "The healthcare figures cover behavioural health and rehab, dental, eye care, hearing, hospitals and physical therapy. " +
            "Invoca presents every figure as an average across its customer base and does not state the period or the number of healthcare calls.",
          cite: ["invoca-2026-healthcare", "invoca-2026-blog"],
        },
        {
          kind: "p",
          text:
            "An earlier Invoca infographic for healthcare marketers, citing its 2021 customer data, put the average unanswered share for healthcare at 29 percent. " +
            "By segment it ran from 17 percent in senior care to 37 percent in dental, again as vendor data. " +
            "Neither page defines an unanswered call or says whether the 2021 and 2026 figures use the same definition, and the 2026 report does not mention the earlier figure. " +
            "The groupings also differ, since senior care sat inside healthcare in 2021 and is reported as a separate industry in 2026.",
          cite: ["invoca-2021", "invoca-2026-healthcare", "invoca-2026-blog"],
        },
        {
          kind: "p",
          text:
            "A figure often quoted beside these, that nearly three in four consumers would switch providers after a poor contact-centre experience, comes from CallMiner's 2020 US Churn Index. " +
            "CallMiner sells speech and conversation analytics, and the survey was carried out for it by 3Gem Research & Insights. " +
            "It asked 2,000 US adults who had contacted a provider in the previous 12 months, online in March 2020, and recorded what they said they would do. " +
            "It covered providers in general and named banks and broadband providers as the industries with the highest churn. " +
            "A bullet in the same release says 7 percent were likely to switch after a negative call, and the release does not reconcile that with its headline.",
          cite: ["callminer-2020"],
        },
      ],
    },
    {
      id: "how-often-do-callers-get-through",
      heading: "How often do patients who call a medical practice get through?",
      blocks: [
        {
          kind: "p",
          text:
            "Studies in which researchers pose as patients measure access by phone directly, and the peer-reviewed ones found cover other kinds of care. " +
            "In a 2024 study in JAMA Network Open, trained callers posing as new patients with colon, lung or thyroid cancer rang 479 clinic numbers at 143 hospitals in 12 states. " +
            "Between November 2021 and March 2023 they were given an appointment date or scheduling information in 409 of 985 calls, or 41.5 percent. " +
            "The rate was 61.4 percent for calls in English, 36.4 percent in Spanish and 19.0 percent in Mandarin.",
          cite: ["jama-2024"],
        },
        {
          kind: "p",
          text:
            "In a 2015 study in Psychiatric Services, investigators posing as patients called 360 psychiatrists listed in a major insurer's database in Boston, Houston and Chicago. " +
            "They reached 119 in the first round of calls, 36 percent of the 216 unanswered calls were returned, and after two rounds 93 psychiatrists, or 26 percent, gave an appointment. " +
            "Callers said they had Blue Cross Blue Shield or Medicare or would pay out of pocket, and the authors found significant differences between cities but not between payer types. " +
            "No comparable peer-reviewed study of aesthetic, plastic-surgery or other cash-pay elective practices turned up in the searches for this piece.",
          cite: ["psychserv-2015"],
        },
      ],
    },
    {
      id: "what-is-the-no-show-rate",
      heading: "What is the average no-show rate for medical appointments?",
      blocks: [
        {
          kind: "p",
          text:
            "A 2018 systematic review in Health Policy analysed 105 studies of missed appointments, selected from 727 papers retrieved from the Scopus database. " +
            "It found an average no-show rate \"of the order of 23%\", highest in Africa at 43.0 percent and lowest in Oceania at 13.2 percent. " +
            "The determinants the studies most often reported as significant were a long lead time between booking and the visit and a history of earlier no-shows. " +
            "The review spans all medical specialties and many countries, so its average describes no single kind of practice.",
          cite: ["dantas-2018"],
        },
        {
          kind: "p",
          text:
            "The nearest setting found is one academic plastic-surgery clinic in Huntington, West Virginia, whose services range from aesthetic procedures to reconstruction. " +
            "A 2025 study in Cureus counted 277 missed appointments among 2,002 between October 2022 and October 2024, a no-show rate of 13.8 percent. " +
            "The authors note the retrospective design and small sample as limitations. " +
            "The paper's statements about self-pay patients conflict between its abstract and its results, and its counts by insurance type do not match its totals, so this page does not use them.",
          cite: ["rahimpour-2025"],
        },
        {
          kind: "p",
          text:
            "No peer-reviewed no-show figure for cash-pay elective practices, such as medical spas or private aesthetic clinics, turned up in the searches for this piece. " +
            "The 2017 commentary says no-show rates run \"as high as 30% nationwide\", and the DialogTech infographic lists rates by specialty from 10 to 37 percent. " +
            "Neither says which study or population the rates describe, so this page does not rely on them.",
          cite: ["hci-2017", "dialogtech-2017"],
        },
      ],
    },
    {
      id: "how-this-was-traced",
      heading: "How were these statistics traced?",
      blocks: [
        {
          kind: "p",
          text:
            "Each figure was followed back through the pages that repeat it to the earliest page found that states it, and every page cited here was opened on 19 October 2026. " +
            "Peer-reviewed findings are stated plainly, and figures drawn from a company's own customers or surveys are labelled as vendor data. " +
            "A figure whose source could not be opened is not used, which is why a 2016 study behind the 88 percent, dated only by the DialogTech infographic, does not appear.",
        },
        {
          kind: "table",
          caption: "Each figure, its earliest source found, and whether a method is stated",
          head: ["Figure", "Earliest source found", "Kind of source", "Method stated"],
          rows: [
            ["88% of appointments booked by phone", "Healthcare Innovation commentary by SCI Solutions' chief marketing officer, April 2017", "Vendor", "No"],
            ["88%, attributed to \"a third study in 2016\"", "DialogTech infographic, 2017", "Vendor", "No; seven sources listed, none matched to the figure"],
            ["$150 billion a year in missed appointments", "Healthcare Innovation commentary, April 2017", "Vendor", "No; two inputs named, no calculation shown"],
            ["Nearly three in four would switch after a poor contact-centre experience", "CallMiner 2020 US Churn Index, May 2020", "Vendor survey", "Yes: online survey of 2,000 US adults, March 2020"],
            ["54% of inbound healthcare calls answered by a person", "Invoca benchmarks, July 2026", "Vendor data", "Partly: averages across its customers; no period or healthcare sample size"],
            ["29% of healthcare calls unanswered", "Invoca infographic citing its 2021 customer data", "Vendor data", "No definition of an unanswered call"],
            ["41.5% of simulated calls reached cancer care", "JAMA Network Open, 2024", "Peer-reviewed", "Yes"],
            ["119 of 360 psychiatrists reached in a first round", "Psychiatric Services, 2015", "Peer-reviewed", "Yes"],
            ["Average no-show rate of about 23%", "Health Policy systematic review, 2018", "Peer-reviewed", "Yes"],
            ["13.8% no-show rate at one plastic-surgery clinic", "Cureus, 2025", "Peer-reviewed", "Yes; one clinic, retrospective"],
          ],
          cite: [
            "hci-2017",
            "dialogtech-2017",
            "callminer-2020",
            "invoca-2026-healthcare",
            "invoca-2021",
            "jama-2024",
            "psychserv-2015",
            "dantas-2018",
            "rahimpour-2025",
          ],
        },
      ],
    },
  ],
  aya: [
    "AYA is built to answer the calls a clinic forwards to it, in the coverage mode the clinic picks.",
    "Its reports are designed to count the conversations it handled and the appointments it booked.",
  ],
  sources: [
    {
      id: "hci-2017",
      title: "Missed appointments cost the U.S. healthcare system $150B each year",
      publisher: "Healthcare Innovation (commentary by Jamie Gier, SCI Solutions)",
      url: "https://www.hcinnovationgroup.com/clinical-it/article/13008175/missed-appointments-cost-the-us-healthcare-system-150b-each-year",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "dialogtech-2017",
      title: "Somebody Call a Doctor (infographic)",
      publisher: "DialogTech, as published by MarketingProfs",
      url: "https://i.marketingprofs.com/assets/images/daily-chirp/171003-infographic-healthcare-marketing-full.jpg",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "callminer-2020",
      title: "Nearly 74% of Consumers Will Switch Providers After a Poor Contact Center Experience, According to New Research",
      publisher: "CallMiner",
      url: "https://callminer.com/news/press-releases/nearly-74-of-consumers-will-switch-providers-after-a-poor-contact-center",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "invoca-2026-healthcare",
      title: "The Healthcare Lead Conversion Benchmarks Report 2026",
      publisher: "Invoca",
      url: "https://www.invoca.com/reports/the-invoca-healthcare-lead-conversion-benchmarks-report-2026",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "invoca-2026-blog",
      title: "7 Insights From Analyzing 70 Million Phone Conversations: 2026 Report",
      publisher: "Invoca",
      url: "https://www.invoca.com/blog/5-insights-60-million-phone-conversations",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "invoca-2021",
      title: "The Cost of Missed Appointment Calls for Healthcare Marketers",
      publisher: "Invoca",
      url: "https://www.invoca.com/infographics/the-cost-of-missed-appointment-calls-for-healthcare-marketers",
      kind: "vendor",
      checked: "2026-10-19",
    },
    {
      id: "jama-2024",
      title: "Access to New Clinic Appointments for Patients With Cancer",
      publisher: "JAMA Network Open, via PubMed Central",
      url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC11161839/",
      kind: "peer-reviewed",
      checked: "2026-10-19",
    },
    {
      id: "psychserv-2015",
      title: "Availability of outpatient care from psychiatrists: a simulated-patient study in three U.S. cities",
      publisher: "Psychiatric Services, via PubMed",
      url: "https://pubmed.ncbi.nlm.nih.gov/25322445/",
      kind: "peer-reviewed",
      checked: "2026-10-19",
    },
    {
      id: "dantas-2018",
      title: "No-shows in appointment scheduling - a systematic literature review",
      publisher: "Health Policy, via PubMed",
      url: "https://pubmed.ncbi.nlm.nih.gov/29482948/",
      kind: "peer-reviewed",
      checked: "2026-10-19",
    },
    {
      id: "rahimpour-2025",
      title: "No-Show Rates at a Plastic Surgery Clinic: Insights From Appalachian Healthcare Systems",
      publisher: "Cureus, via PubMed Central",
      url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC11787945/",
      kind: "peer-reviewed",
      checked: "2026-10-19",
    },
  ],
  related: ["conditional-call-forwarding", "questions-to-ask-an-ai-receptionist-vendor"],
};
