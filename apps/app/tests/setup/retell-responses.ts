import { ACKNOWLEDGEMENTS } from "@/lib/voice/retell";

/**
 * The responses a caller hears, as Retell assembles them: the parts of one
 * response (the same response_id, every part but the last sent with
 * content_complete false) are appended into one, as Retell's custom-LLM
 * protocol does. Since 24 October 2026 a call sends a short acknowledgement
 * as a response's first part while the model thinks (lib/voice/retell.ts),
 * so a test that reads "the second thing said" reads the whole of it.
 */
type Message = { response_type?: string; response_id?: number; content?: string; content_complete?: boolean };

export function spokenResponses<M extends Message>(messages: readonly M[]): M[] {
  const out: M[] = [];
  let open: M | null = null;
  for (const m of messages) {
    if (m.response_type !== "response") continue;
    if (open && open.response_id === m.response_id) {
      const joined: M = { ...m, content: `${open.content ?? ""}${m.content ?? ""}` };
      out[out.length - 1] = joined;
      open = m.content_complete === false ? joined : null;
      continue;
    }
    out.push(m);
    open = m.content_complete === false ? m : null;
  }
  return out;
}

/**
 * The same, with the acknowledgement a response opened with read past
 * (retell.ts, ACKNOWLEDGEMENTS), for a test about what follows it: the fixed
 * line, the booking question, the refusal. tests/voice-acknowledgement.test.ts
 * is where the acknowledgement itself is tested.
 */
export function spokenAfterAcknowledgement<M extends Message>(messages: readonly M[]): M[] {
  const acks = new Set([...ACKNOWLEDGEMENTS.en, ...ACKNOWLEDGEMENTS.es]);
  const out: M[] = [];
  let open: M | null = null;
  let ack = false;
  for (const m of messages) {
    if (m.response_type !== "response") continue;
    if (open && open.response_id === m.response_id) {
      const rest = (m.content ?? "").replace(/^ /, "");
      const joined: M = { ...m, content: ack ? rest : `${open.content ?? ""}${m.content ?? ""}` };
      out[out.length - 1] = joined;
      open = m.content_complete === false ? joined : null;
      ack = false;
      continue;
    }
    ack = m.content_complete === false && acks.has(m.content ?? "");
    out.push(m);
    open = m.content_complete === false ? m : null;
  }
  return out;
}

/** A transcript turn with the acknowledgement it opened with read past, as spokenAfterAcknowledgement reads a response. */
export function withoutAcknowledgement(text: string): string {
  for (const ack of [...ACKNOWLEDGEMENTS.en, ...ACKNOWLEDGEMENTS.es]) if (text.startsWith(`${ack} `)) return text.slice(ack.length + 1);
  return text;
}
