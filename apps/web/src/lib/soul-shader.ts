/**
 * The soul, as a shader.
 *
 * This is the whole picture of the orb: a sphere lit from the upper left,
 * with a warm interior that moves, drawn analytically at whatever size the
 * box happens to be. It replaced a 384px H.264 clip encoded at 57 kbps, which
 * at 72px on a retina panel read as a blurred gradient with blocking in it
 * and no edge at all. Nothing about a clip fixes that: a bigger encode is a
 * bigger download of the same soft picture, and the artwork is still a fixed
 * number of pixels being stretched. A shader has no pixels of its own.
 *
 * Kept in its own module rather than inline in the component so that
 * `scripts/render-soul-poster.mjs` can read it and render the still that
 * stands in for the canvas before hydration, under reduced motion, and where
 * WebGL is unavailable. The poster is therefore always a frame of this exact
 * program, and swapping from it to the live canvas moves nothing.
 *
 * ## What the picture is made of
 *
 *   surface     the analytic sphere, `z = sqrt(R² − r²)`, so the normal is
 *               exact at every pixel and the edge is anti-aliased in pixel
 *               units rather than left to a mask
 *   interior    three octaves of simplex noise, sampled in 3-D at the
 *               surface point and domain-warped by each other, so the colour
 *               reads as weather inside a ball rather than as a texture
 *               painted on one. The whole field turns slowly about the
 *               vertical axis, which is what makes it a sphere rotating and
 *               not a flat picture scrolling.
 *   palette     cream → gold → orange → red, in that order by heat, matching
 *               the wordmark and the aura that the CSS draws behind the orb.
 *               Thickness counts: the centre of the ball, where the eye
 *               passes through the most of it, runs hotter than the rim.
 *   light       a Lambert term from the upper left, a tight specular in the
 *               same direction, a warm Fresnel rim, and a faint bounce from
 *               the lower right. The light never moves. A turning interior
 *               under a fixed highlight is what reads as a solid object.
 *
 * ## The two uniforms the panels drive
 *
 *   uEnergy   0..1. Idle sits low; typing and speech sit high. It widens the
 *             palette toward red, quickens the interior, and brightens the
 *             thin halo outside the rim.
 *   uTime     seconds, already multiplied by the panel's tempo. The component
 *             integrates `dt × speed` rather than scaling wall-clock time, so
 *             a tempo change alters the pace without jumping the phase.
 *
 * Output is premultiplied alpha, which is what a WebGL canvas hands to the
 * compositor by default. The halo is forced to zero before the edge of the
 * box, so the canvas never paints a faint square over the aura behind it.
 */

export const SOUL_VERTEX = /* glsl */ `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const SOUL_FRAGMENT = /* glsl */ `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 uRes;
uniform float uTime;
uniform float uEnergy;

// Simplex noise, 3-D. Ashima Arts / Stefan Gustavson, MIT.
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

void main() {
  // Centred, -1..1 across the shorter side. The box is square in practice.
  float halfSide = 0.5 * min(uRes.x, uRes.y);
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / halfSide;
  float r = length(uv);

  // The sphere fills 82% of the box. The margin carries the halo and the
  // anti-aliased edge, and gives the heartbeat scale room to grow into
  // without the rim ever meeting the canvas boundary.
  const float R = 0.82;
  float zz = R * R - r * r;
  float z = sqrt(max(zz, 0.0));
  vec3 n = vec3(uv, z) / R;

  // --- interior -----------------------------------------------------------
  vec3 p = vec3(uv, z);
  float ang = uTime * 0.11;
  float ca = cos(ang), sa = sin(ang);
  p.xz = mat2(ca, -sa, sa, ca) * p.xz;

  float flow = uTime * (0.22 + 0.55 * uEnergy);
  // Frequencies are low on purpose. At 2.6 and 5.2 the interior read as
  // veined marble, every blotch with a hard edge against the next; at 26px
  // that is texture, not weather. Larger, softer masses with a light grain
  // over them read as light moving inside a ball.
  float warp = snoise(p * 1.2 + vec3(0.0, flow * 0.30, 0.0));
  float body = snoise(p * 1.9 + warp * 0.70 + vec3(flow * 0.18, -flow * 0.26, flow * 0.12));
  float grain = snoise(p * 4.2 - warp * 0.45 + vec3(-flow * 0.35, flow * 0.09, 0.0));
  float heat = 0.50 + 0.30 * body + 0.08 * grain;
  heat = smoothstep(0.02, 1.02, heat + 0.16 * uEnergy);

  // Thickness. z/R is 1 at the centre and 0 at the rim: the middle of the
  // ball is where the eye passes through most of it, so it runs hottest and
  // the rim cools toward cream. This is most of what makes it read as a
  // volume and not a disc.
  float depth = z / R;
  heat = mix(heat * 0.70, heat, depth);

  vec3 cream  = vec3(1.00, 0.94, 0.82);
  vec3 gold   = vec3(0.99, 0.78, 0.32);
  vec3 orange = vec3(0.97, 0.49, 0.16);
  vec3 red    = vec3(0.89, 0.15, 0.10);
  vec3 col = mix(cream, gold, smoothstep(0.05, 0.40, heat));
  col = mix(col, orange, smoothstep(0.35, 0.70, heat));
  col = mix(col, red, smoothstep(0.66, 1.00, heat));

  // --- light --------------------------------------------------------------
  vec3 L = normalize(vec3(-0.55, 0.65, 0.55));
  float lambert = 0.60 + 0.40 * max(dot(n, L), 0.0);
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(n, H), 0.0), 72.0);
  float fresnel = pow(1.0 - clamp(n.z, 0.0, 1.0), 2.6);
  float bounce = pow(max(dot(n, normalize(vec3(0.6, -0.6, 0.5))), 0.0), 3.0);

  col *= lambert;
  col += fresnel * vec3(1.00, 0.72, 0.40) * 0.80;
  col += spec * vec3(1.00, 0.97, 0.92) * 0.90;
  col += bounce * vec3(1.00, 0.55, 0.25) * 0.16;

  // --- edge and halo ------------------------------------------------------
  // Anti-aliasing measured in device pixels, so the rim is equally clean at
  // 26px and at 300px.
  float px = 1.25 / halfSide;
  float edge = 1.0 - smoothstep(R - px, R + px, r);

  // A thin warm halo just outside the rim, brighter with energy, and forced
  // to nothing by r = 0.98 so the canvas edge is never visible.
  float halo = exp(-max(r - R, 0.0) * 9.0) * (0.22 + 0.40 * uEnergy);
  halo *= 1.0 - smoothstep(R, 0.98, r);
  vec3 haloCol = mix(orange, red, 0.35);

  vec3 rgb = col * edge + haloCol * halo * (1.0 - edge);
  float a = edge + halo * (1.0 - edge);
  gl_FragColor = vec4(rgb, a);
}
`;
