import { classifyApplicationHealth, type ApplicationHealthCapability, type ApplicationHealthSignal, type ClassifiedApplicationHealth } from "./contracts";

export interface ApplicationHealthAlertRepository {
  upsertOpenAlert(input: ClassifiedApplicationHealth): Promise<{ id: string; created: boolean }>;
  closeOpenAlert(dedupeKey: string, recoveredAt?: string): Promise<void>;
}

export class ApplicationHealthService {
  constructor(public readonly repo: ApplicationHealthAlertRepository) {}

  async observe(signal: ApplicationHealthSignal): Promise<{ alerted: boolean; alertId?: string; severity: ClassifiedApplicationHealth["severity"] }> {
    const classified = classifyApplicationHealth(signal);
    if (!classified.shouldAlert) return { alerted: false, severity: classified.severity };
    const result = await this.repo.upsertOpenAlert(classified);
    return { alerted: true, alertId: result.id, severity: classified.severity };
  }

  async recover(capability: ApplicationHealthCapability, issueKey: string, recoveredAt: string): Promise<void> {
    await this.repo.closeOpenAlert(`${capability}:${issueKey}`, recoveredAt);
  }
}
