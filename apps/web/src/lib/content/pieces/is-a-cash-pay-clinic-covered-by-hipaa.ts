import type { Piece } from "@/lib/content/types";

/**
 * Every statement was read against its primary text on 19 October 2026.
 * California's Civil Code sections and AB 1979 (chaptered text) were read in
 * the Legislature's own bulk database (downloads.leginfo.legislature.ca.gov,
 * pubinfo_2025.zip, by range requests), because leginfo's pages refuse
 * automated loads; the URLs below are the leginfo pages for the same text.
 * The Connecticut General Assembly's site sends an incomplete certificate
 * chain; it was read once the issuer's published intermediate certificate
 * was supplied, with verification left on. The FTC page refused plain
 * automated loads and was read through a page fetcher.
 */

export const piece: Piece = {
  slug: "is-a-cash-pay-clinic-covered-by-hipaa",
  family: "guides",
  title: "Is a cash-pay clinic covered by HIPAA?",
  description:
    "HIPAA covers a provider that sends health information electronically in a type of transaction HHS has adopted a standard for. What that means for cash-pay practices.",
  answer:
    "A clinic is a HIPAA covered entity only if it, or an entity acting for it, sends health information electronically in connection with a type of transaction for which HHS has adopted a standard. Those types include insurance claims and eligibility checks, so a practice paid only by its patients may sit outside HIPAA, while state health privacy laws and the FTC Act can still reach it.",
  stage: "live",
  legal: true,
  review: "Every statement was checked against the primary texts on 19 October 2026 by an independent AI review, not by a lawyer.",
  published: "2026-10-19",
  lastReviewed: "2026-10-19",
  sections: [
    {
      id: "what-makes-a-provider-a-covered-entity",
      heading: "What makes a health care provider a HIPAA covered entity?",
      blocks: [
        {
          kind: "p",
          text: "HIPAA’s rules apply to health plans, health care clearinghouses and a defined group of health care providers, which the regulations call covered entities. Under [45 CFR 160.103](https://www.law.cornell.edu/cfr/text/45/160.103), a provider is covered when it “transmits any health information in electronic form in connection with a transaction covered by this subchapter”. The same section defines a health care provider to include any person or organisation that “furnishes, bills, or is paid for health care in the normal course of business”.",
          cite: ["cfr-160-103"],
        },
        {
          kind: "p",
          text: "Neither the covered-entity definition nor the business-associate definition turns on a practice’s specialty, its size or whether patients pay in cash. CMS’s page for providers puts the test in one line: “Providers who submit HIPAA transactions, like claims, electronically are covered.”",
          cite: ["cfr-160-103", "cms-covered-entities"],
        },
      ],
    },
    {
      id: "which-transactions-count",
      heading: "Which transactions count?",
      blocks: [
        {
          kind: "p",
          text: "The transactions that count are those for which HHS has adopted a standard, set out in [45 CFR Part 162](https://www.law.cornell.edu/cfr/text/45/part-162). Section 160.103 defines a transaction as the transmission of information between two parties “to carry out financial or administrative activities related to health care”, and lists the types below. Part 162 adopts no standard for first report of injury, and its claims attachments standard applies from 26 May 2028. A claim is a provider’s request to a health plan for payment for health care. An eligibility transaction is either a provider’s inquiry to a health plan about an enrollee’s eligibility, coverage or benefits, or the plan’s response.",
          cite: ["cfr-160-103", "cfr-part-162", "cfr-162-1101", "cfr-162-1201"],
        },
        {
          kind: "list",
          items: [
            "Health care claims or equivalent encounter information",
            "Health care payment and remittance advice",
            "Coordination of benefits",
            "Health care claim status",
            "Enrollment and disenrollment in a health plan",
            "Eligibility for a health plan",
            "Health plan premium payments",
            "Referral certification and authorization",
            "First report of injury",
            "Health care claims attachments",
            "Health care electronic funds transfers (EFT) and remittance advice",
            "Other transactions that the Secretary may prescribe by regulation",
          ],
          cite: ["cfr-160-103", "cfr-part-162"],
        },
      ],
    },
    {
      id: "a-practice-that-never-bills-insurance",
      heading: "Is a practice that never bills insurance covered by HIPAA?",
      blocks: [
        {
          kind: "p",
          text: "CMS’s [Covered Entity Decision Tool](https://www.cms.gov/regulations-and-guidance/administrative-simplification/hipaa-aca/downloads/coveredentitieschart20160617.pdf) asks two questions of a provider. The first is whether it furnishes, bills or receives payment for health care in the normal course of business. The second is whether it sends “any covered transactions electronically”, and a provider that answers no is, in the tool’s conclusion, not a covered health care provider and therefore not a covered entity. Whether a particular practice sends any of those transactions depends on its own billing, its software and the contracts it has signed.",
          cite: ["cms-decision-tool"],
        },
        {
          kind: "p",
          text: "The tool also counts transactions that someone else sends for the provider. Its endnote says that if a provider uses another entity, such as a clearinghouse, to conduct covered transactions on its behalf, “the health care provider is considered to be conducting the transaction in electronic form”. Section 162.923 of the regulations lets a covered entity use a business associate, including a clearinghouse, to conduct a transaction covered by Part 162. On the tool’s reading, a billing company that submits electronic claims for a practice makes the practice the one conducting them, even if its own staff never handle a claim.",
          cite: ["cms-decision-tool", "cfr-162-923"],
        },
      ],
    },
    {
      id: "one-claim-or-one-eligibility-check",
      heading: "Can one insurance claim make a cash-pay practice a covered entity?",
      blocks: [
        {
          kind: "p",
          text: "The covered-entity definition speaks of “any health information” sent in connection with a covered transaction, and the decision tool asks whether a provider sends “any covered transactions electronically”. Neither text sets a minimum number of transactions or a minimum share of income from insurance. Once a provider is covered, the definition of protected health information extends to information “transmitted or maintained in any other form or medium”, not only to electronic records.",
          cite: ["cfr-160-103", "cms-decision-tool"],
        },
      ],
    },
    {
      id: "business-associates",
      heading: "When does a vendor need a business associate agreement?",
      blocks: [
        {
          kind: "p",
          text: "A business associate is a person who, on behalf of a covered entity, “creates, receives, maintains, or transmits protected health information” for a regulated function, or provides certain services involving its disclosure. [Section 164.502(e)](https://www.law.cornell.edu/cfr/text/45/164.502) permits a covered entity to disclose protected health information to a business associate if it obtains “satisfactory assurance” that the information will be safeguarded. Those assurances must be documented in “a written contract or other written agreement or arrangement” that meets [section 164.504(e)](https://www.law.cornell.edu/cfr/text/45/164.504). That section requires the contract to bar uses beyond those it permits, to require safeguards and reporting, and to provide for return or destruction of the information at termination “if feasible”.",
          cite: ["cfr-160-103", "cfr-164-502", "cfr-164-504"],
        },
        {
          kind: "p",
          text: "The business associate definition is framed “with respect to a covered entity”, and each duty above runs from a covered entity to the vendor acting on its behalf. A subcontractor that handles protected health information for a business associate is itself a business associate under the same definition. Where a practice is not a covered entity, privacy terms between it and a vendor come from their contract and from any state or federal law that applies.",
          cite: ["cfr-160-103", "cfr-164-502"],
        },
        {
          kind: "p",
          text: "Two of those state laws set contract rules of their own for vendors that handle consumer health data. Washington allows a processor to handle such data “only pursuant to a binding contract” that sets out processing instructions and limits what the processor may do. Nevada requires a processor to work under a contract between the processor and the regulated entity that sets out “the applicable processing instructions”.",
          cite: ["rcw-19-373", "nrs-603a"],
        },
      ],
    },
    {
      id: "laws-outside-hipaa",
      heading: "Which laws reach health data outside HIPAA?",
      blocks: [
        {
          kind: "p",
          text: "Several laws reach health data that HIPAA does not. Washington’s legislature found in 2023 that HIPAA “only covers health data collected by specific health care entities, including most health care providers”, and that data collected by others “are not afforded the same protections”. Nevada and Connecticut enacted consumer health data provisions the same year, and California’s medical privacy act defines the providers it binds by licence. The FTC says its Act applies whether or not a business is covered by HIPAA, and each law has its own scope and exemptions, and those decide whether it reaches a given practice.",
          cite: ["rcw-19-373", "nrs-603a", "ct-743jj-2026", "ca-civ-56-05", "ftc-health-guidance"],
        },
        { kind: "h3", text: "Washington: the My Health My Data Act" },
        {
          kind: "p",
          text: "Washington’s [My Health My Data Act](https://app.leg.wa.gov/RCW/default.aspx?cite=19.373&full=true) defines consumer health data as personal information linked or reasonably linkable to a consumer that identifies their “past, present, or future physical or mental health status”. Its examples include “health-related surgeries or procedures” and “data that identifies a consumer seeking health care services”. Since 31 March 2024, a regulated entity may collect such data only with consent for a specified purpose, or as necessary to provide a product or service the consumer requested. For a small business, as the Act defines one, that rule applied from 30 June 2024. A violation is an unfair or deceptive act for the purpose of the state’s Consumer Protection Act, chapter 19.86 RCW.",
          cite: ["rcw-19-373"],
        },
        {
          kind: "p",
          text: "The Act exempts protected health information under HIPAA, and it separately exempts “health care information collected, used, or disclosed in accordance with chapter 70.02 RCW”. That chapter governs medical records and health care information, and it defines a health care provider as a person licensed, certified, registered or otherwise authorised by Washington law to provide health care. Its definition does not depend on electronic transactions, and the Act does not say how its two exemptions apply to a licensed provider that HIPAA does not cover.",
          cite: ["rcw-19-373", "rcw-70-02-010"],
        },
        { kind: "h3", text: "Nevada: NRS 603A.400 to 603A.550" },
        {
          kind: "p",
          text: "Nevada’s consumer health data law was enacted in 2023 as [Senate Bill 370](https://www.leg.state.nv.us/Session/82nd2023/Bills/SB/SB370_EN.pdf) and sits in [NRS 603A.400 to 603A.550](https://www.leg.state.nv.us/NRS/NRS-603A.html). A regulated entity may collect consumer health data only with “the affirmative, voluntary consent of the consumer”, or to the extent necessary to provide a product or service the consumer requested. The provisions do not apply to “any person or entity that is subject to” HIPAA. They separately exempt personally identifiable information governed by Part C of Title XI of the Social Security Act and collected, used or disclosed pursuant to it. Except as the statute provides for processors, a violation is a deceptive trade practice, and the statute states that the provisions do not create a private right of action.",
          cite: ["nv-sb370", "nrs-603a"],
        },
        { kind: "h3", text: "Connecticut: consumer health data in chapter 743jj" },
        {
          kind: "p",
          text: "Connecticut added consumer health data to its [data privacy chapter](https://www.cga.ct.gov/2026/sup/chap_743jj.htm) in 2023, through Public Act 23-56. Since 1 July 2026, the chapter defines consumer health data as personal data a controller uses to identify a consumer’s “physical or mental health condition, diagnosis or status”, and lists it as sensitive data. The chapter’s general duties now also reach persons that “control or process consumers’ sensitive data, excluding personal data controlled or processed solely for the purposes of completing a payment transaction”. Section 42-520 conditions their processing of sensitive data on, among other things, the consumer’s consent. [Public Act 26-64](https://www.cga.ct.gov/2026/ACT/PA/PDF/2026PA-00064-R00SB-00004-PA.PDF), in force since 1 October 2026, amended both sections again and kept that definition and that consent condition. Section 42-526 bars a person from selling consumer health data without consent, and limits who may be given access to it.",
          cite: ["ct-743jj-2026", "ct-pa-26-64", "ct-743jj"],
        },
        {
          kind: "p",
          text: "The Attorney General’s office says the consumer health data provisions have no revenue or processing thresholds, and it lists “Entities subject to the Health Insurance Portability and Accountability Act” among exempt entities. In the statute, sections 42-517 and 42-526 each exempt a “covered entity or business associate, as defined in 45 CFR 160.103”. A practice that is neither does not come within those words. Section 42-526 applies the consumer health data provisions to persons that do business in the state or target products or services at its residents.",
          cite: ["ct-ag-ctdpa", "ct-743jj-2026", "ct-743jj"],
        },
        { kind: "h3", text: "California: the Confidentiality of Medical Information Act" },
        {
          kind: "p",
          text: "California’s [Confidentiality of Medical Information Act](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=56.05) defines a provider of health care by licence, including a person licensed or certified under Division 2 of the Business and Professions Code. The definition does not turn on electronic transactions or on how patients pay. [Section 56.10](https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=56.10) bars such a provider from disclosing a patient’s medical information “without first obtaining an authorization”, except as that section provides.",
          cite: ["ca-civ-56-05", "ca-civ-56-10"],
        },
        {
          kind: "p",
          text: "From 1 January 2027, [AB 1979](https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202520260AB1979) (Statutes of 2026, chapter 854) deems a business that offers a “health care chatbot” to a consumer a provider of health care subject to the Act’s requirements. That applies where the chatbot is offered so the individual can manage their information, or for the diagnosis, treatment or management of a medical condition. Under the amended section 56.05, such a chatbot is a generative artificial intelligence system with a natural language interface that gives adaptive, human-like responses and is marketed as facilitating or supporting health services. It must also use information about a consumer’s physical or mental health or wellness to facilitate or support health services. The chaptered text does not say whether an assistant that answers a clinic’s phone or chat to book visits is offered for those purposes.",
          cite: ["ca-ab-1979"],
        },
        { kind: "h3", text: "Federal: the FTC Act" },
        {
          kind: "p",
          text: "Section 5 of the [FTC Act](https://www.law.cornell.edu/uscode/text/15/45) declares “unfair or deceptive acts or practices in or affecting commerce” unlawful. The FTC’s health guidance says the Act also applies to “companies that collect, use, or share health information that aren’t required to comply with HIPAA”. The same guidance tells businesses not to mislead consumers about what happens to their health information, and not to bury key facts in a privacy policy or terms of use. It also warns against false or misleading claims to be “HIPAA Certified” or the like.",
          cite: ["usc-15-45", "ftc-health-guidance"],
        },
        { kind: "h3", text: "Federal: the Health Breach Notification Rule" },
        {
          kind: "p",
          text: "The FTC’s [Health Breach Notification Rule](https://www.law.cornell.edu/cfr/text/16/318.1), 16 CFR Part 318, applies to vendors of personal health records, PHR related entities and third party service providers. It “does not apply to HIPAA-covered entities”, or to any other entity “to the extent that it engages in activities as a business associate” of one. A personal health record, in the rule’s definition, is an electronic record that can draw information from multiple sources and is “managed, shared, and controlled by or primarily for the individual”. Whether the rule reaches a practice turns on whether it offers or maintains such a record, or is a PHR related entity or a third party service provider.",
          cite: ["cfr-318-1", "cfr-318-2", "ftc-health-guidance"],
        },
      ],
    },
    {
      id: "what-decides-the-answer",
      heading: "What decides the answer for a particular practice?",
      blocks: [
        {
          kind: "p",
          text: "Whether a cash-pay practice is covered by HIPAA, and which other laws reach its patient data, turns on facts that differ from one practice to the next. On the texts above, the facts listed below are among those that bear on the answer, and two practices offering the same treatments can reach different answers.",
        },
        {
          kind: "list",
          ordered: true,
          items: [
            "Whether the practice electronically sends any transaction of a type HHS has adopted a standard for, such as a claim for one insured patient or an eligibility inquiry to a health plan.",
            "Whether a billing company, clearinghouse or other entity sends such transactions on the practice’s behalf, which CMS’s decision tool counts as the practice’s own.",
            "Where its patients live and where their data is collected, since the Washington, Nevada and Connecticut laws define their reach by residence, collection in the state or business done there.",
            "Whether the practice or its clinicians hold a California licence that makes them a provider of health care under the Confidentiality of Medical Information Act.",
            "Whether the practice falls within one of those laws’ exemptions, which name HIPAA-covered entities, HIPAA-protected information or, in Washington, information handled under chapter 70.02 RCW.",
            "Whether the practice offers or maintains a personal health record in the FTC rule’s sense.",
            "What its contracts with vendors say about health data, where no business associate agreement is required.",
          ],
          cite: ["cms-decision-tool", "cfr-160-103", "rcw-19-373", "nrs-603a", "ct-743jj", "ca-civ-56-05", "cfr-318-2"],
        },
      ],
    },
  ],
  aya: [
    "AYA is designed to handle a practice’s patient data only under the agreement the practice signs at checkout, which is a business associate agreement where HIPAA covers the practice.",
    "For a med spa, hair restoration, massage or chiropractic practice that says it bills no insurance electronically, AYA is designed to work under healdesk’s data protection agreement instead, with HIPAA Security Rule safeguards.",
    "A practice that is not sure, or whose specialty is plastic surgery, fertility, dental care or GLP-1 treatment, signs the business associate agreement.",
  ],
  sources: [
    {
      id: "cfr-160-103",
      title: "45 CFR 160.103, Definitions",
      publisher: "Legal Information Institute, Cornell Law School (text of the Code of Federal Regulations)",
      url: "https://www.law.cornell.edu/cfr/text/45/160.103",
      kind: "regulation",
      checked: "2026-10-19",
    },
    {
      id: "cfr-part-162",
      title: "45 CFR Part 162",
      publisher: "Legal Information Institute, Cornell Law School (text of the Code of Federal Regulations)",
      url: "https://www.law.cornell.edu/cfr/text/45/part-162",
      kind: "regulation",
      checked: "2026-10-19",
    },
    {
      id: "cfr-162-923",
      title: "45 CFR 162.923, Requirements for covered entities",
      publisher: "Legal Information Institute, Cornell Law School (text of the Code of Federal Regulations)",
      url: "https://www.law.cornell.edu/cfr/text/45/162.923",
      kind: "regulation",
      checked: "2026-10-19",
    },
    {
      id: "cfr-162-1101",
      title: "45 CFR 162.1101, Health care claims or equivalent encounter information transaction",
      publisher: "Legal Information Institute, Cornell Law School (text of the Code of Federal Regulations)",
      url: "https://www.law.cornell.edu/cfr/text/45/162.1101",
      kind: "regulation",
      checked: "2026-10-19",
    },
    {
      id: "cfr-162-1201",
      title: "45 CFR 162.1201, Eligibility for a health plan transaction",
      publisher: "Legal Information Institute, Cornell Law School (text of the Code of Federal Regulations)",
      url: "https://www.law.cornell.edu/cfr/text/45/162.1201",
      kind: "regulation",
      checked: "2026-10-19",
    },
    {
      id: "cms-covered-entities",
      title: "Are You a Covered Entity?",
      publisher: "Centers for Medicare & Medicaid Services",
      url: "https://www.cms.gov/priorities/key-initiatives/burden-reduction/administrative-simplification/hipaa/covered-entities",
      kind: "government",
      checked: "2026-10-19",
    },
    {
      id: "cms-decision-tool",
      title: "Covered Entity Decision Tool",
      publisher: "Centers for Medicare & Medicaid Services",
      url: "https://www.cms.gov/regulations-and-guidance/administrative-simplification/hipaa-aca/downloads/coveredentitieschart20160617.pdf",
      kind: "government",
      checked: "2026-10-19",
    },
    {
      id: "cfr-164-502",
      title: "45 CFR 164.502, Uses and disclosures of protected health information: General rules",
      publisher: "Legal Information Institute, Cornell Law School (text of the Code of Federal Regulations)",
      url: "https://www.law.cornell.edu/cfr/text/45/164.502",
      kind: "regulation",
      checked: "2026-10-19",
    },
    {
      id: "cfr-164-504",
      title: "45 CFR 164.504, Uses and disclosures: Organizational requirements",
      publisher: "Legal Information Institute, Cornell Law School (text of the Code of Federal Regulations)",
      url: "https://www.law.cornell.edu/cfr/text/45/164.504",
      kind: "regulation",
      checked: "2026-10-19",
    },
    {
      id: "ftc-health-guidance",
      title:
        "Collecting, Using, or Sharing Consumer Health Information? Look to HIPAA, the FTC Act, and the Health Breach Notification Rule",
      publisher: "Federal Trade Commission",
      url: "https://www.ftc.gov/business-guidance/resources/collecting-using-or-sharing-consumer-health-information-look-hipaa-ftc-act-health-breach",
      kind: "government",
      checked: "2026-10-19",
    },
    {
      id: "rcw-19-373",
      title: "Chapter 19.373 RCW, Washington my health my data act",
      publisher: "Washington State Legislature",
      url: "https://app.leg.wa.gov/RCW/default.aspx?cite=19.373&full=true",
      kind: "statute",
      checked: "2026-10-19",
    },
    {
      id: "rcw-70-02-010",
      title: "RCW 70.02.010, Definitions",
      publisher: "Washington State Legislature",
      url: "https://app.leg.wa.gov/RCW/default.aspx?cite=70.02.010",
      kind: "statute",
      checked: "2026-10-19",
    },
    {
      id: "nv-sb370",
      title: "Senate Bill No. 370 (2023), enrolled",
      publisher: "Nevada Legislature",
      url: "https://www.leg.state.nv.us/Session/82nd2023/Bills/SB/SB370_EN.pdf",
      kind: "statute",
      checked: "2026-10-19",
    },
    {
      id: "nrs-603a",
      title: "NRS Chapter 603A, Security and Privacy of Personal Information (NRS 603A.400 to 603A.550)",
      publisher: "Nevada Legislature",
      url: "https://www.leg.state.nv.us/NRS/NRS-603A.html",
      kind: "statute",
      checked: "2026-10-19",
    },
    {
      id: "ct-743jj-2026",
      title: "Connecticut General Statutes, chapter 743jj, Data Privacy and Security (2026 Supplement)",
      publisher: "Connecticut General Assembly",
      url: "https://www.cga.ct.gov/2026/sup/chap_743jj.htm",
      kind: "statute",
      checked: "2026-10-19",
    },
    {
      id: "ct-743jj",
      title: "Connecticut General Statutes, chapter 743jj, § 42-526",
      publisher: "Connecticut General Assembly",
      url: "https://www.cga.ct.gov/current/pub/chap_743jj.htm#sec_42-526",
      kind: "statute",
      checked: "2026-10-19",
    },
    {
      id: "ct-pa-26-64",
      title: "Public Act No. 26-64 (Substitute Senate Bill No. 4), An Act Concerning Consumer Privacy and Protection",
      publisher: "Connecticut General Assembly",
      url: "https://www.cga.ct.gov/2026/ACT/PA/PDF/2026PA-00064-R00SB-00004-PA.PDF",
      kind: "statute",
      checked: "2026-10-19",
    },
    {
      id: "ca-civ-56-05",
      title: "California Civil Code § 56.05, Confidentiality of Medical Information Act definitions",
      publisher: "California Legislature",
      url: "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=56.05",
      kind: "statute",
      checked: "2026-10-19",
    },
    {
      id: "ca-civ-56-10",
      title: "California Civil Code § 56.10",
      publisher: "California Legislature",
      url: "https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=56.10",
      kind: "statute",
      checked: "2026-10-19",
    },
    {
      id: "ca-ab-1979",
      title: "AB 1979, Health care services: artificial intelligence (Statutes of 2026, chapter 854)",
      publisher: "California Legislature",
      url: "https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202520260AB1979",
      kind: "statute",
      checked: "2026-10-19",
    },
    {
      id: "ct-ag-ctdpa",
      title: "The Connecticut Data Privacy Act",
      publisher: "Connecticut Office of the Attorney General",
      url: "https://portal.ct.gov/ag/sections/privacy/the-connecticut-data-privacy-act",
      kind: "government",
      checked: "2026-10-19",
    },
    {
      id: "usc-15-45",
      title: "15 U.S.C. 45, Unfair methods of competition unlawful; prevention by Commission",
      publisher: "Legal Information Institute, Cornell Law School (text of the United States Code)",
      url: "https://www.law.cornell.edu/uscode/text/15/45",
      kind: "statute",
      checked: "2026-10-19",
    },
    {
      id: "cfr-318-1",
      title: "16 CFR 318.1, Purpose and scope",
      publisher: "Legal Information Institute, Cornell Law School (text of the Code of Federal Regulations)",
      url: "https://www.law.cornell.edu/cfr/text/16/318.1",
      kind: "regulation",
      checked: "2026-10-19",
    },
    {
      id: "cfr-318-2",
      title: "16 CFR 318.2, Definitions",
      publisher: "Legal Information Institute, Cornell Law School (text of the Code of Federal Regulations)",
      url: "https://www.law.cornell.edu/cfr/text/16/318.2",
      kind: "regulation",
      checked: "2026-10-19",
    },
  ],
  related: [
    "ai-call-transcription-consent-by-state",
    "questions-to-ask-an-ai-receptionist-vendor",
    "state-ai-disclosure-and-consent-tracker",
  ],
};
