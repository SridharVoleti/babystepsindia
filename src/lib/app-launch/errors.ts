export class AppLaunchError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AppLaunchError";
  }
}
