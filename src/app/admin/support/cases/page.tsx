import Link from "next/link";
import { requireAdminPermission } from "@/lib/auth/guards";
import { listSupportCases } from "@/lib/support-cases/service";
import { SupportResolverForm } from "@/components/admin/support-resolver-form";

// AD-002 rules 33, 87, 89, 94: the support home is case-first — a queue of
// permitted CASES, never a customer list, with the exact resolver visually
// separate above it. Desktop-primary V1 surface.
export default async function SupportCasesPage() {
  const session = await requireAdminPermission("admin.support.case.list");
  const result = await listSupportCases({ staffAccountId: session.staffAccountId, roleKeys: session.roleKeys }, {});

  return (
    <div>
      <h1 className="text-2xl font-bold text-chakra-900">Support cases</h1>
      <p className="mt-1 text-sm text-chakra-500">Case-first support — resolve an exact customer, then open a case.</p>

      <div className="mt-6"><SupportResolverForm /></div>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-chakra-900">Your case queue</h2>
        {result.cases.length === 0 ? (
          <p className="mt-3 text-sm text-chakra-500">No permitted cases right now.</p>
        ) : (
          <div className="mt-3 space-y-3">
            {result.cases.map((c) => (
              <Link key={c.caseId} href={`/admin/support/cases/${c.caseId}`}
                className="card block p-4 hover:border-green-700">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-chakra-900">{c.category}</span>
                  <span className="text-sm text-chakra-500">{c.status} · {c.priority}</span>
                </div>
                <p className="mt-1 text-xs text-chakra-400">Updated {c.updatedAt}</p>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
