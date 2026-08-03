"use client";

import { useFormState, useFormStatus } from "react-dom";
import { grantAccessAction, type GrantActionState } from "@/app/admin/actions";
import type { ProductRow } from "@/lib/db/types";

const initialState: GrantActionState = { error: null };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn-primary">
      {pending ? "Granting…" : "Grant access"}
    </button>
  );
}

export function GrantForm({ products }: { products: ProductRow[] }) {
  const [state, formAction] = useFormState(grantAccessAction, initialState);

  return (
    <form action={formAction} className="max-w-lg space-y-5">
      {state.error && (
        <p
          role="alert"
          className="rounded-lg bg-saffron-50 px-3.5 py-2.5 text-sm text-saffron-800"
        >
          {state.error}
        </p>
      )}
      {state.success && (
        <p className="rounded-lg bg-green-50 px-3.5 py-2.5 text-sm text-green-800">
          Access granted and logged to the audit trail.
        </p>
      )}

      <div>
        <label htmlFor="email" className="field-label">
          User email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          className="field-input"
          placeholder="parent@example.com"
        />
      </div>

      <fieldset>
        <legend className="field-label">Type</legend>
        <div className="flex gap-5 text-sm text-chakra-700">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="type"
              value="single"
              defaultChecked
              className="accent-green-600"
            />
            Single product
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="type" value="bundle" className="accent-green-600" />
            Bundle
          </label>
        </div>
      </fieldset>

      <div>
        <label htmlFor="productSlug" className="field-label">
          Product (if single)
        </label>
        <select id="productSlug" name="productSlug" className="field-input">
          {products.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="periodEnd" className="field-label">
          Access until
        </label>
        <input
          id="periodEnd"
          name="periodEnd"
          type="date"
          required
          className="field-input"
        />
      </div>

      <div>
        <label htmlFor="note" className="field-label">
          Note (optional)
        </label>
        <textarea
          id="note"
          name="note"
          rows={2}
          className="field-input"
          placeholder="e.g. payment succeeded, webhook missed it — Razorpay ref rzp_xyz"
        />
      </div>

      <SubmitButton />
    </form>
  );
}
