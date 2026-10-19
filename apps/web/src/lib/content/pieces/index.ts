import type { Piece } from "@/lib/content/types";

import { piece as howAyaIsBuiltToBehave } from "./how-aya-is-built-to-behave";
import { piece as questionsToAskAVendor } from "./questions-to-ask-an-ai-receptionist-vendor";

/**
 * Every piece, in the order the strategy publishes them. A new piece is one
 * file in this folder exporting `piece`, plus one line here.
 */
export const PIECES: readonly Piece[] = [howAyaIsBuiltToBehave, questionsToAskAVendor];
