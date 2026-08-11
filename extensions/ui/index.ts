/**
 * ui — cosmetic terminal chrome for pi
 *
 * - footer: model, thinking, cwd, context %, Grok weekly + Cursor plan usage meters
 * - titlebar: braille spinner in the terminal tab title while the agent works
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerFooter from "./footer";
import registerTitlebar from "./titlebar";

export default function (pi: ExtensionAPI) {
	registerFooter(pi);
	registerTitlebar(pi);
}
