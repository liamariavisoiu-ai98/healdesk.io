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

  // Required from node_modules at run time instead of bundled into the server
  // chunks. For the AWS SDK clients that means each chunk carries a `require`
  // and the standalone output traces the package in beside it. Why they are
  // dependencies imported by a literal specifier is explained above
  // AwsKmsKeyWrapper in src/lib/crypto/kms.ts. Every @aws-sdk package that
  // src imports belongs here (tests/aws-sdk-externals.test.ts): S3 is the
  // export bucket's (src/lib/patient-rights/export-store.ts).
  serverExternalPackages: [
    "pg",
    "@aws-sdk/client-kms",
    "@aws-sdk/client-sesv2",
    "@aws-sdk/client-s3",
  ],

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
          // Passkeys only from this app's own pages, never from a frame a
          // page embeds (plan Part D6). The page's Content-Security-Policy is
          // per request, for its nonce, so it is set in src/proxy.ts.
          {
            key: "Permissions-Policy",
            value: "publickey-credentials-get=(self), publickey-credentials-create=(self)",
          },
          // HTTPS only, for two years, here and below: a sign-in link or a
          // session cookie must never cross a network in the clear. Browsers
          // ignore it over plain http, so development is unaffected. No
          // `preload`, which binds the whole of healdesk.io and is the
          // owner's decision, not this app's.
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default nextConfig;
