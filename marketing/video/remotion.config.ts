import { Config } from "@remotion/cli/config";

// Lossless frames: JPEG capture put blocking into the gradients and the white
// before the encoder ever saw them.
Config.setVideoImageFormat("png");
// The container's pre-installed headless Chromium; Remotion would otherwise download its own.
if (process.env.REMOTION_BROWSER) Config.setBrowserExecutable(process.env.REMOTION_BROWSER);
