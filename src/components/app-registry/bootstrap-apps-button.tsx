"use client";

import { useState } from "react";

export function BootstrapAppsButton() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleClick() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/v1/admin/apps/bootstrap", { method: "POST" });
      if (!response.ok) {
        setMessage("Bootstrap failed.");
        return;
      }
      window.location.reload();
    } catch {
      setMessage("Bootstrap failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button type="button" onClick={handleClick} disabled={busy} className="btn-secondary">
        {busy ? "Registering…" : "Bootstrap initial apps"}
      </button>
      {message && <span className="text-sm text-saffron-700">{message}</span>}
    </div>
  );
}
