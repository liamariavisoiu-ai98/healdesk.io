import type { Piece } from "@/lib/content/types";

import { piece as aiCallTranscriptionConsent } from "./ai-call-transcription-consent-by-state";
import { piece as conditionalCallForwarding } from "./conditional-call-forwarding";
import { piece as aiDisclosure } from "./does-an-ai-receptionist-have-to-say-it-is-an-ai";
import { piece as howAyaIsBuiltToBehave } from "./how-aya-is-built-to-behave";
import { piece as cashPayClinicHipaa } from "./is-a-cash-pay-clinic-covered-by-hipaa";
import { piece as phoneBookingStatistics } from "./phone-booking-and-missed-call-statistics";
import { piece as questionsToAskAVendor } from "./questions-to-ask-an-ai-receptionist-vendor";
import { piece as stateTracker } from "./state-ai-disclosure-and-consent-tracker";

/**
 * Every piece, in the order the strategy publishes them. A new piece is one
 * file in this folder exporting `piece`, plus one line here.
 */
export const PIECES: readonly Piece[] = [
  howAyaIsBuiltToBehave,
  questionsToAskAVendor,
  phoneBookingStatistics,
  conditionalCallForwarding,
  aiDisclosure,
  cashPayClinicHipaa,
  aiCallTranscriptionConsent,
  stateTracker,
];
