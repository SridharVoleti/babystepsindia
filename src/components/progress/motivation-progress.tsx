import type { MotivationProgress } from "@/lib/progress-motivation/contracts";

export function MotivationProgressView({ progress, className = "" }: {
  progress: MotivationProgress | undefined;
  className?: string;
}) {
  if (!progress) return null;
  const message = progress.motivationalMessage
    ? <p className="mt-1 text-sm text-chakra-600">{progress.motivationalMessage}</p> : null;
  if (progress.displayType === "none") return message ? <div className={className}>{message}</div> : null;
  if (progress.displayType === "steps") return <div className={className}
    aria-label={`App progress: step ${progress.stepPosition} of ${progress.stepCount}`}>
    <p className="font-medium text-chakra-900">Step {progress.stepPosition} of {progress.stepCount}</p>
    {progress.currentStepLabel && <p className="mt-1 text-sm text-chakra-600">{progress.currentStepLabel}</p>}
    {progress.nextStepLabel && <p className="mt-1 text-sm text-chakra-500">Next: {progress.nextStepLabel}</p>}
    {message}
  </div>;
  if (progress.displayType === "percentage") return <div className={className}
    aria-label={`App progress: ${progress.percentageValue} percent`}>
    <p className="font-medium text-chakra-900">{progress.percentageValue}%</p>
    <progress className="mt-2 block h-2 w-full" max={100} value={progress.percentageValue}>
      {progress.percentageValue}%
    </progress>
    {message}
  </div>;
  return <div className={className} aria-label={`App progress: ${progress.progressLabel}`}>
    <p className="font-medium text-chakra-900">{progress.progressLabel}</p>
    {message}
  </div>;
}
