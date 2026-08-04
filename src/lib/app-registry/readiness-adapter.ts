export type EnvironmentReadiness = { ready: true } | { ready: false; reason: string };

export interface EnvironmentReadinessAdapter {
  checkReady(appId: string): Promise<EnvironmentReadiness>;
}

// AR-002 seam: "Activation requires complete valid metadata and
// environment configuration readiness supplied by AR-002" (business rule
// 12) — AR-002 (deploy target/secrets/health-check readiness) isn't built
// yet. This stub always reports ready so activation logic goes through a
// real interface call rather than a hardcoded true; swap this binding for
// an AR-002-backed adapter once that requirement exists.
export const stubReadinessAdapter: EnvironmentReadinessAdapter = {
  async checkReady() {
    return { ready: true };
  },
};
