import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setJpegQuality(92);
// The container's pre-installed headless Chromium; Remotion would otherwise download its own.
if (process.env.REMOTION_BROWSER) Config.setBrowserExecutable(process.env.REMOTION_BROWSER);
