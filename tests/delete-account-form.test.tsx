import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeleteAccountForm } from "@/components/account/delete-account-form";

describe("DeleteAccountForm", () => {
  it("disables the delete button until the exact text DELETE is typed", async () => {
    const user = userEvent.setup();
    render(<DeleteAccountForm />);

    const button = screen.getByRole("button", { name: /delete my account/i });
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText(/current password/i), "CorrectHorse1!");
    await user.type(screen.getByLabelText(/type delete/i), "delete");
    expect(button).toBeDisabled();

    await user.clear(screen.getByLabelText(/type delete/i));
    await user.type(screen.getByLabelText(/type delete/i), "DELETE");
    expect(button).toBeEnabled();
  });

  it("requires a current password even when the confirmation text is correct", async () => {
    const user = userEvent.setup();
    render(<DeleteAccountForm />);

    await user.type(screen.getByLabelText(/type delete/i), "DELETE");
    expect(screen.getByRole("button", { name: /delete my account/i })).toBeDisabled();
  });
});
