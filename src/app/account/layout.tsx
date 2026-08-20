import { requireParentManagement } from "@/lib/auth/guards";
import { composeParentShellContext } from "@/lib/parent-shell/service";
import { ParentNav } from "@/components/account/parent-nav";
import { ParentModeGuard } from "@/components/account/mode-guard";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { signOutAction } from "@/app/(auth)/actions";

// PD-004: one common parent-management shell for every verified parent
// session. Each page under src/app/account still calls
// requireParentManagement() directly (tests/au-002.acceptance.test.ts
// AT-AU-002-10) — this layout's own call is additional defense-in-depth,
// not a replacement, and lets the shell derive the attention badge without
// every page recomposing it. composeParentShellContext already isolates an
// attentionSummary failure internally (AT-PD-004-08), so this outer
// try/catch only guards a total composer failure (e.g. the db itself is
// unavailable) — the badge simply shows zero rather than blocking
// navigation.
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const { session, authorization } = await requireParentManagement();
  let context;
  try {
    context = await composeParentShellContext(session.sub, authorization.modeGeneration, new Date());
  } catch {
    context = null;
  }
  const attentionCount = context?.attentionSummary
    ? context.attentionSummary.actionRequiredCount + context.attentionSummary.attentionCount
    : 0;

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      {/* PD-004 AC23/25/29: revalidates modeGeneration on bfcache restore,
          focus/visibility return and cross-tab mode-transition signals —
          the server guard above only re-runs on an actual new request. */}
      <ParentModeGuard modeGeneration={authorization.modeGeneration} />
      <ParentNav attentionCount={attentionCount} navItems={context?.navItems} onSignOut={signOutAction} />
      <div className="flex-1 pb-16 sm:pb-0">{children}</div>
      <SiteFooter />
    </div>
  );
}
