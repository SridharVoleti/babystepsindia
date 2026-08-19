"use server";

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { findProductBySlug } from "@/lib/db/products";

// BI-002: every entry point lands on the visible final review. A server
// action cannot create recurring consent on behalf of the parent.
export async function subscribeAction(productSlug: string, _learnerId: string) {
  const session = await getSession();
  if (!session) redirect("/login");
  const product = await findProductBySlug(productSlug);
  if (!product || product.status !== "active") return;
  redirect(`/account/subscriptions/new?product=${encodeURIComponent(productSlug)}`);
}
