import { createHmac, randomUUID } from "node:crypto";

const KOLKATA_TIME_ZONE = "Asia/Kolkata";
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

function kolkataDateParts(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: KOLKATA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

export function previousKolkataActivityDate(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("now must be a valid Date");
  const { year, month, day } = kolkataDateParts(now);
  const previous = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) - 1));
  return previous.toISOString().slice(0, 10);
}

function requireCalendarDate(value) {
  if (!CALENDAR_DATE.test(value)) throw new Error("activityDate must use YYYY-MM-DD");
  const [year, month, day] = value.split("-").map(Number);
  const normalized = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  if (normalized !== value) throw new Error("activityDate must be a real calendar date");
  return value;
}

export async function invokeDailyAnalytics({
  baseUrl,
  secret,
  serviceKey = "analytics-scheduler",
  activityDate,
  now = new Date(),
  fetchImpl = fetch,
}) {
  if (!baseUrl) throw new Error("ANALYTICS_BASE_URL is required");
  if (!secret || secret.length < 32) throw new Error("ANALYTICS_SCHEDULER_SERVICE_SECRET must be at least 32 characters");

  const date = activityDate ? requireCalendarDate(activityDate) : previousKolkataActivityDate(now);
  const endpoint = `${baseUrl.replace(/\/$/, "")}/v1/internal/analytics/daily-runs/${date}`;
  const issuedAt = Math.floor(now.getTime() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ iss: serviceKey, sub: serviceKey, aud: "babysteps:internal:analytics:run",
    jti: randomUUID(), iat: issuedAt, exp: issuedAt + 60 });
  const unsigned = `${header}.${payload}`;
  const assertion = `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "x-babysteps-service-assertion": assertion },
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`AN-001 daily run returned status ${response.status}: ${body}`);
  return { activityDate: date, body };
}

export async function invokeAnalyticsMonitor({
  baseUrl,
  secret,
  serviceKey = "analytics-scheduler",
  now = new Date(),
  fetchImpl = fetch,
}) {
  if (!baseUrl) throw new Error("ANALYTICS_BASE_URL is required");
  if (!secret || secret.length < 32) throw new Error("ANALYTICS_SCHEDULER_SERVICE_SECRET must be at least 32 characters");

  const endpoint = `${baseUrl.replace(/\/$/, "")}/v1/internal/analytics/daily-runs/monitor`;
  const issuedAt = Math.floor(now.getTime() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ iss: serviceKey, sub: serviceKey, aud: "babysteps:internal:analytics:run",
    jti: randomUUID(), iat: issuedAt, exp: issuedAt + 60 });
  const unsigned = `${header}.${payload}`;
  const assertion = `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "x-babysteps-service-assertion": assertion },
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`AN-001 monitor returned status ${response.status}: ${body}`);
  return { body };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const monitor = process.argv[2] === "--monitor";
  (monitor ? invokeAnalyticsMonitor({
    baseUrl: process.env.ANALYTICS_BASE_URL,
    secret: process.env.ANALYTICS_SCHEDULER_SERVICE_SECRET,
  }) : invokeDailyAnalytics({
    baseUrl: process.env.ANALYTICS_BASE_URL,
    secret: process.env.ANALYTICS_SCHEDULER_SERVICE_SECRET,
    activityDate: process.argv[2] || undefined,
  }))
    .then((result) => console.log(monitor
      ? `AN-001 monitor completed: ${result.body}`
      : `AN-001 daily run completed for ${result.activityDate}: ${result.body}`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
