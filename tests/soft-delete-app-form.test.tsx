import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SoftDeleteAppForm } from "@/components/app-registry/soft-delete-app-form";

describe("SoftDeleteAppForm (AT-AR-001-17)", () => {
  it("disables submit until the exact app_key is typed and a reason is chosen", async () => {
    const user = userEvent.setup();
    render(<SoftDeleteAppForm appId="app-1" appKey="chess-master" expectedVersion={2} />);

    const button = screen.getByRole("button", { name: /soft delete this app/i });
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText(/current password/i), "CorrectHorse1!");
    await user.selectOptions(screen.getByLabelText(/reason/i), "no_longer_supported");
    await user.type(screen.getByLabelText(/type.*chess-master.*confirm/i), "chess-mastr");
    expect(button).toBeDisabled();

    await user.clear(screen.getByLabelText(/type.*chess-master.*confirm/i));
    await user.type(screen.getByLabelText(/type.*chess-master.*confirm/i), "chess-master");
    expect(button).toBeEnabled();
  });
});
