"use client";

import { useState } from "react";

// Temporary simplification (2026-08-27, explicit request): password-only
// staff login, no passkey/MFA ceremony. The original WebAuthn-based flow
// (POST /v1/admin/auth/passkey/*, startAuthentication/startRegistration)
// is left in place, unused by this component — swap this form back to
// calling those routes to re-enable MFA later.
export function StaffLoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/v1/admin/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!response.ok) throw new Error("credentials");
      window.location.href = "/admin";
    } catch {
      setError("Could not sign in with those credentials.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card space-y-4 p-6">
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
