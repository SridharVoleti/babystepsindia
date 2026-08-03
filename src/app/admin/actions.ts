"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/guards";
import { createManualGrant, findUserByEmailForGrant } from "@/lib/db/subscriptions";
import { findProductBySlug } from "@/lib/db/products";

export type GrantActionState = {
  error: string | null;
  success?: boolean;
};

// REQ-08 §7 — manual "grant access" for when payment succeeded but the
// (not-yet-built) Razorpay webhook failed to record it.
export async function grantAccessAction(
  _prevState: GrantActionState,
  formData: FormData,
): Promise<GrantActionState> {
  const admin = await requireAdmin();

  const email = String(formData.get("email") ?? "").trim();
  const type = String(formData.get("type") ?? "");
  const productSlug = String(formData.get("productSlug") ?? "");
  const periodEnd = String(formData.get("periodEnd") ?? "");
  const note = String(formData.get("note") ?? "").trim();

  if (!email) {
    return { error: "Enter the user's email." };
  }
  if (type !== "bundle" && type !== "single") {
    return { error: "Choose bundle or single product." };
  }
  if (!periodEnd) {
    return { error: "Choose an access-until date." };
  }

  const user = findUserByEmailForGrant(email);
  if (!user) {
    return { error: `No account found for ${email}.` };
  }

  let productId: string | null = null;
  if (type === "single") {
    const product = findProductBySlug(productSlug);
    if (!product) {
      return { error: "Choose a product." };
    }
    productId = product.id;
  }

  createManualGrant({
    userId: user.id,
    type,
    productId,
    currentPeriodEnd: `${periodEnd} 23:59:59`,
    adminEmail: admin.email,
    note: note || null,
  });

  revalidatePath("/admin");
  revalidatePath("/admin/audit");

  return { error: null, success: true };
}
