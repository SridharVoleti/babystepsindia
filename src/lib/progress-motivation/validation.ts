import { MOTIVATION_DISPLAY_TYPES, type MotivationProgress, type ProgressSummary } from "./contracts";

export class ProgressMotivationValidationError extends Error {
  constructor(public readonly code: "PROGRESS_MOTIVATION_INVALID" | "PROGRESS_SUMMARY_TOO_LARGE") {
    super(code); this.name = "ProgressMotivationValidationError";
  }
}

const UNSAFE_TEXT = /<[^>]*>|https?:\/\/|www\.|javascript:|data:/i;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function safeText(value: unknown, maximum: number, required = false) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new ProgressMotivationValidationError("PROGRESS_MOTIVATION_INVALID");
  if ((required && value.length === 0) || value.length > maximum ||
      CONTROL_CHARACTERS.test(value) || UNSAFE_TEXT.test(value)) {
    throw new ProgressMotivationValidationError("PROGRESS_MOTIVATION_INVALID");
  }
  // API-EG-016 requires the app-owned representation to survive exactly;
  // validation must never trim, normalize, translate, or recalculate it.
  return value;
}

export function validateMotivationProgress(value: unknown): MotivationProgress {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new ProgressMotivationValidationError("PROGRESS_MOTIVATION_INVALID");
  }
  const object = value as Record<string, unknown>;
  if (!MOTIVATION_DISPLAY_TYPES.includes(object.displayType as never)) {
    throw new ProgressMotivationValidationError("PROGRESS_MOTIVATION_INVALID");
  }
  const message = safeText(object.motivationalMessage, 160);
  if (object.displayType === "steps") {
    const allowed = ["displayType", "currentStepKey", "currentStepLabel", "nextStepLabel", "stepPosition",
      "stepCount", "motivationalMessage"];
    if (Object.keys(object).some((key) => !allowed.includes(key)) || !Number.isInteger(object.stepPosition) ||
        !Number.isInteger(object.stepCount) || (object.stepPosition as number) < 1 || (object.stepCount as number) < 1 ||
        (object.stepPosition as number) > (object.stepCount as number)) {
      throw new ProgressMotivationValidationError("PROGRESS_MOTIVATION_INVALID");
    }
    const currentStepKey = safeText(object.currentStepKey, 80, object.currentStepKey !== undefined);
    const currentStepLabel = safeText(object.currentStepLabel, 100, object.currentStepLabel !== undefined);
    const nextStepLabel = safeText(object.nextStepLabel, 120, object.nextStepLabel !== undefined);
    return { displayType: "steps", stepPosition: object.stepPosition as number, stepCount: object.stepCount as number,
      ...(currentStepKey !== undefined ? { currentStepKey } : {}),
      ...(currentStepLabel !== undefined ? { currentStepLabel } : {}),
      ...(nextStepLabel !== undefined ? { nextStepLabel } : {}), ...(message !== undefined ? { motivationalMessage: message } : {}) };
  }
  if (object.displayType === "percentage") {
    const allowed = ["displayType", "percentageValue", "motivationalMessage"];
    if (Object.keys(object).some((key) => !allowed.includes(key)) || typeof object.percentageValue !== "number" ||
        !Number.isFinite(object.percentageValue) || object.percentageValue < 0 || object.percentageValue > 100) {
      throw new ProgressMotivationValidationError("PROGRESS_MOTIVATION_INVALID");
    }
    return { displayType: "percentage", percentageValue: object.percentageValue,
      ...(message !== undefined ? { motivationalMessage: message } : {}) };
  }
  if (object.displayType === "label") {
    const allowed = ["displayType", "progressLabel", "motivationalMessage"];
    if (Object.keys(object).some((key) => !allowed.includes(key))) {
      throw new ProgressMotivationValidationError("PROGRESS_MOTIVATION_INVALID");
    }
    const progressLabel = safeText(object.progressLabel, 140, true)!;
    return { displayType: "label", progressLabel, ...(message !== undefined ? { motivationalMessage: message } : {}) };
  }
  if (Object.keys(object).some((key) => !["displayType", "motivationalMessage"].includes(key))) {
    throw new ProgressMotivationValidationError("PROGRESS_MOTIVATION_INVALID");
  }
  return { displayType: "none", ...(message !== undefined ? { motivationalMessage: message } : {}) };
}

export function validateProgressSummaryWithMotivation(core: Omit<ProgressSummary, "motivationProgress">,
  motivationProgress: unknown): ProgressSummary {
  const motivation = motivationProgress === undefined ? undefined : validateMotivationProgress(motivationProgress);
  const result = { ...core, ...(motivation ? { motivationProgress: motivation } : {}) };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 4096) {
    throw new ProgressMotivationValidationError("PROGRESS_SUMMARY_TOO_LARGE");
  }
  return result;
}
