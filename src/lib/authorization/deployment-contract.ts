export const DEPLOYMENT_ADMIN_AUTHORIZATION = {
  "deployment.schedule": { recentReauthenticationSeconds: 300, transactionalReauthorization: true, exactAppReleaseBinding: true },
  "deployment.reschedule": { recentReauthenticationSeconds: 300, transactionalReauthorization: true, exactAppReleaseBinding: true },
  "deployment.cancel": { recentReauthenticationSeconds: 300, transactionalReauthorization: true, exactAppReleaseBinding: true },
  "deployment.promote": { recentReauthenticationSeconds: 300, transactionalReauthorization: true, exactAppReleaseBinding: true },
  "deployment.rollback": { recentReauthenticationSeconds: 300, transactionalReauthorization: true, exactAppReleaseBinding: true },
} as const;

type DeploymentPhase = "drain" | "deploying" | "available" | "overrun";

export function deploymentAvailabilityNotice(input: { phase: DeploymentPhase; affectedAppId?: string }) {
  const common = { scope: input.affectedAppId ? { appId: input.affectedAppId } : { appId: "affected_app_only" }, allowanceUsed: false };
  if (input.phase === "drain") return { ...common, blocked: true, publicDowntime: false,
    message: "New learning sessions are temporarily paused while we prepare an update." };
  if (input.phase === "deploying") return { ...common, blocked: true, publicDowntime: true,
    message: "This app is being updated and may be unavailable for up to 45 minutes." };
  if (input.phase === "overrun") return { ...common, blocked: true, publicDowntime: true,
    message: "The update is taking longer than expected. Your session allowance has not been used." };
  return { ...common, blocked: false, publicDowntime: false, message: "The app is available." };
}
