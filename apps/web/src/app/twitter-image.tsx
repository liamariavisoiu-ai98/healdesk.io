/**
 * X reads twitter:image before og:image and the root layout already declares
 * `summary_large_image`, so give it the same card explicitly rather than
 * relying on the fallback. One renderer, two routes: nothing here can drift
 * from the Open Graph card.
 */
export { default, alt, size, contentType } from "./opengraph-image";
