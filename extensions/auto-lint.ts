import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerAutoLint } from './runner.mjs';

export default function autoLint(pi: ExtensionAPI) {
  registerAutoLint(pi);
}
