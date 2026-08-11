import type { ExitAcknowledgement, ExitActionRequest } from "./client";

export type SessionExitTransport = (request: {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
}) => Promise<ExitAcknowledgement>;

// App backends supply a dual-credential transport; browser code receives
// only these bounded operations. Session/app/device identity and funding are
// intentionally absent from mutation bodies and remain server-derived.
export function createSessionExitAppShellSdk(input: {
  sessionId: string;
  initialSessionVersion: number;
  transport: SessionExitTransport;
}) {
  let sessionVersion = input.initialSessionVersion;
  const path = (action: string) => `/v1/internal/learner-sessions/${encodeURIComponent(input.sessionId)}/${action}`;
  const accept = (result: ExitAcknowledgement) => {
    sessionVersion = result.sessionVersion;
    return result;
  };

  return {
    get sessionVersion() { return sessionVersion; },
    async getExitState() {
      return accept(await input.transport({ method: "GET", path: path("exit-state") }));
    },
    async markResumable(request: ExitActionRequest) {
      return accept(await input.transport({ method: "POST", path: path("mark-resumable"), body: {
        expectedSessionVersion: sessionVersion,
        lastAcknowledgedProgressVersion: request.acknowledgedProgressVersion,
        idempotencyKey: request.idempotencyKey,
      } }));
    },
    async finishSession(request: ExitActionRequest) {
      return accept(await input.transport({ method: "POST", path: path("finish"), body: {
        expectedSessionVersion: sessionVersion,
        finalProgressVersion: request.acknowledgedProgressVersion,
        reason: "intentional_finish",
        idempotencyKey: request.idempotencyKey,
      } }));
    },
  };
}
