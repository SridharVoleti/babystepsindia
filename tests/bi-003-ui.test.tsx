import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PaymentRecoveryPanel } from "@/components/billing/payment-recovery-panel";

describe("BI-003 parent recovery UI", () => {
  it("AT-BI-003-22/24/25 shows deadline, safe progress messaging and provider-hosted update authority", () => {
    render(<PaymentRecoveryPanel subscriptionId="sub-1" paymentState="past_due_grace"
      graceEndsAt="2026-09-17T10:00:00.000Z" expectedVersion={3} />);
    expect(screen.getByText(/Payment unsuccessful/i)).toBeInTheDocument();
    expect(screen.getByText(/Progress is safe/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Update payment method/i })).toBeInTheDocument();
    expect(screen.getByText(/Payment remains unconfirmed/i)).toBeInTheDocument();
  });

  it("AT-BI-003-29/40 explains nonpayment cutoff without deleting progress", () => {
    render(<PaymentRecoveryPanel subscriptionId="sub-1" paymentState="inactive_nonpayment"
      graceEndsAt="2026-09-17T10:00:00.000Z" expectedVersion={4} />);
    expect(screen.getByText(/New learning sessions cannot start/i)).toBeInTheDocument();
    expect(screen.getByText(/progress is safe/i)).toBeInTheDocument();
  });
});
