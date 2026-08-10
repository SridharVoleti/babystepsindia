import { createApp } from "@/lib/db/app-registry-repo";
import type { SafeAppRegistryView } from "@/lib/db/types";
import { ensureKnownCatalogProductMappings } from "@/lib/billing/bi001-service";

// Business rule 13: the initial three apps go through the same
// admin-controlled service as any other registration — this is a thin
// caller, not a bypass. Fixed, deterministic idempotency keys mean a
// repeat run is a safe replay (AT-AR-001-09), not a duplicate attempt.
const INITIAL_APPS = [
  {
    appKey: "chess-master",
    displayName: "Chess Master",
    idempotencyKey: "00000000-0000-4000-8000-000000000001",
  },
  {
    appKey: "magical-math",
    displayName: "Magical Math",
    idempotencyKey: "00000000-0000-4000-8000-000000000002",
  },
  {
    appKey: "speed-reader",
    displayName: "Speed Reader",
    idempotencyKey: "00000000-0000-4000-8000-000000000003",
  },
] as const;

export function bootstrapInitialApps(adminUserId: string): SafeAppRegistryView[] {
  const apps = INITIAL_APPS.map((app) => createApp(adminUserId, app));
  ensureKnownCatalogProductMappings();
  return apps;
}
