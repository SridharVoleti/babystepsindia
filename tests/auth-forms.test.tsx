import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SignupFields } from "@/components/auth/signup-form";
import { LoginFields } from "@/components/auth/login-form";
import { initialAuthState } from "@/lib/auth-types";

const DISALLOWED_PROVIDERS = [/google/i, /apple/i, /phone/i, /magic link/i, /\botp\b/i];

describe("SignupFields (AT-IA-001-09)", () => {
  it("renders email, password, and confirm-password fields", () => {
    render(<SignupFields state={initialAuthState} />);
    expect(screen.getByLabelText(/^email$/i)).toHaveAttribute("type", "email");
    expect(screen.getByLabelText(/^password$/i)).toHaveAttribute("type", "password");
    expect(screen.getByLabelText(/confirm password/i)).toHaveAttribute("type", "password");
  });

  it("has a show/hide password control", () => {
    render(<SignupFields state={initialAuthState} />);
    expect(screen.getAllByRole("button", { name: /show password/i })).toHaveLength(2);
  });

  it("shows the password requirements", () => {
    render(<SignupFields state={initialAuthState} />);
    expect(screen.getByText(/12 characters/i)).toBeInTheDocument();
  });

  it("requires accepting Terms and Privacy", () => {
    render(<SignupFields state={initialAuthState} />);
    expect(screen.getByLabelText(/terms/i)).toBeRequired();
    expect(screen.getByLabelText(/privacy/i)).toBeRequired();
  });

  it("contains no social, phone, or magic-link controls", () => {
    render(<SignupFields state={initialAuthState} />);
    const text = document.body.textContent ?? "";
    for (const pattern of DISALLOWED_PROVIDERS) {
      expect(text).not.toMatch(pattern);
    }
  });

  it("shows the verification link in the success state instead of the form", () => {
    render(
      <SignupFields
        state={{ error: null, success: true, verificationUrl: "http://localhost/auth/confirm?token=abc" }}
      />,
    );
    expect(screen.queryByLabelText(/^email$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/confirmation link/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /auth\/confirm/i })).toHaveAttribute(
      "href",
      "http://localhost/auth/confirm?token=abc",
    );
  });
});

describe("LoginFields (AT-IA-001-09)", () => {
  it("renders email and password fields only", () => {
    render(<LoginFields state={initialAuthState} />);
    expect(screen.getByLabelText(/^email$/i)).toHaveAttribute("type", "email");
    expect(screen.getByLabelText(/^password$/i)).toHaveAttribute("type", "password");
  });

  it("has a show/hide password control that does not force a minimum length", () => {
    render(<LoginFields state={initialAuthState} />);
    expect(screen.getByRole("button", { name: /show password/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).not.toHaveAttribute("minlength");
  });

  it("contains no social, phone, or magic-link controls", () => {
    render(<LoginFields state={initialAuthState} />);
    const text = document.body.textContent ?? "";
    for (const pattern of DISALLOWED_PROVIDERS) {
      expect(text).not.toMatch(pattern);
    }
  });
});
