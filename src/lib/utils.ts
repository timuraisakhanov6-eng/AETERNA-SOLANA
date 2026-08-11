import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * AETERNA — canonical className merge helper
 *
 * Combines:
 * - conditional class logic (clsx)
 * - Tailwind conflict resolution (tailwind-merge)
 *
 * Safe for:
 * React
 * SSR
 * Vite
 * Next.js
 */

export function cn(
  ...inputs: ClassValue[]
): string {

  return twMerge(
    clsx(...inputs)
  );

}