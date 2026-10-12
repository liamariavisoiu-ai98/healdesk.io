"use client";

import { useEffect, useRef, useState } from "react";

import { REDUCED_MOTION, useMediaQuery } from "@/lib/use-media-query";

/**
 * AYA in the closing band (ClosingCta.tsx): the owner's clip of 12 October
 * 2026, in which she raises her thumb and points at the words, in place of
 * the photograph of the same pose.
 *
 * The clip is a gesture, not a loop: looped, her hand would drop out of the
 * frame and come back up every three seconds. So it plays once, when the band
 * is half on screen, and stays on its last frame, which is the photograph
 * (aya-final-cta.webp is that frame). Until then the band shows the
 * photograph, so the server, a reader who asked for less motion, and a
 * browser that refuses to autoplay (an iPhone in Low Power Mode) all see her
 * pointing, and none of them sees a play button over her.
 *
 * The clip is mounted only once the band is near the screen, so its 2.6 MB
 * is spent by readers who reach the end of the page. It starts on its own
 * first frame (aya-final-cta-start.webp), the swap made off screen.
 *
 * aya_final_cta.mp4 is the owner's upload, HEVC in 10-bit with sound, which
 * Firefox cannot play at all and Chrome only on some machines. The page plays
 * copies made from it, silent, at 1920 by 1080 and a quality the owner set no
 * lower than 2 MB (12 October 2026):
 *
 *   aya-final-cta.mp4, H.264, 2.6 MB, offered first, which every browser
 *   that ships it plays (SSIM 0.994 against the upload):
 *
 *     ffmpeg -i aya_final_cta.mp4 -an \
 *       -vf "scale=1920:1080:flags=lanczos,format=yuv420p" \
 *       -c:v libx264 -profile:v high -level 4.1 -preset veryslow -tune film \
 *       -crf 15 -movflags +faststart aya-final-cta.mp4
 *
 *   aya-final-cta.webm, VP9, 2.3 MB, for a browser without H.264 (an
 *   open-source Chromium): the same filter, then two passes of
 *   `-c:v libvpx-vp9 -b:v 0 -crf 10 -row-mt 1 -deadline good -cpu-used 1`.
 *
 * A browser that can play neither keeps the photograph rather than freezing
 * on the clip's first frame, where her hand is still down.
 */

/** The clip's copies, best first. */
const SOURCES = [
  { src: "/brand/aya-final-cta.mp4", type: "video/mp4" },
  { src: "/brand/aya-final-cta.webm", type: "video/webm" },
] as const;

function canPlayClip(): boolean {
  const probe = document.createElement("video");
  return SOURCES.some(({ type }) => probe.canPlayType(type) !== "");
}

export function ClosingAya({ className }: { className: string }) {
  const reduce = useMediaQuery(REDUCED_MOTION);
  const video = useRef<HTMLVideoElement>(null);
  /** The band is near the screen: mount the clip. */
  const [near, setNear] = useState(false);
  /** Autoplay was refused, or no copy would load: back to the photograph. */
  const [refused, setRefused] = useState(false);
  const holder = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = holder.current?.parentElement;
    if (!el || reduce || typeof IntersectionObserver === "undefined" || !canPlayClip()) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px 400px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [reduce]);

  // Once mounted, play when half the band is on screen, once.
  useEffect(() => {
    const el = holder.current?.parentElement;
    if (!near || !el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        video.current?.play().catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "NotAllowedError") setRefused(true);
        });
      },
      { threshold: 0.5 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [near]);

  const still = reduce || refused || !near;

  return (
    <>
      <span ref={holder} hidden />
      {still ? (
        <img
          src="/brand/aya-final-cta.webp"
          srcSet="/brand/aya-final-cta-960.webp 960w, /brand/aya-final-cta.webp 1672w"
          sizes="(min-width: 1024px) 940px, 100vw"
          alt=""
          width={1672}
          height={941}
          loading="lazy"
          decoding="async"
          className={className}
        />
      ) : (
        <video
          ref={video}
          className={className}
          width={1920}
          height={1080}
          muted
          playsInline
          preload="auto"
          poster="/brand/aya-final-cta-start.webp"
          aria-hidden
          tabIndex={-1}
          disablePictureInPicture
        >
          {SOURCES.map(({ src, type }, i) => (
            <source
              key={src}
              src={src}
              type={type}
              // The last copy failing means none will play: back to the photograph.
              onError={i === SOURCES.length - 1 ? () => setRefused(true) : undefined}
            />
          ))}
        </video>
      )}
    </>
  );
}
