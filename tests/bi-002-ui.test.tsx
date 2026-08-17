import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CheckoutAssignmentForm } from "@/components/billing/checkout-assignment-form";

const product = { id: "product-1", name: "Math Monthly", productType: "individual_app", version: 1,
  priceInr: 299, price: { id: "price-1", version: 1, amount: 29900, currency: "INR",
    billingInterval: "month" as const, intervalCount: 1, supportsNonRenewing: true,
    pricingRuleVersion: "rule-v1" }, consentDisclosureVersion: "recurring-billing-v1",
  includedApps: [{ id: "app-1", name: "Magical Math" }] };
const learners = [{ id: "learner-1", displayName: "Asha" }];

afterEach(() => vi.unstubAllGlobals());

describe("BI-002 final checkout review", () => {
  it("AT-BI-002-01/02/05-09 shows the exact review with visible auto-renew selected by default and no load consent", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<CheckoutAssignmentForm product={product} learners={learners} privacyConsentRequired={false} />);
    expect(screen.getByRole("checkbox", { name: "Automatically renew this subscription" })).toBeChecked();
    expect(screen.getByText(/authorize recurring charges/i)).toBeVisible();
    expect(screen.getByText(/₹299\.00/)).toBeVisible();
    expect(screen.getByText(/one calendar billing interval after activation/i)).toBeVisible();
    expect(screen.getByText(/This subscription is for Asha/i)).toBeVisible();
    expect(screen.getByText(/Magical Math/)).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: "Accept Babysteps platform privacy consent" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("AT-BI-002-03/04 preserves the parent's final unchecked value on active submit", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      assignedLearner: { displayName: "Asha" }, autoRenewEnabled: false,
      providerHandoff: { url: "/provider" },
    }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<CheckoutAssignmentForm product={product} learners={learners} privacyConsentRequired={false} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Automatically renew this subscription" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /confirm the learner/i }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ learnerId: "learner-1", productId: "product-1", priceId: "price-1",
      autoRenewEnabled: false, consentDisclosureVersion: "recurring-billing-v1", privacyConsentAccepted: false });
  });

  it("PC-002 presents and submits privacy consent only when the current material version is required", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      assignedLearner: { displayName: "Asha" }, autoRenewEnabled: true,
      providerHandoff: { url: "/provider" },
    }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<CheckoutAssignmentForm product={product} learners={learners} privacyConsentRequired />);
    const privacy = screen.getByRole("checkbox", { name: "Accept Babysteps platform privacy consent" });
    expect(privacy).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Continue to payment" })).toBeDisabled();
    fireEvent.click(privacy);
    fireEvent.click(screen.getByRole("checkbox", { name: /confirm the learner/i }));
    fireEvent.click(screen.getByRole("button", { name: "Continue to payment" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.privacyConsentAccepted).toBe(true);
  });
});
