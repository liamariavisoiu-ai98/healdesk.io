/**
 * Where the owner's demo page (lib/demo/v2/render.ts) leaves room for the
 * real cards (components/demo/DemoV2Islands.tsx). Its own module, so the
 * client side imports two ids and not the page's template.
 */

/** The voice card's body, filled by VoiceCard. */
export const VOICE_SLOT_ID = "hd-voice-slot";
/** The chat card's body, filled by ClinicChatPanel. */
export const CHAT_SLOT_ID = "hd-chat-slot";

/**
 * The page's own script, carried as inert text and run once React has
 * hydrated the page (DemoV2Islands): run while the HTML was still parsing, it
 * changed the server's markup before React read it.
 */
export const SCRIPT_ID = "hd-demo-v2-script";
