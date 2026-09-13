"use client";

import { useEffect } from "react";

import { rememberCampaignFromUrl } from "@/lib/attribution";

/** Remembers `?c=` for the session on any page. Renders nothing. */
export function CampaignMemory() {
  useEffect(() => {
    rememberCampaignFromUrl();
  }, []);
  return null;
}
