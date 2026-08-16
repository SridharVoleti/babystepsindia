import Link from "next/link";
import type { Metadata } from "next";
import { requireParentManagement } from "@/lib/auth/guards";
import { composeParentCommunicationHistory, ParentCommunicationHistoryRequestError } from "@/lib/notification-history/service";
import { listOwnedLearners, getParentTimezone } from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import type { NotificationHistoryCategory, NotificationHistoryDeliveryState, NotificationHistoryItem } from "@/lib/notification-history/contracts";

export const metadata: Metadata = { title: "Communication history — Baby Steps" };

const CATEGORY_LABEL: Record<NotificationHistoryCategory, string> = {
  billing: "Billing",
  account_security: "Account & security",
  service: "Service",
};

const DELIVERY_STATE_LABEL: Record<NotificationHistoryDeliveryState, string> = {
  sending_or_delayed: "Sending or delayed",
  sent: "Sent",
  delivered: "Delivered",
  delivery_failed: "Delivery failed",
  could_not_send: "Could not send",
};

function contextLine(item: NotificationHistoryItem): string | null {
  const parts = [item.learnerContext, item.appContext, item.subscriptionContext].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" });
}

function chipClass(active: boolean) {
  return `inline-flex min-h-[44px] items-center rounded-lg border px-3 py-2 text-sm font-medium ${
    active ? "border-green-700 bg-green-50 text-green-800" : "border-chakra-200 text-chakra-700"}`;
}

// NT2-G02: changing a category/learner filter always drops any active
// cursor (a keyset cursor from one filter combination isn't meaningful
// under another) — callers that only patch category/learnerId simply never
// pass a cursor through, so navigating filters always returns to page 1.
// Only the "Older communications" link below explicitly carries the
// current filters' cursor forward.
function filterHref(
  current: { category?: string; learnerId?: string; cursor?: string },
  patch: Record<string, string | null>,
) {
  const next = { ...current, ...patch };
  const params = new URLSearchParams();
  if (next.category) params.set("category", next.category);
  if (next.learnerId) params.set("learnerId", next.learnerId);
  if (next.cursor) params.set("cursor", next.cursor);
  const query = params.toString();
  return query ? `?${query}` : "/account/notifications/history";
}

// NT-002 rules 87-92: a compact chronological record, never an inbox — no
// full body, no unread markers, no folders/reply/resend/delete anywhere on
// this page (rules 59-64, 76-79).
export default async function CommunicationHistoryPage({ searchParams }: {
  searchParams: { category?: string; learnerId?: string; cursor?: string };
}) {
  const { session } = await requireParentManagement();
  const category = searchParams.category;
  const learnerId = searchParams.learnerId;
  const cursor = searchParams.cursor;

  const ageAsOfDate = calendarDateInTimeZone(getParentTimezone(session.sub));
  const learners = listOwnedLearners(session.sub, ageAsOfDate);

  let history;
  try {
    history = composeParentCommunicationHistory(session.sub, { category, learnerId, cursor, limit: "50" }, new Date());
  } catch (error) {
    if (!(error instanceof ParentCommunicationHistoryRequestError)) throw error;
    // NT2-G02: an invalid/stale cursor fails safely back to page 1 of the
    // same filters, never a hard error and never silently dropping category/
    // learner too.
    if (error.code === "INVALID_CURSOR") {
      history = composeParentCommunicationHistory(session.sub, { category, learnerId, limit: "50" }, new Date());
    } else {
      history = composeParentCommunicationHistory(session.sub, { limit: "50" }, new Date());
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10 sm:px-6 sm:py-16">
      <Link href="/account/notifications" className="inline-flex min-h-[44px] items-center text-sm font-medium text-green-700">
        ← Notification settings
      </Link>
      <h1 className="mt-3 text-2xl font-bold text-chakra-900">Communication history</h1>
      <p className="mt-2 text-sm text-chakra-600">
        A record of important account and billing communications from the last {history.retentionMonths} months —
        not a copy of the full email, and not your Attention list.
      </p>

      <section aria-label="Filter communication history" className="mt-6 space-y-3">
        <div className="flex flex-wrap gap-2">
          <Link href={filterHref({ learnerId }, { category: null })} className={chipClass(!category)}>All categories</Link>
          {(Object.keys(CATEGORY_LABEL) as NotificationHistoryCategory[]).map((value) => (
            <Link key={value} href={filterHref({ learnerId }, { category: value })} className={chipClass(category === value)}>
              {CATEGORY_LABEL[value]}
            </Link>
          ))}
        </div>
        {learners.length > 1 && (
          <div className="flex flex-wrap gap-2">
            <Link href={filterHref({ category }, { learnerId: null })} className={chipClass(!learnerId)}>All learners</Link>
            {learners.map((learner) => (
              <Link key={learner.id} href={filterHref({ category }, { learnerId: learner.id })}
                className={chipClass(learnerId === learner.id)}>
                {learner.displayName}
              </Link>
            ))}
          </div>
        )}
      </section>

      {history.items.length === 0 ? (
        <p className="card mt-6 p-5 text-sm text-chakra-500">
          {cursor
            ? "No further communications are available in the retained history window."
            : "No transactional communications are available in the retained history window."}
        </p>
      ) : (
        <>
          {/* Desktop: chronological compact table (rule 87). */}
          <table className="mt-6 hidden w-full border-collapse text-left sm:table">
            <caption className="sr-only">Communication history, newest first</caption>
            <thead>
              <tr className="border-b border-chakra-100 text-xs font-semibold uppercase tracking-wide text-chakra-500">
                <th scope="col" className="py-2 pr-3">Date</th>
                <th scope="col" className="py-2 pr-3">Communication</th>
                <th scope="col" className="py-2 pr-3">Context</th>
                <th scope="col" className="py-2 pr-3">Delivery status</th>
                <th scope="col" className="py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {history.items.map((item) => (
                <tr key={item.communicationId} className="border-b border-chakra-50 text-sm">
                  <td className="py-3 pr-3 text-chakra-600">{formatDate(item.occurredAt)}</td>
                  <td className="py-3 pr-3 font-medium text-chakra-900">{item.title}</td>
                  <td className="py-3 pr-3 text-chakra-600">{contextLine(item) ?? "—"}</td>
                  <td className="py-3 pr-3 text-chakra-700">{DELIVERY_STATE_LABEL[item.deliveryState]}</td>
                  <td className="py-3">
                    {item.action && (
                      <Link href={item.action.href} className="font-medium text-green-700 hover:text-green-800">
                        {item.action.label} →
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Mobile: deliberate one-column list, date/title/status before context (rule 88). */}
          <div className="mt-6 space-y-3 sm:hidden">
            {history.items.map((item) => (
              <article key={item.communicationId} className="card border border-chakra-100 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-chakra-500">
                  {formatDate(item.occurredAt)} · {DELIVERY_STATE_LABEL[item.deliveryState]}
                </p>
                <h2 className="mt-1 font-semibold text-chakra-900">{item.title}</h2>
                {contextLine(item) && <p className="mt-1 text-sm text-chakra-600">{contextLine(item)}</p>}
                {item.action && (
                  <Link href={item.action.href}
                    className="mt-3 inline-flex min-h-[44px] items-center text-sm font-medium text-green-700 hover:text-green-800">
                    {item.action.label} →
                  </Link>
                )}
              </article>
            ))}
          </div>

          {/* NT2-G02: deterministic keyset navigation — never offset-based,
              never automatic/polling. Filters (category/learnerId) are
              preserved via filterHref; browser back handles "previous"
              naturally since each page is a real URL. */}
          <nav aria-label="Communication history pages" className="mt-6 flex items-center justify-between">
            {history.nextCursor ? (
              <Link
                href={filterHref({ category, learnerId }, { cursor: history.nextCursor })}
                className="inline-flex min-h-[44px] items-center rounded-lg border border-chakra-200 px-4 py-2 text-sm font-medium text-chakra-700 hover:border-green-700 hover:text-green-800"
              >
                Older communications →
              </Link>
            ) : (
              <p className="text-sm text-chakra-500">You've reached the end of your retained history.</p>
            )}
          </nav>
        </>
      )}
    </main>
  );
}
