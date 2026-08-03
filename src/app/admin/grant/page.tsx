import type { Metadata } from "next";
import { listProducts } from "@/lib/db/products";
import { GrantForm } from "@/components/admin/grant-form";

export const metadata: Metadata = { title: "Grant access — Baby Steps Admin" };

export default function GrantAccessPage() {
  const products = listProducts();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-chakra-900">Grant access</h1>
        <p className="mt-1 text-sm text-chakra-500">
          For cases where payment succeeded but the (not-yet-built) Razorpay
          webhook failed to record it (REQ-08 §7). The user must already have
          an account.
        </p>
      </div>

      <div className="card p-6">
        <GrantForm products={products} />
      </div>
    </div>
  );
}
