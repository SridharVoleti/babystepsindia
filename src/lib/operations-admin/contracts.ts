export class OperationChangeError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "OperationChangeError"; }
}

// Rule 20: the bounded V1 set — a later new type requires a frozen
// requirement/policy amendment, never an ad-hoc addition.
export const OPERATION_CHANGE_TYPES = [
  "app_registry_change", "release_promotion", "manual_rollback", "planned_maintenance",
  "emergency_availability_change", "machine_principal_change", "machine_credential_change",
] as const;
export type OperationChangeType = (typeof OPERATION_CHANGE_TYPES)[number];

export const OPERATION_CHANGE_STATUSES = [
  "planned", "ready", "executing", "succeeded", "failed", "cancelled",
] as const;
export type OperationChangeStatus = (typeof OPERATION_CHANGE_STATUSES)[number];

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_REASON: 400, INVALID_REQUEST: 400,
  OPERATION_CHANGE_NOT_FOUND: 404, ASSIGNEE_NOT_FOUND: 404,
  VERSION_CONFLICT: 409, OPERATION_CHANGE_TERMINAL: 409, INVALID_TRANSITION: 409,
  OPERATION_SCOPE_MISMATCH: 409, OPERATION_CHANGE_TYPE_MISMATCH: 409,
};
export function operationChangeErrorStatus(code: string): number {
  return STATUS_BY_CODE[code] ?? 422;
}

export function isValidOperationReason(reason: string): boolean {
  const trimmed = reason.trim();
  return trimmed.length >= 20 && trimmed.length <= 500;
}

export type CreateOperationChangeInput = {
  changeType: OperationChangeType;
  environment: string;
  appId?: string;
  primaryResourceType?: string;
  primaryResourceId?: string;
  reason: string;
  scheduledFor?: string;
  linkedSupportCaseId?: string;
  idempotencyKey: string;
};

export type OperationChangeSummary = {
  operationChangeId: string;
  changeType: OperationChangeType;
  status: OperationChangeStatus;
  environment: string;
  appId: string | null;
  reason: string;
  assignedStaffAccountId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type OperationChangeListFilters = {
  status?: OperationChangeStatus;
  changeType?: OperationChangeType;
  appId?: string;
  environment?: string;
  assignedToMe?: boolean;
  cursor?: string;
  limit?: number;
};

export type UpdateOperationChangeWorkflowInput = {
  expectedVersion: number;
  idempotencyKey: string;
  status?: OperationChangeStatus;
  assignedStaffAccountId?: string | null;
  scheduledFor?: string | null;
};
