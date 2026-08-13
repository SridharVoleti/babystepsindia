import Link from "next/link";
import type { Metadata } from "next";
import { requireParentManagement } from "@/lib/auth/guards";
import { composeParentAttention } from "@/lib/parent-attention/service";
import type { AttentionItem, AttentionSeverity } from "@/lib/parent-attention/contracts";

export const metadata: Metadata = { title: "Attention — Baby Steps" };

const SEVERITY_LABEL: Record<AttentionSeverity, string> = {
  action_required: "Action needed",
  attention: "Attention",
  info: "Info",
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
        {SEVERITY_LABEL[item.severity]}
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

export default async function AttentionPage() {
  const { session } = await requireParentManagement();
  const attention = composeParentAttention(session.sub, new Date());

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-16">
      <Link href="/account" className="text-sm font-medium text-green-700">← Back to dashboard</Link>
      <h1 className="mt-3 text-2xl font-bold text-chakra-900">Attention</h1>
      <p className="mt-1 text-sm text-chakra-500">
        Everything here reflects a current status from its own area — resolving it there updates this list.
      </p>

      {attention.items.length === 0 ? (
        <p className="card mt-6 p-5 text-sm text-chakra-500">Nothing needs your attention right now.</p>
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
