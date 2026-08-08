"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSession, setSessionCookie } from "@/lib/auth/session";
import { findProductBySlug } from "@/lib/db/products";
import { createSelfServeSubscription, getEntitlementsForUser } from "@/lib/db/subscriptions";

// Self-serve stand-in for the Razorpay checkout in REQ-08 §6, which isn't
// built yet. Grants 30 days of access to a single product so the
// subscribe -> launch loop (and the admin dashboard's numbers) are
// testable without a payment provider.
export async function subscribeAction(productSlug: string) {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  const product = findProductBySlug(productSlug);
  if (!product || product.status !== "active") {
    return;
  }

  const entitlements = getEntitlementsForUser(session.sub);
  const alreadyHasAccess =
    entitlements.bundle || entitlements.products.includes(productSlug);

  if (!alreadyHasAccess) {
    const periodEnd = new Date();
    periodEnd.setUTCDate(periodEnd.getUTCDate() + 30);

    createSelfServeSubscription({
      userId: session.sub,
      userEmail: session.email,
      productId: product.id,
      currentPeriodEnd: periodEnd.toISOString().slice(0, 19).replace("T", " "),
    });
  }

  // The real system only refreshes entitlements on token refresh (REQ-08
  // §4.2) — re-issue the session here anyway so the subscribe -> launch
  // loop doesn't require a logout/login to see the new access.
  await setSessionCookie({
    sid: session.sid,
    did: session.did,
    sub: session.sub,
    email: session.email,
    isAdmin: session.isAdmin,
    entitlements: getEntitlementsForUser(session.sub),
  });

  revalidatePath("/");
  revalidatePath("/account");
  revalidatePath("/admin");
}
