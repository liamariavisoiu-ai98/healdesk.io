#!/usr/bin/env node
/**
 * Report whether a GLB/glTF can actually drive the hero rig.
 *
 *   node apps/web/scripts/inspect-glb.mjs <model.glb>
 *
 * The rig needs three specific things, and a model can look perfect in a viewer
 * while having none of them:
 *
 *   gaze      eye bones to point at a lookAt target, or eye-rotation blendshapes
 *   head turn a Head and ideally a Neck bone, so the turn distributes over two
 *             joints instead of pivoting the skull on a stick
 *   blinking  eyelid BLENDSHAPES. This is the one that catches people out —
 *             blinking is not a bone rotation on most humanoid rigs, so an
 *             otherwise well-rigged model simply cannot close its eyes.
 *
 * Reads the glTF JSON chunk directly rather than going through a loader, so it
 * runs in plain Node with no dependencies and no DOM shim.
 */

import fs from "node:fs";
import path from "node:path";

const file = process.argv[2];
if (!file) {
  console.error("usage: node apps/web/scripts/inspect-glb.mjs <model.glb|model.gltf>");
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error(`not found: ${file}`);
  process.exit(2);
}

const bytes = fs.readFileSync(file);
let gltf;
let binLength = 0;

if (bytes.subarray(0, 4).toString("ascii") === "glTF") {
  // GLB: 12-byte header, then length-prefixed chunks. Chunk 0 is always JSON.
  let offset = 12;
  while (offset < bytes.length) {
    const len = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    const body = bytes.subarray(offset + 8, offset + 8 + len);
    if (type === 0x4e4f534a) gltf = JSON.parse(body.toString("utf8"));
    else binLength += len;
    offset += 8 + len + ((4 - (len % 4)) % 4);
  }
} else {
  gltf = JSON.parse(bytes.toString("utf8"));
}
if (!gltf) {
  console.error("could not find a glTF JSON chunk — is this really a GLB?");
  process.exit(1);
}

const nodes = gltf.nodes ?? [];
const meshes = gltf.meshes ?? [];
const skins = gltf.skins ?? [];
const nameOf = (i) => nodes[i]?.name ?? `node[${i}]`;

/* ------------------------------------------------------------------ bones -- */
const joints = [...new Set(skins.flatMap((s) => s.joints ?? []))];
const jointNames = joints.map(nameOf);
const find = (re) => jointNames.filter((n) => re.test(n));

const eyeBones = find(/eye/i).filter((n) => !/eyelid|brow|lash/i.test(n));
const headBones = find(/head/i);
const neckBones = find(/neck/i);
const spineBones = find(/spine|chest/i);

/* ------------------------------------------------------------- blendshapes -- */
const morphs = new Set();
for (const mesh of meshes) {
  const names = mesh.extras?.targetNames ?? [];
  for (const n of names) morphs.add(n);
  // some exporters put them on the primitive instead
  for (const p of mesh.primitives ?? []) {
    for (const n of p.extras?.targetNames ?? []) morphs.add(n);
  }
}
const morphList = [...morphs];
const m = (re) => morphList.filter((n) => re.test(n));
const blink = m(/blink/i);
const eyeLook = m(/eyeLook/i);
const visemes = m(/viseme|mouth|jaw/i);

/* ---------------------------------------------------------------- payload -- */
const skinned = meshes.filter((mesh) =>
  (mesh.primitives ?? []).some((p) => p.attributes?.JOINTS_0 !== undefined),
);
const accessors = gltf.accessors ?? [];
const triangles = meshes.reduce(
  (sum, mesh) =>
    sum +
    (mesh.primitives ?? []).reduce(
      (s, p) => s + (p.indices !== undefined ? (accessors[p.indices]?.count ?? 0) / 3 : 0),
      0,
    ),
  0,
);
const images = gltf.images ?? [];
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

/* ----------------------------------------------------------------- report -- */
const ok = (b) => (b ? "✓" : "✗");
const list = (a, n = 8) =>
  a.length ? a.slice(0, n).join(", ") + (a.length > n ? `, +${a.length - n} more` : "") : "none";

console.log(`\n${path.basename(file)}  ${(bytes.length / 1048576).toFixed(1)} MB` +
  `   (${kb(binLength)} binary, ${images.length} image${images.length === 1 ? "" : "s"})`);
console.log(`generator: ${gltf.asset?.generator ?? "unknown"}`);
console.log(`${meshes.length} mesh(es), ${skinned.length} skinned, ~${Math.round(triangles).toLocaleString()} triangles, ${joints.length} bones, ${(gltf.animations ?? []).length} animation(s)`);

console.log("\nWHAT THE RIG NEEDS");
console.log(`  ${ok(eyeBones.length >= 2)} eye bones        ${list(eyeBones)}`);
console.log(`  ${ok(headBones.length >= 1)} head bone        ${list(headBones)}`);
console.log(`  ${ok(neckBones.length >= 1)} neck bone        ${list(neckBones)}   (optional, but a head-only turn looks stiff)`);
console.log(`  ${ok(blink.length >= 1)} blink blendshapes ${list(blink)}`);
console.log(`  ${ok(spineBones.length >= 1)} chest/spine bone ${list(spineBones)}   (optional, drives breathing)`);

if (morphList.length) {
  console.log(`\n${morphList.length} blendshape(s) total`);
  if (eyeLook.length) console.log(`  eye-look targets: ${list(eyeLook)}`);
  if (visemes.length) console.log(`  mouth/jaw:        ${list(visemes)}`);
} else {
  console.log("\nNo blendshapes found at all.");
}

const gaze = eyeBones.length >= 2 || eyeLook.length >= 2;
const canBlink = blink.length >= 1;
const canTurn = headBones.length >= 1;

console.log("\nVERDICT");
if (gaze && canBlink && canTurn) {
  console.log("  Usable. Gaze, head turn and blinking are all drivable.");
} else {
  console.log("  NOT usable as-is:");
  if (!gaze) console.log("   - no eye bones and no eyeLook blendshapes, so the eyes cannot track the cursor");
  if (!canTurn) console.log("   - no head bone, so the head cannot turn");
  if (!canBlink)
    console.log(
      "   - no blink blendshapes, so it cannot blink. Re-export with blendshapes/morph\n" +
        "     targets enabled (ARKit set preferred: eyeBlinkLeft / eyeBlinkRight).",
    );
}
if (bytes.length > 25 * 1048576) {
  console.log(`\n  Note: ${(bytes.length / 1048576).toFixed(0)} MB is heavy for a landing page.`);
  console.log("  Worth running through gltf-transform (KTX2 textures + meshopt) before shipping.");
}
console.log("");
