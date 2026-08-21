const implementation = () => process.env.SUPABASE_DB_URL
  ? import("@/lib/learner-profile/postgres-service")
  : import("@/lib/db/learner-repo");

export async function createOwnedLearner(...args: Parameters<typeof import("@/lib/db/learner-repo").createLearner>) {
  return (await implementation()).createLearner(...args);
}
export async function listOwnedLearners(...args: Parameters<typeof import("@/lib/db/learner-repo").listOwnedLearners>) {
  return (await implementation()).listOwnedLearners(...args);
}
export async function getOwnedLearner(...args: Parameters<typeof import("@/lib/db/learner-repo").getOwnedLearner>) {
  return (await implementation()).getOwnedLearner(...args);
}
export async function getParentTimezone(parentUserId: string) {
  return (await implementation()).getParentTimezone(parentUserId);
}
