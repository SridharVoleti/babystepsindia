import { requireParentManagement } from "@/lib/auth/guards";
import { composeParentShellContext } from "@/lib/parent-shell/service";
import { ParentNav } from "@/components/account/parent-nav";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { signOutAction } from "@/app/(auth)/actions";

// PD-004: one common parent-management shell for every verified parent
// session. Each page under src/app/account still calls
// requireParentManagement() directly (tests/au-002.acceptance.test.ts
// AT-AU-002-10) — this layout's own call is additional defense-in-depth,
// not a replacement, and lets the shell derive the attention badge without
// every page recomposing it. A shell-badge failure degrades non-blocking:
// if composeParentShellContext throws, the badge simply shows zero rather
// than blocking navigation.
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const { session } = await requireParentManagement();
  let attentionCount = 0;
  try {
    const context = composeParentShellContext(session.sub, new Date());
    attentionCount = context.attentionBadge.actionRequiredCount + context.attentionBadge.attentionCount;
  } catch {
    attentionCount = 0;
  }

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <ParentNav attentionCount={attentionCount} onSignOut={signOutAction} />
      <div className="flex-1 pb-16 sm:pb-0">{children}</div>
      <SiteFooter />
    </div>
  );
}
