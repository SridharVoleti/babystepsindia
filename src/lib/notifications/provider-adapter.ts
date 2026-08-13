import { createHash } from "node:crypto";

// Mirrors src/lib/learning-reminders/service.ts's ReminderEmailProvider
// shape deliberately — same injected-optional-param seam, same
// accepted/delivered/uncertain/failed vocabulary, so a future real email
// vendor adapter can serve both callers without divergent contracts.
export type TransactionalEmailProvider = {
  send(input: { to: string; subject: string; text: string; html: string; idempotencyKey: string }):
    { status: "accepted" | "delivered" | "uncertain" | "failed"; providerMessageId?: string | null };
  lookup?(input: { providerMessageId: string | null; idempotencyKey: string }):
    { status: "delivered" | "pending" | "not_found" | "failed" };
};

export const localTransactionalEmailProvider: TransactionalEmailProvider = {
  send(input) {
    return { status: "accepted", providerMessageId: `local:${digest(input.idempotencyKey).slice(0, 24)}` };
  },
  lookup(input) {
    return { status: input.providerMessageId ? "delivered" : "not_found" };
  },
};

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
