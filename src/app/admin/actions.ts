"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/guards";
import { createManualGrant, findUserByEmailForGrant } from "@/lib/db/subscriptions";
import { findProductBySlug } from "@/lib/db/products";
import { findStaffById } from "@/lib/staff-identity/accounts-repo";
import { clearStaffSessionCookie } from "@/lib/staff-identity/session";

export async function signOutStaffAction() {
  clearStaffSessionCookie();
  redirect("/staff/login");
}

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
  const learnerId = String(formData.get("learnerId") ?? "").trim();
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
  if (!learnerId) {
    return { error: "Enter the learner ID this subscription belongs to." };
  }

  const user = await findUserByEmailForGrant(email);
  if (!user) {
    return { error: `No account found for ${email}.` };
  }

  const product = await findProductBySlug(productSlug);
  if (!product || (type === "bundle" && product.product_type !== "bundle") ||
    (type === "single" && product.product_type !== "individual_app")) {
    return { error: "Choose a product matching the selected type." };
  }

  await createManualGrant({
    userId: user.id,
    assignedLearnerId: learnerId,
    type,
    productId: product.id,
    currentPeriodEnd: `${periodEnd} 23:59:59`,
    adminEmail: findStaffById(admin.staffAccountId)?.normalized_email ?? admin.staffAccountId,
    note: note || null,
  });

  revalidatePath("/admin");
  revalidatePath("/admin/audit");

  return { error: null, success: true };
}
