"use client";

import { useEffect, useState } from "react";

// Server and browser disagree on timezone/locale, so formatting a Date during
// server rendering and again in the browser produced a text mismatch (React
// hydration error #425). Render a deterministic UTC string first -- identical on
// both sides -- then switch to the viewer's local format once mounted.
const utc = (iso: string) =>
  new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(iso)) + " UTC";

export function LocalDateTime({ value }: { value: string | number | Date }) {
  const iso = new Date(value).toISOString();
  const [text, setText] = useState(() => utc(iso));
  useEffect(() => { setText(new Date(iso).toLocaleString()); }, [iso]);
  return <time dateTime={iso}>{text}</time>;
}
