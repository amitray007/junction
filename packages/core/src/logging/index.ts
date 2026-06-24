// SPDX-License-Identifier: AGPL-3.0-only
// Logger seam — pino wired at its increment; never log secrets.

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void
  info(msg: string, meta?: Record<string, unknown>): void
  warn(msg: string, meta?: Record<string, unknown>): void
  error(msg: string, meta?: Record<string, unknown>): void
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

let _logger: Logger = noopLogger

export function getLogger(): Logger {
  return _logger
}

export function setLogger(logger: Logger): void {
  _logger = logger
}
