export class AnalyticsError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AnalyticsError";
  }
}
