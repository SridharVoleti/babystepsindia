import { randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { ProtectedFieldCategory } from "@/lib/learner-profile/update-validation";

export async function auditRejectedLearnerProfileMutation(input: {
  parentUserId: string;
  learnerId: string;
  protectedFieldCategory: ProtectedFieldCategory;
}) {
  await resolveDbClient().run(
    "insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'learner_profile_mutation_rejected',?)",
    [randomUUID(), input.parentUserId, JSON.stringify({
      learnerId: input.learnerId,
      action: "parent.learner.manage",
      outcome: "rejected",
      errorCode: "FORBIDDEN_FIELD",
      protectedFieldCategory: input.protectedFieldCategory,
    })],
  );
}
