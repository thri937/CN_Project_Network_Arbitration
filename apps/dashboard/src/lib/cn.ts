import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Class-name composition.
 *
 * `clsx` handles conditionals; `twMerge` resolves Tailwind conflicts so a caller-supplied
 * `className` genuinely overrides a component's default rather than depending on CSS source
 * order. Without it, `<Card className="p-2">` against a default of `p-4` produces both
 * classes and whichever Tailwind emitted last wins — which is not what the caller meant.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
