// SPDX-License-Identifier: AGPL-3.0-only
// cn() — class-name merge utility (clsx + tailwind-merge).
// Merges Tailwind classes, resolving conflicts (e.g. bg-* overrides).

import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
