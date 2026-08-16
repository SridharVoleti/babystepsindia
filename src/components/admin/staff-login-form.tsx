"use client";

import { useState } from "react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

// AD-001: staff login is password (first factor) then a real WebAuthn
// passkey ceremony (second factor) — no SMS/email-OTP fallback exists
// (business rule 18). A staff member with no passkey yet is routed into
// first-time enrollment inline, using the same pendingToken the password
// step already proved, rather than a separate page.
type Step = "credentials" | "enroll" | "verifying";

export function StaffLoginForm() {
  const [step, setStep] = useState<Step>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function beginLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/v1/admin/auth/passkey/assertion-options", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) throw new Error("credentials");
      const body = await response.json();
      if (body.purpose === "enrollment") {
        setStep("enroll");
        setPending(false);
        return;
      }
      await completeLoginAssertion(body.pendingToken, body.challengeId, body.options);
    } catch {
      setError("Could not sign in with those credentials.");
      setPending(false);
    }
  }

  async function completeLoginAssertion(pendingToken: string, challengeId: string, options: unknown) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const assertion = await startAuthentication({ optionsJSON: options as any });
      const verify = await fetch("/v1/admin/auth/passkey/verify", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pendingToken, challengeId, response: assertion }),
      });
      if (!verify.ok) throw new Error("verify");
      window.location.href = "/admin";
    } catch {
      setError("Could not verify your passkey. Please try again.");
      setPending(false);
    }
  }

  async function enrollAndLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const beginResponse = await fetch("/v1/admin/auth/passkey/assertion-options", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!beginResponse.ok) throw new Error("credentials");
      const { pendingToken } = await beginResponse.json();

      const optionsResponse = await fetch("/v1/admin/auth/passkey/registration-options", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pendingToken }),
      });
      if (!optionsResponse.ok) throw new Error("options");
      const { challengeId, options } = await optionsResponse.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const attestation = await startRegistration({ optionsJSON: options as any });
      const registerResponse = await fetch("/v1/admin/auth/passkey/register", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pendingToken, challengeId, response: attestation, label: label.trim() || "This device" }),
      });
      if (!registerResponse.ok) throw new Error("register");

      setStep("verifying");
      const loginBegin = await fetch("/v1/admin/auth/passkey/assertion-options", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!loginBegin.ok) throw new Error("credentials");
      const loginBody = await loginBegin.json();
      await completeLoginAssertion(loginBody.pendingToken, loginBody.challengeId, loginBody.options);
    } catch {
      setError("Could not register this device's passkey. Please try again.");
      setPending(false);
      setStep("enroll");
    }
  }

  if (step === "enroll") {
    return (
      <div className="card p-6">
        <p className="text-sm text-chakra-600">
          No passkey is registered for this staff account yet. Register one on this device to finish signing in —
          there is no password-only admin access.
        </p>
        {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
        <form onSubmit={enrollAndLogin} className="mt-4 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-sm font-medium text-chakra-900" htmlFor="staff-passkey-label">
              Device label
            </label>
            <input
              id="staff-passkey-label"
              type="text"
              placeholder="Work laptop"
              value={label}
              maxLength={60}
              onChange={(event) => setLabel(event.target.value)}
              className="field-input mt-1"
            />
          </div>
          <button className="btn-primary" type="submit" disabled={pending}>
            {pending ? "Registering…" : "Register this device's passkey"}
          </button>
        </form>
      </div>
    );
  }

  if (step === "verifying") {
    return <p className="text-sm text-chakra-500">Verifying your new passkey…</p>;
  }

  return (
    <form onSubmit={beginLogin} className="card space-y-4 p-6">
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <div>
        <label className="block text-sm font-medium text-chakra-900" htmlFor="staff-email">
          Staff email
        </label>
        <input
          id="staff-email"
          type="email"
          required
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="field-input mt-1"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-chakra-900" htmlFor="staff-password">
          Password
        </label>
        <input
          id="staff-password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="field-input mt-1"
        />
      </div>
      <button className="btn-primary w-full" type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Continue"}
      </button>
    </form>
  );
}
