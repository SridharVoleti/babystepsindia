export function previousKolkataActivityDate(now?: Date): string;

export function invokeDailyAnalytics(options: {
  baseUrl: string;
  secret: string;
  serviceKey?: string;
  activityDate?: string;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<{ activityDate: string; body: string }>;
