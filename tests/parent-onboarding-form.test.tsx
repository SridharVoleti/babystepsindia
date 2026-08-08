import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ParentOnboardingForm } from "@/components/onboarding/parent-onboarding-form";
import type { OnboardingProfileView } from "@/lib/db/parent-profile-repo";

const baseProfile: OnboardingProfileView = {
  email: "parent@example.com",
  displayName: null,
  phoneE164: null,
  phoneCountryCode: null,
  onboardingStatus: "profile_pending",
  locale: "en-IN",
  timezone: "Asia/Kolkata",
  currentPolicyVersions: { termsOfService: "1.0", privacyPolicy: "1.0" },
};

let originalLocation: Location;

beforeEach(() => {
  originalLocation = window.location;
  // jsdom throws on direct assignment to window.location.href; replace
  // the whole object so the redirect-after-success assertion can inspect it.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, href: "" },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
  vi.unstubAllGlobals();
});

describe("ParentOnboardingForm (AT-IA-002-*)", () => {
  it("shows the authenticated email as read-only", () => {
    render(<ParentOnboardingForm initialProfile={baseProfile} />);
    const email = screen.getByLabelText(/email/i) as HTMLInputElement;
    expect(email).toHaveValue("parent@example.com");
    expect(email).toHaveAttribute("readonly");
  });

  it("restores a saved phone and preserves locale/timezone when onboarding resumes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...baseProfile, onboardingStatus: "learner_pending" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <ParentOnboardingForm
        initialProfile={{
          ...baseProfile,
          phoneE164: "+919876543210",
          phoneCountryCode: "IN",
          locale: "hi-IN",
          timezone: "Asia/Calcutta",
        }}
      />,
    );

    expect(screen.getByLabelText(/mobile number/i)).toHaveValue("+919876543210");
    await user.click(screen.getByLabelText(/terms of service/i));
    await user.click(screen.getByLabelText(/privacy policy/i));
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ locale: "hi-IN", timezone: "Asia/Calcutta" });
  });

  it("does not mark the parent name as required (AC6)", () => {
    render(<ParentOnboardingForm initialProfile={baseProfile} />);
    expect(screen.getByLabelText(/parent name/i)).not.toBeRequired();
  });

  it("stacks the phone controls at 320px and only uses a row at the small breakpoint", () => {
    render(<ParentOnboardingForm initialProfile={baseProfile} />);
    const country = screen.getByLabelText(/country/i);
    const phoneGroup = country.parentElement;
    expect(phoneGroup).toHaveClass("flex-col", "sm:flex-row");
    expect(country).toHaveClass("w-full", "sm:w-auto");
    expect(screen.getByLabelText(/mobile number/i)).toHaveClass("min-w-0", "w-full");
  });

  it("renders no postal address or date-of-birth fields (AC10/AT-IA-002-10)", () => {
    render(<ParentOnboardingForm initialProfile={baseProfile} />);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/address/i);
    expect(text).not.toMatch(/date of birth/i);
  });

  it("disables Continue until a valid mobile number and both policies are accepted (AC3)", async () => {
    const user = userEvent.setup();
    render(<ParentOnboardingForm initialProfile={baseProfile} />);

    const continueButton = screen.getByRole("button", { name: /continue/i });
    expect(continueButton).toBeDisabled();

    await user.type(screen.getByLabelText(/mobile number/i), "9876543210");
    expect(continueButton).toBeDisabled();

    await user.click(screen.getByLabelText(/terms of service/i));
    await user.click(screen.getByLabelText(/privacy policy/i));
    expect(continueButton).toBeEnabled();
  });

  it("shows an inline country-aware error for an invalid number and keeps Continue disabled (AT-IA-002-04)", async () => {
    const user = userEvent.setup();
    render(<ParentOnboardingForm initialProfile={baseProfile} />);

    await user.type(screen.getByLabelText(/mobile number/i), "123");
    await user.click(screen.getByLabelText(/terms of service/i));
    await user.click(screen.getByLabelText(/privacy policy/i));

    expect(screen.getByRole("button", { name: /continue/i })).toBeDisabled();
    const error = screen.getByText(/valid mobile number/i);
    const mobile = screen.getByLabelText(/mobile number/i);
    expect(error).toHaveAttribute("id", "mobileNumber-error");
    expect(error).toHaveAttribute("role", "alert");
    expect(mobile).toHaveAttribute("aria-invalid", "true");
    expect(mobile).toHaveAttribute("aria-describedby", "mobileNumber-error mobileNumber-help");
  });

  it("submits the normalized E.164 number and current policy versions, then redirects to /account", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...baseProfile, onboardingStatus: "learner_pending" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<ParentOnboardingForm initialProfile={baseProfile} />);

    await user.type(screen.getByLabelText(/mobile number/i), "9876543210");
    await user.click(screen.getByLabelText(/terms of service/i));
    await user.click(screen.getByLabelText(/privacy policy/i));
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/v1/parent/profile");
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body);
    expect(body.mobileNumber).toBe("9876543210");
    expect(body.phoneCountryCode).toBe("IN");
    expect(body.acceptedTermsVersion).toBe("1.0");
    expect(body.acceptedPrivacyVersion).toBe("1.0");

    await waitFor(() => expect(window.location.href).toBe("/account"));
  });

  it("preserves entered values and allows retry after a failed save (AC14/AT-IA-002-14)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "SAVE_FAILED", message: "Something went wrong. Please try again." }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<ParentOnboardingForm initialProfile={baseProfile} />);

    await user.type(screen.getByLabelText(/parent name/i), "Asha Verma");
    await user.type(screen.getByLabelText(/mobile number/i), "9876543210");
    await user.click(screen.getByLabelText(/terms of service/i));
    await user.click(screen.getByLabelText(/privacy policy/i));
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());

    expect(screen.getByLabelText(/parent name/i)).toHaveValue("Asha Verma");
    expect(screen.getByLabelText(/mobile number/i)).toHaveValue("9876543210");
    expect(screen.getByRole("button", { name: /retry/i })).toBeEnabled();
  });
});
