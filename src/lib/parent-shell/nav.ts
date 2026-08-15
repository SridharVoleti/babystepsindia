// PD-004 AC3/API-PD-006: the one canonical nav definition — ParentNav (the
// rendered desktop/mobile chrome, a client component) and
// composeParentShellContext's navItems[] (a server composer) both read this
// exact array, never two independently-maintained destination lists. Kept
// in its own client-safe module (no db/node imports) so the client bundle
// pulling this in doesn't also pull in server-only code.
export type ParentShellNavItem = {
  key: string;
  href: string;
  label: string;
  showsAttentionBadge?: boolean;
};

export const PARENT_NAV_VERSION = "1";
export const PARENT_NAV_ITEMS: readonly ParentShellNavItem[] = [
  { key: "home", href: "/account", label: "Home" },
  { key: "learners", href: "/account/learners", label: "Learners" },
  { key: "attention", href: "/account/attention", label: "Attention", showsAttentionBadge: true },
  { key: "billing", href: "/account/subscriptions", label: "Billing" },
  { key: "account", href: "/account/security", label: "Account" },
] as const;
