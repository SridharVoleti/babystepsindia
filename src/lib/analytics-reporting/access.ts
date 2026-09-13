export type AnalyticsRole = "super_admin" | "analytics_viewer";

export type AnalyticsScope = {
  apps: "all" | string[];
  levels: "all" | string[];
  ageBands: "all" | string[];
  canExport: boolean;
};

export type AnalyticsActor = {
  userId: string;
  role: AnalyticsRole;
  scopes: AnalyticsScope[];
};

export type AnalyticsViewRequest = {
  appId?: string;
  levelKey?: string;
  ageBand?: string;
  exportRequested: boolean;
};

function includes(scope: "all" | string[], value: string | undefined): boolean {
  if (value === undefined) return true;
  return scope === "all" || scope.includes(value);
}

export function authorizeAnalyticsView(
  actor: AnalyticsActor,
  request: AnalyticsViewRequest,
): { allowed: true; scope: AnalyticsScope } | { allowed: false; reason: "ANALYTICS_SCOPE_DENIED" | "ANALYTICS_EXPORT_DENIED" } {
  for (const scope of actor.scopes) {
    if (!includes(scope.apps, request.appId)
      || !includes(scope.levels, request.levelKey)
      || !includes(scope.ageBands, request.ageBand)) continue;
    if (request.exportRequested && !scope.canExport) {
      return { allowed: false, reason: "ANALYTICS_EXPORT_DENIED" };
    }
    return { allowed: true, scope };
  }
  return { allowed: false, reason: "ANALYTICS_SCOPE_DENIED" };
}
