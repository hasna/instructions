import type { Config } from "../types/index.js";
import { resolveConfigStore, type ConfigStore } from "../data/config-store.js";

export const CODEWITH_SHARED_TODOS_STORAGE_STANDARD_SLUG = "codewith-shared-todos-storage-standard";
export const CODEWITH_SHARED_TODOS_STORAGE_POLICY_REFERENCE = "codewith/shared-todos-storage/v1";

export const CODEWITH_SHARED_TODOS_STORAGE_STANDARD_CONTENT = `# Codewith Shared Todos Storage Standard

Policy reference: \`${CODEWITH_SHARED_TODOS_STORAGE_POLICY_REFERENCE}\`

## Scope

- This policy applies to all operational Codewith work: repositories of every
  name, work projects, research projects, coordinators, delegated workers, and
  native scheduled or recurring loops. It is not limited to \`open-*\` or
  \`iapp-*\` repositories.

## Authoritative Storage

- Operational Todos state must use the managed shared Todos service.
  On-box SQLite or file storage is permitted only inside disposable,
  repository-owned tests using isolated test-controlled paths.
- On-box SQLite or file storage must never hold operational tasks, plans, locks or claims,
  comments, verification evidence, dispatch state, or handoff state. Never
  fall back to on-box-only storage to keep operational work moving.

## Pre-Mutation Gate

- Before any operational Todos mutation, require authoritative Projects
  linkage and verify from sanitized status or route metadata that Todos resolves
  to the managed server-backed route. Verification may identify the route class,
  backend class, and linked project identifiers, but must omit credentials,
  tokens, DSNs, and full endpoint URLs.
- If Projects linkage or server-backed route verification is missing, ambiguous,
  unavailable, or reports an on-box SQLite or file route, fail closed: do not mutate Todos.
  Diagnose and repair the owning configuration or service route, re-run the
  sanitized verification, and report the blockage or repair on the approved
  operational surface without exposing secrets.

## Reconciliation

- Prior on-box-only tasks, plans, comments, locks, verification, dispatch, or
  handoff evidence are not authoritative. Explicitly reconcile each required
  record into the Projects-linked shared Todos record, retain bounded provenance
  identifiers, and independently verify the shared result before treating it as
  authoritative. Never silently copy, discard, or bless on-box-only evidence.
`;

export async function ensureCodewithSharedTodosStorageStandardConfig(
  store: ConfigStore = resolveConfigStore(),
): Promise<Config> {
  const input = {
    name: "Codewith Shared Todos Storage Standard",
    category: "rules" as const,
    agent: "codewith" as const,
    format: "markdown" as const,
    content: CODEWITH_SHARED_TODOS_STORAGE_STANDARD_CONTENT,
    kind: "reference" as const,
    description: "Managed fail-closed shared Todos routing policy for all operational Codewith work",
    tags: [
      "codewith",
      "shared-todos-storage",
      "server-backed",
      "projects-linkage",
      "operational-routing",
    ],
  };

  let config: Config;
  try {
    const existing = await store.getConfig(CODEWITH_SHARED_TODOS_STORAGE_STANDARD_SLUG);
    if (
      existing.content !== input.content
      || existing.description !== input.description
      || existing.category !== input.category
      || existing.agent !== input.agent
      || existing.format !== input.format
      || existing.kind !== input.kind
      || JSON.stringify(existing.tags) !== JSON.stringify(input.tags)
    ) {
      config = await store.updateConfig(existing.id, input);
    } else {
      config = existing;
    }
  } catch {
    config = await store.createConfig(input);
  }

  // Unlike optional references, this policy must follow every operational profile.
  // Provider filtering keeps it out of non-Codewith renders after profile selection.
  for (const profile of await store.listProfiles()) {
    await store.addConfigToProfile(profile.id, config.id);
  }
  return config;
}
