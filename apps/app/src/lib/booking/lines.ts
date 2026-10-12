/**
 * The fixed lines the assistant says about a booking (plan §7.13), in one
 * place, so a tool's answer and the assistant's words cannot drift apart.
 * They are said as written: the model never rewords a line about whether
 * someone is booked. The rest of the table (held, slot taken, booked,
 * request taken, the deposit lines, one booking per call) arrives with the
 * engine's harness wiring (C14).
 */

/** The assistant may not book this call itself: it takes the time as a request. */
export const MANUAL_BOOKING_LINE =
  "I can't book that directly right now, so I'll take the time you'd like and the clinic will confirm it with you.";
