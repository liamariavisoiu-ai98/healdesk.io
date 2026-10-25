/**
 * The console's places an alert step may name: each page, tab, card or
 * button, with the apps/web file and text that prove it exists today, and
 * whether it is a page or card (where to go) or a button (what to press
 * there). The wording lint (tests/alert-wording.test.ts) checks every proof
 * against apps/web's source and holds each step to naming one; the renderer
 * (./markup.ts emphasisePlaces) bolds and underlines them in a step, so the
 * reader's eye lands on what to open or press (lane N4). A new place goes
 * here with its proof.
 */
export type Place = readonly [file: string, proof: string, kind: "page" | "button"];

export const PLACES: Readonly<Record<string, Place>> = {
  "Setup tab": ["app/admin/clinics/[clinicId]/ClinicTabs.tsx", 'setup: "Setup"', "page"],
  "Billing tab": ["app/admin/clinics/[clinicId]/ClinicTabs.tsx", 'billing: "Billing"', "page"],
  "Deliveries tab": ["app/admin/clinics/[clinicId]/ClinicTabs.tsx", 'deliveries: "Deliveries"', "page"],
  "Care tab": ["app/admin/clinics/[clinicId]/ClinicTabs.tsx", 'care: "Care"', "page"],
  "Account tab": ["app/admin/clinics/[clinicId]/ClinicTabs.tsx", 'account: "Account"', "page"],
  "Queues page": ["app/admin/queues/page.tsx", 'title: "Queues"', "page"],
  "Setup requests": ["app/admin/queues/SetupRequestsSection.tsx", 'title="Setup requests"', "page"],
  // Phase 5 (lane P5b): the Setup tab's own section for the writes that have
  // not settled, with a Retry per row. The old Calendar card's list no longer
  // offers one (lane P5c), so this is the one proof of the button's name.
  "Calendar writes": ["app/admin/clinics/[clinicId]/setup/CalendarWrites.tsx", 'title="Calendar writes"', "page"],
  "Phone line": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", 'title="Phone line"', "page"],
  "Usage and the allowance": [
    "app/admin/clinics/[clinicId]/billing/BillingPanel.tsx",
    'title="Usage and the allowance"',
    "page",
  ],
  "Touch log": ["app/admin/clinics/[clinicId]/care/TouchLog.tsx", '"Touch log"', "page"],
  "Send setup link": ["app/admin/queues/SetupRequestsSection.tsx", '"Send setup link"', "button"],
  Decline: ["app/admin/queues/SetupRequestsSection.tsx", "Decline", "button"],
  "Link sent": ["app/admin/queues/SetupRequestsSection.tsx", "`Link sent ", "button"],
  "the email didn't send": ["app/admin/queues/SetupRequestsSection.tsx", "the email didn't send", "button"],
  Retry: ["app/admin/clinics/[clinicId]/setup/CalendarWrites.tsx", 'label="Retry"', "button"],
  "Send calendar link": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", "Send calendar link", "button"],
  "Extend the setup window": [
    "app/admin/clinics/[clinicId]/billing/BillingPanel.tsx",
    "Extend the setup window",
    "button",
  ],
  "At the allowance": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "At the allowance", "button"],
  Record: ["app/admin/clinics/[clinicId]/care/TouchLog.tsx", '"Record"', "button"],
  // Lane N2a: the places the provisioning, billing, usage and email-delivery
  // steps name. Pages and cards first, then buttons.
  "Clinics page": ["app/admin/clinics/page.tsx", 'title: "Clinics"', "page"],
  "Jobs page": ["app/admin/system/jobs/page.tsx", 'title: "Jobs"', "page"],
  "Map page": ["app/admin/map/page.tsx", 'title: "System map"', "page"],
  "Agreements register": ["app/admin/compliance/page.tsx", 'label: "Agreements register"', "page"],
  "Plan card": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "title={`Plan — ", "page"],
  "Plan started": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", 'label="Plan started', "page"],
  Locations: ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", '<Row label="Locations">', "page"],
  "Refunded under § 5": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", 'label="Refunded under § 5"', "page"],
  "Needs attention": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Needs attention", "page"],
  "Billing requests": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Billing requests —", "page"],
  "Setup closure": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", 'close_setup: "Setup closure"', "page"],
  "Cancel now": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", 'cancel_now: "Cancel now"', "page"],
  "Parked Stripe events": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Parked Stripe events —", "page"],
  "A location waiting to be set up": [
    "app/admin/clinics/[clinicId]/billing/BillingPanel.tsx",
    'title="A location waiting to be set up"',
    "page",
  ],
  "Annual overage invoices": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Annual overage invoices —", "page"],
  "Refund under Terms § 5": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", 'title="Refund under Terms § 5"', "page"],
  "Billing emails": ["app/admin/clinics/[clinicId]/deliveries/DeliveriesLedger.tsx", "Billing emails", "page"],
  "Reports and alerts": ["app/admin/clinics/[clinicId]/deliveries/DeliveriesLedger.tsx", "Reports and alerts", "page"],
  "The clinic's address": ["app/admin/clinics/[clinicId]/account/AccountPanel.tsx", `title="The clinic's address"`, "page"],
  Offboarding: ["app/admin/clinics/[clinicId]/care/CarePanel.tsx", 'title="Offboarding"', "page"],
  "Preview the amount": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Preview the amount", "button"],
  Replay: ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Replay\n", "button"],
  "Retry the location setup": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Retry the location setup", "button"],
  "Retry the invoice": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Retry the invoice", "button"],
  "Turn auto-renew on": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", '"Turn auto-renew on"', "button"],
  "Close the unfinished setup": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Close the unfinished setup", "button"],
  "Turn on": ["app/admin/system/jobs/JobsTable.tsx", '"Turn on"', "button"],
  "Enter the change": ["app/admin/clinics/[clinicId]/account/AccountPanel.tsx", '"Enter the change"', "button"],
  "Resend copy": ["app/admin/compliance/agreements/AgreementsRegister.tsx", '"Resend copy"', "button"],
  // Lane N2b: setup-and-support, agreements, voice, calendar, transcripts.
  "Home page": ["app/admin/page.tsx", 'title: "Home"', "page"],
  "Voice agent column": ["app/admin/clinics/ClinicTable.tsx", 'label: "Voice agent"', "page"],
  "Calendar column": ["app/admin/clinics/ClinicTable.tsx", 'label: "Calendar"', "page"],
  // Since lane P7d "Support" is the Support console, the list of cases at /admin/support; Queues › Support, the
  // chat's dated promises with their mark, keeps its two places below.
  Support: ["app/admin/support/page.tsx", 'title: "Support"', "page"],
  "Waiting for a reply": ["app/admin/queues/SupportSection.tsx", "Waiting for a reply", "page"],
  "Mark replied": ["app/admin/queues/SupportSection.tsx", "Mark replied", "button"],
  "Site reads": ["app/admin/queues/page.tsx", 'label: "Site reads"', "page"],
  "Read it again": ["app/admin/queues/RereadButton.tsx", "Read it again", "button"],
  Reviews: ["app/admin/queues/page.tsx", 'label: "Reviews"', "page"],
  "Agent script": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", "title={`Agent script", "page"],
  "Save script": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", "Save script", "button"],
  "Channels card": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", 'title="Channels"', "page"],
  Pass: ["app/admin/queues/ReviewQueue.tsx", "Pass\n", "button"],
  Fail: ["app/admin/queues/ReviewQueue.tsx", "Fail\n", "button"],
  "Run the questions again": ["app/admin/queues/ReviewQueue.tsx", "Run the questions again", "button"],
  "Go live": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", 'title="Go live"', "page"],
  "Check go-live now": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", "Check go-live now", "button"],
  Channels: ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", 'title="Channels"', "page"],
  "The line is on their website": [
    "app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx",
    "The line is on their website",
    "button",
  ],
  "Setup window": ["app/admin/clinics/[clinicId]/setup/SetupWindow.tsx", 'title="Setup window"', "page"],
  // The Setup window card's own extend button; "Extend the setup window" above proves the Billing tab's.
  "Extend the setup window on the Setup window card": [
    "app/admin/clinics/[clinicId]/setup/SetupWindow.tsx",
    'label="Extend the setup window"',
    "button",
  ],
  "Availability changes": ["app/admin/clinics/[clinicId]/setup/AvailabilityChanges.tsx", 'title="Availability changes"', "page"],
  Reminders: ["app/admin/clinics/[clinicId]/deliveries/Reminders.tsx", "title={`Reminders", "page"],
  "Offered a call": ["app/admin/clinics/[clinicId]/setup/SetupWindow.tsx", 'label="Offered a call"', "button"],
  "Let it close": ["app/admin/clinics/[clinicId]/setup/SetupWindow.tsx", 'label="Let it close"', "button"],
  "Snooze alerts": ["app/admin/clinics/[clinicId]/setup/SetupWindow.tsx", 'label="Snooze alerts"', "button"],
  "Run audit now": ["app/admin/clinics/[clinicId]/setup/AvailabilityChanges.tsx", 'label="Run audit now"', "button"],
  "Mark as seen": ["app/admin/clinics/[clinicId]/setup/AvailabilityChanges.tsx", 'label="Mark as seen"', "button"],
  "Ask the practice questions again": [
    "app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx",
    "Ask the practice questions again",
    "button",
  ],
  "Calendar card": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", 'title="Calendar"', "page"],
  "Meta front door card": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", "title={`Meta front door", "page"],
  "Save phone settings": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", "Save phone settings", "button"],
  "To undo": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", "To undo", "page"],
  "Pause AI and the direct line": [
    "app/admin/clinics/[clinicId]/billing/BillingPanel.tsx",
    "Pause AI and the direct line",
    "page",
  ],
  "Save the direct line": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Save the direct line", "button"],
  Resume: ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Resume\n", "button"],
  "Offboarding card": ["app/admin/clinics/[clinicId]/care/CarePanel.tsx", 'title="Offboarding"', "page"],
  "Start offboarding": ["app/admin/clinics/[clinicId]/care/CarePanel.tsx", "Start offboarding", "button"],
  "Start a test window": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", "Start a test window", "button"],
  "What the clinic dials": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", "What the clinic dials", "page"],
  "Meta front door": ["app/admin/clinics/[clinicId]/setup/OnboardingPanel.tsx", "Meta front door — ", "page"],
  "Compliance page": ["app/admin/compliance/page.tsx", 'title: "Compliance"', "page"],
  "Business associate agreements in the chain": [
    "app/admin/compliance/CompliancePanel.tsx",
    "Business associate agreements in the chain",
    "page",
  ],
  Attest: ["app/admin/compliance/CompliancePanel.tsx", '"Attest"', "button"],
  "Attest again": ["app/admin/compliance/CompliancePanel.tsx", "Attest again", "button"],
  Withdraw: ["app/admin/compliance/CompliancePanel.tsx", "Withdraw\n", "button"],
  "Lapses on": ["app/admin/compliance/CompliancePanel.tsx", "Lapses on (optional)", "button"],
  Incidents: ["app/admin/compliance/incidents/page.tsx", 'title: "Incidents"', "page"],
  "Send report": ["app/admin/compliance/incidents/IncidentsBoard.tsx", '"Send report"', "button"],
  "Not reportable": ["app/admin/compliance/incidents/IncidentsBoard.tsx", "Not reportable\n", "button"],
  "Record clinic notified": ["app/admin/clinics/[clinicId]/care/CarePanel.tsx", "Record clinic notified", "button"],
  Resolve: ["app/admin/clinics/[clinicId]/care/CarePanel.tsx", "Resolve\n", "button"],
  "Open incident and start the clock": [
    "app/admin/clinics/[clinicId]/care/CarePanel.tsx",
    "Open incident and start the clock",
    "button",
  ],
  "Record export delivered": ["app/admin/clinics/[clinicId]/care/CarePanel.tsx", "Record export delivered", "button"],
  "Record Retell agent release": [
    "app/admin/clinics/[clinicId]/care/CarePanel.tsx",
    "Record Retell agent release",
    "button",
  ],
  Transcripts: ["app/admin/clinics/[clinicId]/deliveries/DeliveriesLedger.tsx", 'label: "Transcripts"', "page"],
  "Newest receipts": ["app/admin/clinics/[clinicId]/deliveries/TranscriptsPanel.tsx", "Newest receipts", "page"],
  "Send again": ["app/admin/clinics/[clinicId]/deliveries/TranscriptsPanel.tsx", '"Send again"', "button"],
  "Missing or broken": ["app/admin/map/MapLists.tsx", 'label: "Missing or broken"', "button"],
  Manage: ["app/admin/compliance/agreements/AgreementsRegister.tsx", '"Manage"', "button"],
  "Send copy": ["app/admin/compliance/agreements/AgreementsRegister.tsx", '"Send copy"', "button"],
  "Copy sent": ["app/admin/compliance/agreements/AgreementsRegister.tsx", 'label="Copy sent"', "button"],
  "Never delivered": ["app/admin/compliance/agreements/AgreementsRegister.tsx", "Never delivered", "button"],
  "Stop this change": ["app/admin/clinics/[clinicId]/account/AccountPanel.tsx", "Stop this change", "button"],
  "Change the address": [
    "app/admin/clinics/[clinicId]/account/AccountPanel.tsx",
    "Change the address (the clinic lost it)",
    "button",
  ],
  "Send a link to add a device": [
    "app/admin/clinics/[clinicId]/account/DevicesSection.tsx",
    "Send a link to add a device (the clinic lost every device)",
    "button",
  ],
  "Deposits and Stripe Connect": [
    "app/admin/clinics/[clinicId]/billing/BillingPanel.tsx",
    "Deposits and Stripe Connect",
    "page",
  ],
  "Disconnect Stripe": ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", "Disconnect Stripe", "button"],
  Plan: ["app/admin/clinics/[clinicId]/billing/BillingPanel.tsx", 'title="Plan"', "page"],
  Jobs: ["app/admin/system/jobs/page.tsx", 'title: "Jobs"', "page"],
  Map: ["app/admin/system/page.tsx", 'label: "Map"', "page"],
  // Lane N2b, after the accuracy review: the re-sign broadcast on Compliance › Notices.
  "Notices page": ["app/admin/compliance/page.tsx", 'label: "Notices"', "page"],
  "Start the re-signs": ["app/admin/compliance/notices/NoticesBoard.tsx", "Start the re-signs", "button"],
  // Lane N2c, after its accuracy review: the covered-entity answer on the Account tab.
  "Covered entity": ["app/admin/clinics/[clinicId]/account/AccountPanel.tsx", 'title="Covered entity"', "page"],
  "Record the answer": ["app/admin/clinics/[clinicId]/account/AccountPanel.tsx", '"Record the answer"', "button"],
  // Phase 5 (lanes P5a, P5b, P5d; wording by lane P5c): the Voice agent card
  // and its three controls, the System page's read-only sections for the
  // machine work past its patience, and the lifecycle watch's ignore control.
  "Voice agent": ["app/admin/clinics/[clinicId]/setup/VoiceAgentCard.tsx", 'title="Voice agent"', "page"],
  "Check against Retell": ["app/admin/clinics/[clinicId]/setup/VoiceAgentCard.tsx", 'label="Check against Retell"', "button"],
  "Clear flag and recheck": [
    "app/admin/clinics/[clinicId]/setup/VoiceAgentCard.tsx",
    'label="Clear flag and recheck"',
    "button",
  ],
  "System page": ["app/admin/system/page.tsx", 'title: "System"', "page"],
  "Requires your attention": ["app/admin/system/Attention.tsx", 'title="Requires your attention"', "page"],
  "Being watched": ["app/admin/system/Attention.tsx", 'title="Being watched"', "page"],
  "Calendar writes stuck": ["app/admin/system/Attention.tsx", ">Calendar writes stuck<", "page"],
  "Transcript copies not delivered": ["app/admin/system/Attention.tsx", ">Transcript copies not delivered<", "page"],
  "Do not watch this account": [
    "app/admin/clinics/[clinicId]/setup/SetupWindow.tsx",
    'label="Do not watch this account"',
    "button",
  ],
  // Phase 6 (lanes P6a, P6c; screens by lane P6b): the approval inbox as
  // Queues › Approvals, with its two decisions, its History tab and the
  // authenticator field both decisions ask for (the shared CodeField), and
  // the Patient rights page with its three controls.
  Approvals: ["app/admin/queues/ApprovalsSection.tsx", 'title="Approvals"', "page"],
  // Since lane P6j the two decisions live in the shared decision form every approval card ends in.
  Approve: ["app/admin/queues/ApprovalDecision.tsx", 'label="Approve"', "button"],
  Reject: ["app/admin/queues/ApprovalDecision.tsx", 'label="Reject"', "button"],
  History: ["app/admin/queues/ApprovalsSection.tsx", "History\n", "page"],
  "Code from your authenticator": ["components/admin/ui.tsx", "Code from your authenticator", "button"],
  "Patient rights": ["app/admin/rights/page.tsx", 'title: "Patient rights"', "page"],
  "Record a request": ["app/admin/rights/RecordRequestForm.tsx", '"Record a request"', "button"],
  "Copy command": ["app/admin/rights/RightsTable.tsx", '"Copy command"', "button"],
  "Mark done": ["app/admin/rights/RightsTable.tsx", 'label="Mark done"', "button"],
  // Wave B (lanes P6f, P6h, P6i; screens by lane P6j): the Incident
  // assistant on the Incidents page with its scope, checklist and two
  // proposals; the compliance pack's list and printable page; the open
  // re-signs on the Agreements page; an email item's Edit and Preview under
  // Approvals; and the Setup window card's four proposals.
  "Incident assistant": ["app/admin/compliance/incidents/IncidentAssistant.tsx", 'title="Incident assistant"', "page"],
  "Read the scope": ["app/admin/compliance/incidents/IncidentScope.tsx", "Read the scope", "button"],
  "Propose opening these incidents": ["app/admin/compliance/incidents/IncidentScope.tsx", 'label="Propose opening these incidents"', "button"],
  Checklist: ["app/admin/compliance/incidents/IncidentChecklist.tsx", '"Checklist"', "button"],
  Tick: ["app/admin/compliance/incidents/IncidentChecklist.tsx", 'label="Tick"', "button"],
  "Propose the report": ["app/admin/compliance/incidents/IncidentChecklist.tsx", 'label="Propose the report"', "button"],
  "Compliance pack": ["app/admin/compliance/pack/[week]/page.tsx", 'title: "Compliance pack"', "page"],
  "Compliance packs": ["app/admin/compliance/pack/page.tsx", 'title: "Compliance packs"', "page"],
  // The due week's control; an older missing week's reads "Make this pack".
  "Make this week's pack": ["app/admin/compliance/pack/PackList.tsx", `"Make this week's pack"`, "button"],
  "Open BAA re-signs": ["app/admin/compliance/agreements/OpenResigns.tsx", 'title="Open BAA re-signs"', "page"],
  Edit: ["app/admin/queues/ContactDraft.tsx", "Edit\n", "button"],
  Preview: ["app/admin/queues/ContactDraft.tsx", '"Preview"', "button"],
  "Propose more time": ["app/admin/clinics/[clinicId]/setup/SetupWindow.tsx", 'label="Propose more time"', "button"],
  "Propose: we are finishing it": ["app/admin/clinics/[clinicId]/setup/SetupWindow.tsx", 'label="Propose: we are finishing it"', "button"],
  "Offer a five-minute call": ["app/admin/clinics/[clinicId]/setup/SetupWindow.tsx", 'label="Offer a five-minute call"', "button"],
  "Propose the next reminder": ["app/admin/clinics/[clinicId]/setup/SetupWindow.tsx", 'label="Propose the next reminder"', "button"],
  // Keyed with its section, as "Extend the setup window on the Setup window
  // card" is: the bare words are ordinary prose in the offboarding alert
  // ("Ask the practice, on its published number"), which the renderer would
  // otherwise underline as a button.
  "Ask the practice under Agreement checks": ["app/admin/queues/AgreementChecks.tsx", 'label="Ask the practice"', "button"],
  // Phase 7 (lanes P7a, P7b, P7c; console by lane P7d): the Support console's
  // "Needs you" section and the case view's controls. "Check the reply",
  // "Send the reply" and "Close the case" are keyed with their object, as
  // "Extend the setup window on the Setup window card" is: bare, Check, Send
  // and Close are verbs in a hundred steps, which the renderer would
  // underline as buttons.
  "Needs you": ["components/admin/support-words.ts", 'title: "Needs you"', "page"],
  "Save draft": ["app/admin/support/[caseId]/CaseView.tsx", 'label="Save draft"', "button"],
  "Check the reply": ["app/admin/support/[caseId]/CaseView.tsx", 'label="Check"', "button"],
  Regenerate: ["app/admin/support/[caseId]/CaseView.tsx", 'label="Regenerate"', "button"],
  "Send the reply": ["app/admin/support/[caseId]/CaseView.tsx", 'label="Send"', "button"],
  Snooze: ["app/admin/support/[caseId]/CaseView.tsx", 'label="Snooze"', "button"],
  Assign: ["app/admin/support/[caseId]/CaseView.tsx", 'label="Assign"', "button"],
  Match: ["app/admin/support/[caseId]/CaseView.tsx", 'label="Match"', "button"],
  "Close the case": ["app/admin/support/[caseId]/CaseView.tsx", 'label="Close"', "button"],
};
