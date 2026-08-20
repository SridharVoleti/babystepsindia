import { resolveDbClient } from "@/lib/db-client";
import type { ParentProfile, ParentProfileStore } from "@/lib/auth/parent-profile";

type ProfileStatusRow = {
  id: string;
  account_status: ParentProfile["account_status"];
  onboarding_status: ParentProfile["onboarding_status"];
  auth_revoked_before: string | null;
};

const SELECT_COLUMNS = "id, account_status, onboarding_status, auth_revoked_before";

function toParentProfile(row: ProfileStatusRow): ParentProfile {
  return {
    id: row.id,
    account_status: row.account_status,
    onboarding_status: row.onboarding_status,
    auth_revoked_before: row.auth_revoked_before,
  };
}

export const sqliteParentProfileStore: ParentProfileStore = {
  async find(id) {
    const row = await resolveDbClient().get<ProfileStatusRow>(
      `select ${SELECT_COLUMNS} from profiles where id = ?`, [id]);
    return row ? toParentProfile(row) : null;
  },

  async insert(id) {
    // ON CONFLICT DO NOTHING mirrors the idempotent auth.users trigger
    // (supabase/migrations/0008): a second concurrent recovery call is a
    // no-op, not an error or a duplicate row.
    await resolveDbClient().run("insert into profiles (id) values (?) on conflict (id) do nothing", [id]);

    const row = await resolveDbClient().get<ProfileStatusRow>(
      `select ${SELECT_COLUMNS} from profiles where id = ?`, [id]);
    return toParentProfile(row!);
  },
};
