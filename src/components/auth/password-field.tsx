"use client";

import { useState } from "react";

export function PasswordField({
  id,
  name,
  label,
  autoComplete,
  helpText,
  rightLabel,
  minLength,
}: {
  id: string;
  name: string;
  label: string;
  autoComplete: string;
  helpText?: string;
  rightLabel?: React.ReactNode;
  // Only set this for fields that create/replace a password (signup,
  // reset). The login field must accept whatever password was actually
  // set — e.g. the seeded admin password is 11 characters — so it leaves
  // this unset and relies on the server to reject wrong passwords.
  minLength?: number;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div>
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="field-label">
          {label}
        </label>
        {rightLabel}
      </div>
      <div className="relative">
        <input
          id={id}
          name={name}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          minLength={minLength}
          required
          className="field-input pr-24"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute inset-y-0 right-0 px-3 text-xs font-medium text-chakra-500 hover:text-chakra-700"
        >
          {visible ? "Hide password" : "Show password"}
        </button>
      </div>
      {helpText && <p className="mt-1.5 text-xs text-chakra-400">{helpText}</p>}
    </div>
  );
}
