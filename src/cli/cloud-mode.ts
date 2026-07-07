import { isCloudMode } from "../data/config-store.js";

export const SELF_HOSTED_LOCAL_ONLY_MESSAGE =
  "This command operates on local machine files or the local SQLite/PostgreSQL sync store and is not available in self_hosted mode. Unset HASNA_INSTRUCTIONS_API_URL / HASNA_INSTRUCTIONS_API_KEY to use it against the local store.";

export function ensureLocalMode(command: string): void {
  if (!isCloudMode()) return;
  throw new Error(`${command}: ${SELF_HOSTED_LOCAL_ONLY_MESSAGE}`);
}
