"use client";

import { useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";

// AD-005 rules 39-46, 50, 59-60: a narrow, pre-MFA, single-use enrollment
// ceremony — never itself an admin session or a role/status change. Both
// the normal (admin-issued) and sole-Platform-Administrator break-glass
// paths converge on the exact same registration-options/register ceremony
// StaffLoginForm's first-time-enrollment step already uses, once each has
// obtained its own pendingToken.
type Mode = "normal" | "break_glass";
type Step = "credentials" | "enroll" | "done";

export function StaffRecoveryEnrollmentForm() {
  const [mode, setMode] = useState<Mode>("normal");
  const [step, setStep] = useState<Step>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [label, setLabel] = useState("");
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function requestEnrollment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const url = mode === "normal" ? "/v1/admin/platform/recovery/consume" : "/v1/admin/platform/recovery/break-glass";
      const body = mode === "normal" ? { email, password } : { email, password, recoveryCode: recoveryCode.trim() };
      const response = await fetch(url, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload.error === "RECOVERY_SESSION_NOT_FOUND"
          ? "No pending recovery session found for this account. Ask a different Platform Administrator to start one."
          : "Could not start recovery with those details.");
        setPending(false);
        return;
      }
      const payload = await response.json();
      setPendingToken(payload.pendingToken);
      setStep("enroll");
      setPending(false);
    } catch {
      setError("Could not start recovery. Please try again.");
      setPending(false);
    }
  }

  async function registerPasskey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pendingToken) return;
    setPending(true);
    setError(null);
    try {
      const optionsResponse = await fetch("/v1/admin/auth/passkey/registration-options", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pendingToken }),
      });
      if (!optionsResponse.ok) throw new Error("options");
      const { challengeId, options } = await optionsResponse.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const attestation = await startRegistration({ optionsJSON: options as any });
      const registerResponse = await fetch("/v1/admin/auth/passkey/register", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pendingToken, challengeId, response: attestation, label: label.trim() || "Recovered device" }),
      });
      if (!registerResponse.ok) throw new Error("register");
      setStep("done");
      setPending(false);
    } catch {
      setError("Could not register a new passkey. Please try again.");
      setPending(false);
    }
  }

  if (step === "done") {
    return (
      <div className="card p-6">
        <p className="text-sm text-chakra-700">
          A new passkey is registered on this device. Sign in normally with your password and this passkey to
          complete two-factor login.
        </p>
        <a href="/admin" className="btn-primary mt-4 inline-flex min-h-[44px] items-center px-4">Go to sign in</a>
      </div>
    );
  }

  if (step === "enroll") {
    return (
      <form onSubmit={registerPasskey} className="card space-y-4 p-6">
        <p className="text-sm text-chakra-600">
          Register exactly one new passkey on this device to finish recovery. This does not sign you in by itself —
          you will still need to complete a normal password + passkey login afterward.
        </p>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div>
          <label className="field-label" htmlFor="recovery-passkey-label">Device label</label>
          <input id="recovery-passkey-label" type="text" placeholder="Work laptop" maxLength={60}
            value={label} onChange={(e) => setLabel(e.target.value)} className="field-input" />
        </div>
        <button type="submit" disabled={pending} className="btn-primary w-full min-h-[44px]">
          {pending ? "Registering…" : "Register this device's passkey"}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={requestEnrollment} className="card space-y-4 p-6">
      <div className="flex gap-2 text-sm">
        <button type="button" onClick={() => setMode("normal")}
          className={mode === "normal" ? "btn-primary min-h-[44px] px-3" : "btn-secondary min-h-[44px] px-3"}>
          A different administrator started my recovery
        </button>
        <button type="button" onClick={() => setMode("break_glass")}
          className={mode === "break_glass" ? "btn-primary min-h-[44px] px-3" : "btn-secondary min-h-[44px] px-3"}>
          I'm the sole Platform Administrator with a recovery code
        </button>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <div>
        <label className="field-label" htmlFor="recovery-email">Staff email</label>
        <input id="recovery-email" type="email" required autoComplete="username" value={email}
          onChange={(e) => setEmail(e.target.value)} className="field-input" />
      </div>
      <div>
        <label className="field-label" htmlFor="recovery-password">Password</label>
        <input id="recovery-password" type="password" required autoComplete="current-password" value={password}
          onChange={(e) => setPassword(e.target.value)} className="field-input" />
      </div>
      {mode === "break_glass" && (
        <div>
          <label className="field-label" htmlFor="recovery-code">Recovery code</label>
          <input id="recovery-code" type="text" required value={recoveryCode}
            onChange={(e) => setRecoveryCode(e.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX" className="field-input" />
          <p className="mt-1 text-xs text-chakra-500">
            One of the one-time codes generated at first boot or the last rotation. Only usable when no other
            active Platform Administrator exists.
          </p>
        </div>
      )}
      <button type="submit" disabled={pending} className="btn-primary w-full min-h-[44px]">
        {pending ? "Checking…" : "Continue"}
      </button>
    </form>
  );
}
