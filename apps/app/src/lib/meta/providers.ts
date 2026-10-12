import type { MetaPlatform } from "./front-door";

/**
 * The provider name each Meta platform's sealed connection is stored under
 * (provider_connections.provider). Its own module so that the channel
 * switches (lib/channels/meta-platforms.ts) and the channels themselves
 * (./channels.ts, which re-exports it) can both read it without importing
 * each other.
 */
export const META_PROVIDERS: Record<MetaPlatform, string> = {
  messenger: "meta-messenger",
  instagram: "meta-instagram",
  whatsapp: "meta-whatsapp",
};
