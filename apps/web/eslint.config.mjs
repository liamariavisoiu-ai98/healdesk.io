import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * ESLint for the marketing site, run by `npm run lint`.
 *
 * Next 16 removed `next lint`, and with it the script this workspace had:
 * this is the flat config Next documents in its place
 * (node_modules/next/dist/docs/01-app/03-api-reference/05-config/03-eslint.md),
 * with its Core Web Vitals and TypeScript sets.
 *
 * ESLint 9, not 10: create-next-app 16.3 installs "^9", and three of the
 * plugins eslint-config-next brings (react, import, jsx-a11y) declare support
 * only up to 9. Move to 10 when Next's own template does.
 */
export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // A quote or an apostrophe in JSX text renders as written, and the legal
      // pages are full of them. The rule's other two characters, `>` and `}`,
      // are already parse errors in JSX text, so nothing is left for it to do.
      "react/no-unescaped-entities": "off",
      // A leading underscore marks a binding as unused on purpose: a parameter
      // a signature requires, or a key destructured out so the rest can be
      // passed on (provisionRequestFromMetadata in the Stripe webhook).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      // The site navigates with plain anchors and imports next/link nowhere,
      // and global-error.tsx and the admin layout want full reloads on purpose.
      // In an App Router app this rule only ever matches links to "/": obeying
      // it would turn eight home links into <Link> and leave /pricing,
      // /privacy and every other link plain.
      "@next/next/no-html-link-for-pages": "off",
      // No next/image anywhere either. Two images cannot go through the
      // optimizer at all (the share image is drawn by Satori, a review photo is
      // the visitor's own upload), and the rest are static files served as
      // they are, sized in the markup.
      "@next/next/no-img-element": "off",
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);
