const implementation = () => {
  if (process.env.SUPABASE_DB_URL) return import("@/lib/learner-profile/postgres-service");
  if (process.env.NEXT_PUBLIC_SUPABASE_URL) throw new Error("LP001_POSTGRES_NOT_CONFIGURED");
  return import("@/lib/db/learner-repo");
};

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
