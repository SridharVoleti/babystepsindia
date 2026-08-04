import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LearnerProfileEditForm } from "@/components/learners/learner-profile-edit-form";

const learner = {
  id: "learner-1", displayName: "Aarav", dateOfBirth: "2018-04-03",
  avatarId: null, version: 1,
};

beforeEach(() => vi.restoreAllMocks());

describe("LP-002 edit form", () => {
  it("disables Save until an editable field changes and exposes no lifecycle controls", () => {
    render(<LearnerProfileEditForm initialLearner={learner} avatars={[]} />);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.queryByText(/delete|archive|pause|transfer/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Aarav Rao" } });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("submits only changed fields with version and idempotency metadata", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({
      learner: { ...learner, displayName: "Aarav Rao", version: 2 },
      changedFields: ["displayName"], noOp: false,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    render(<LearnerProfileEditForm initialLearner={learner} avatars={[]} />);
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Aarav Rao" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options?.body as string);
    expect(body).toMatchObject({ displayName: "Aarav Rao", expectedVersion: 1 });
    expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(body).not.toHaveProperty("dateOfBirth");
    expect(await screen.findByText("Profile updated.")).toBeInTheDocument();
  });
});
