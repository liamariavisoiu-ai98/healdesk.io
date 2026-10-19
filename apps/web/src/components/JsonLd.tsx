import { serializeLd } from "@/lib/structured-data";

/**
 * One `<script type="application/ld+json">`, server-rendered so every crawler
 * reads it without running JavaScript. See lib/structured-data.ts for what
 * the site marks up and what it leaves out.
 */
export function JsonLd({ data }: { data: Record<string, unknown> | readonly Record<string, unknown>[] }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeLd(data) }} />;
}
