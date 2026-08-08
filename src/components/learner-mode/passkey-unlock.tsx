"use client";

import { useEffect, useState } from "react";
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";

type Passkey = { id: string; label: string; status: string };

// IA-004: the only way into learner mode is a real WebAuthn ceremony — there
// is deliberately no password/PIN fallback for a locked learner profile.
export function PasskeyUnlock({ learnerId, learnerName, onUnlocked }: {
  learnerId: string; learnerName: string; onUnlocked: () => void;
}) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setSupported(browserSupportsWebAuthn());
    fetch(`/v1/learners/${learnerId}/passkeys`, { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : { passkeys: [] }))
      .then((data) => setPasskeys(data.passkeys ?? []))
      .catch(() => setPasskeys([]));
  }, [learnerId]);

  async function register(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true); setError(null);
    try {
      const optionsResponse = await fetch(`/v1/learners/${learnerId}/passkeys/registration-options`, {
        method: "POST", credentials: "same-origin",
      });
      if (!optionsResponse.ok) throw new Error("options");
      const { challengeId, options } = await optionsResponse.json();
      const attestation = await startRegistration({ optionsJSON: options });
      const verifyResponse = await fetch(`/v1/learners/${learnerId}/passkeys/registration-verify`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, response: attestation, label: label.trim() || "This device" }),
      });
      if (!verifyResponse.ok) throw new Error("verify");
      setLabel("");
      const listResponse = await fetch(`/v1/learners/${learnerId}/passkeys`, { credentials: "same-origin" });
      setPasskeys((await listResponse.json()).passkeys ?? []);
    } catch {
      setError("Could not register this device's passkey. Please try again.");
    } finally {
      setPending(false);
    }
  }

  async function unlock() {
    setPending(true); setError(null);
    try {
      const optionsResponse = await fetch("/v1/learner-mode/enter/options", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ learnerId }),
      });
      if (!optionsResponse.ok) throw new Error("options");
      const { challengeId, options } = await optionsResponse.json();
      const assertion = await startAuthentication({ optionsJSON: options });
      const verifyResponse = await fetch("/v1/learner-mode/enter/verify", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ learnerId, challengeId, response: assertion }),
      });
      if (!verifyResponse.ok) throw new Error("verify");
      onUnlocked();
    } catch {
      setError("Could not verify this device's passkey. Please try again.");
    } finally {
      setPending(false);
    }
  }

  if (supported === false) {
    return (
      <div className="mt-4 rounded-xl border border-chakra-100 bg-white p-5">
        <p className="text-sm text-red-700" role="alert">
          This browser doesn&apos;t support passkeys. Learner mode for {learnerName} needs a passkey-capable
          browser or device — there is no password fallback.
        </p>
      </div>
    );
  }

  if (passkeys === null || supported === null) return null;

  const active = passkeys.filter((passkey) => passkey.status === "active");

  return (
    <div className="mt-4 rounded-xl border border-chakra-100 bg-white p-5">
      {error && <p role="alert" className="mb-3 text-sm text-red-700">{error}</p>}
      {active.length > 0 ? (
        <>
          <p className="text-sm text-chakra-500">Unlock {learnerName}&apos;s profile with a registered passkey.</p>
          <button className="btn-primary mt-3" type="button" disabled={pending} onClick={unlock}>
            {pending ? "Verifying…" : `Unlock ${learnerName}`}
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-chakra-500">
            {learnerName} needs a passkey registered on this device before learner mode can be entered.
          </p>
          <form onSubmit={register} className="mt-3 flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-sm font-medium text-chakra-900" htmlFor="passkey-label">
                Device label
              </label>
              <input id="passkey-label" type="text" placeholder="Family iPad" value={label} maxLength={60}
                onChange={(event) => setLabel(event.target.value)}
                className="mt-1 rounded-lg border border-chakra-200 px-3 py-2" />
            </div>
            <button className="btn-primary" type="submit" disabled={pending}>
              {pending ? "Registering…" : "Register this device's passkey"}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
