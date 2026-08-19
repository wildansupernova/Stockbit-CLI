export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, exitCode = 1, options?: ErrorOptions) {
    super(message, options);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
  }
}
