import { getDb } from "@/lib/db/client";

// AR-002 business rule 6/24: a provider-confirmed origin is trusted only
// when its hostname resolves under an admin-curated approved domain
// suffix — never an admin/browser-asserted value.
export function isOriginApproved(origin: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  const suffixes = getDb()
    .prepare("select domain_suffix from approved_domains where status = 'active'")
    .all() as { domain_suffix: string }[];
  return suffixes.some(({ domain_suffix: suffix }) => {
    const normalized = suffix.toLowerCase();
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  });
}
