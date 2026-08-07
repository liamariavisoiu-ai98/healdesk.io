import type { NextConfig } from "next";

/**
 * PHI-side app. Keep this config portable — no Vercel-specific options that
 * would need unwinding when this moves to BAA-covered infrastructure.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Produces a self-contained server bundle, so this runs under `node server.js`
  // in a container on AWS/Fly/Render exactly as it does on Vercel.
  output: "standalone",

  serverExternalPackages: ["pg"],

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          // Nothing behind here should ever be cached by an intermediary.
          { key: "Cache-Control", value: "no-store, max-age=0" },
        ],
      },
    ];
  },
};

export default nextConfig;
