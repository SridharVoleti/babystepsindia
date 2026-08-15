import Link from "next/link";
import type { Metadata } from "next";
import { requireParentManagement } from "@/lib/auth/guards";
import { composeParentAttentionList, ParentAttentionRequestError } from "@/lib/parent-attention/service";
import { listOwnedLearners, getParentTimezone } from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import type { AttentionCategory, AttentionItem, AttentionSeverity } from "@/lib/parent-attention/contracts";

export const metadata: Metadata = { title: "Attention — Baby Steps" };

const SEVERITY_LABEL: Record<AttentionSeverity, string> = {
  action_required: "Action needed",
  attention: "Attention",
  info: "Info",
};

const CATEGORY_LABEL: Record<AttentionCategory, string> = {
  billing: "Billing",
  learner_setup: "Learner setup",
  service_status: "Service status",
  learning_cadence: "Learning cadence",
  access: "Access",
};

const SEVERITY_STYLE: Record<AttentionSeverity, string> = {
  action_required: "border-red-200 bg-red-50",
  attention: "border-amber-200 bg-amber-50",
  info: "border-chakra-100 bg-white",
};

function AttentionCard({ item }: { item: AttentionItem }) {
  return (
    <article className={`card border p-4 ${SEVERITY_STYLE[item.severity]}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-chakra-500">
        {SEVERITY_LABEL[item.severity]} · {CATEGORY_LABEL[item.category]}
      </p>
      <h3 className="mt-1 font-semibold text-chakra-900">{item.title}</h3>
      <p className="mt-1 text-sm text-chakra-600">{item.message}</p>
      {item.route && (
        <Link href={item.route.href}
          className="mt-3 inline-flex min-h-[44px] items-center text-sm font-medium text-green-700 hover:text-green-800">
          {item.route.label} →
        </Link>
      )}
    </article>
  );
}

function filterHref(current: { severity?: string; category?: string; learnerId?: string }, patch: Record<string, string | null>) {
  const next = { ...current, ...patch };
  const params = new URLSearchParams();
  if (next.severity) params.set("severity", next.severity);
  if (next.category) params.set("category", next.category);
  if (next.learnerId) params.set("learnerId", next.learnerId);
  const query = params.toString();
  return query ? `?${query}` : "/account/attention";
}

function chipClass(active: boolean) {
  return `inline-flex min-h-[44px] items-center rounded-lg border px-3 py-2 text-sm font-medium ${
    active ? "border-green-700 bg-green-50 text-green-800" : "border-chakra-200 text-chakra-700"}`;
}

// PD-003: filters are a pure read-side narrowing over API-PD-004's own
// composeParentAttentionList — they never mutate a source state (AT-PD-003-35).
export default async function AttentionPage({ searchParams }: {
  searchParams: { severity?: string; category?: string; learnerId?: string };
}) {
  const { session } = await requireParentManagement();
  const severity = searchParams.severity;
  const category = searchParams.category;
  const learnerId = searchParams.learnerId;

  const learners = listOwnedLearners(session.sub, calendarDateInTimeZone(getParentTimezone(session.sub)));
  // PD3-G09: a hand-crafted/stale query value degrades to the unfiltered
  // view rather than a hard error — the API route is where invalid filters
  // return a strict 400 (tests/pd-003-attention-routes.test.ts).
  let attention;
  try {
    attention = composeParentAttentionList(session.sub, { severity, category, learnerId, limit: "50" }, new Date());
  } catch (error) {
    if (!(error instanceof ParentAttentionRequestError)) throw error;
    attention = composeParentAttentionList(session.sub, { limit: "50" }, new Date());
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-16">
      <Link href="/account" className="text-sm font-medium text-green-700">← Back to dashboard</Link>
      <h1 className="mt-3 text-2xl font-bold text-chakra-900">Attention</h1>
      <p className="mt-1 text-sm text-chakra-500">
        Everything here reflects a current status from its own area — resolving it there updates this list.
      </p>

      <section aria-label="Filter attention items" className="mt-6 space-y-3">
        <div className="flex flex-wrap gap-2">
          <Link href={filterHref({ category, learnerId }, { severity: null })} className={chipClass(!severity)}>All statuses</Link>
          {(Object.keys(SEVERITY_LABEL) as AttentionSeverity[]).map((value) => (
            <Link key={value} href={filterHref({ category, learnerId }, { severity: value })} className={chipClass(severity === value)}>
              {SEVERITY_LABEL[value]}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={filterHref({ severity, learnerId }, { category: null })} className={chipClass(!category)}>All categories</Link>
          {(Object.keys(CATEGORY_LABEL) as AttentionCategory[]).map((value) => (
            <Link key={value} href={filterHref({ severity, learnerId }, { category: value })} className={chipClass(category === value)}>
              {CATEGORY_LABEL[value]}
            </Link>
          ))}
        </div>
        {learners.length > 1 && (
          <div className="flex flex-wrap gap-2">
            <Link href={filterHref({ severity, category }, { learnerId: null })} className={chipClass(!learnerId)}>All learners</Link>
            {learners.map((learner) => (
              <Link key={learner.id} href={filterHref({ severity, category }, { learnerId: learner.id })}
                className={chipClass(learnerId === learner.id)}>
                {learner.displayName}
              </Link>
            ))}
          </div>
        )}
      </section>

      {attention.items.length === 0 ? (
        <p className="card mt-6 p-5 text-sm text-chakra-500">
          {severity || category || learnerId ? "No items match this filter." : "Nothing needs your attention right now."}
        </p>
      ) : (
        <div className="mt-6 space-y-3">
          {attention.items.map((item) => <AttentionCard key={item.sourceKey} item={item} />)}
        </div>
      )}

      {attention.partialErrors.length > 0 && (
        <p className="mt-6 text-xs text-chakra-400">
          Some areas couldn&apos;t be checked just now. Reload to try again.
        </p>
      )}
    </main>
  );
}
