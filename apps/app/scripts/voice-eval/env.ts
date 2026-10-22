/**
 * Every environment variable the voice eval reads, in one place (they are
 * listed in NOT_KEYS on /admin/map, apps/web/src/lib/admin/system-map.ts:
 * developer-local settings, never set on Vercel or AWS).
 *
 *   VOICE_EVAL_ANTHROPIC_API_KEY  the developer's own Anthropic key for the
 *       eval. Deliberately not ANTHROPIC_API_KEY, the patient-data
 *       organisation's key the app runs on: synthetic eval traffic is never
 *       billed to, or logged under, the organisation that holds patient data.
 *   VOICE_EVAL_CONFIRM_SPEND  the estimate id `voice-eval estimate` printed
 *       for this exact plan. Without it (or with another plan's id) the eval
 *       refuses to make a single paid call.
 *   VOICE_EVAL_OUT_DIR  where results go; apps/app/.voice-eval by default
 *       (gitignored).
 */

export function evalApiKey(): string | null {
  const key = process.env.VOICE_EVAL_ANTHROPIC_API_KEY?.trim();
  return key ? key : null;
}

export function confirmedSpendId(): string | null {
  const id = process.env.VOICE_EVAL_CONFIRM_SPEND?.trim();
  return id ? id : null;
}

export function outDirSetting(): string | null {
  const dir = process.env.VOICE_EVAL_OUT_DIR?.trim();
  return dir ? dir : null;
}
