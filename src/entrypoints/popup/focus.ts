// SPDX-License-Identifier: GPL-3.0-only
import { useEffect } from 'preact/hooks';

/** Focus the element marked data-af (or the first enabled input) whenever deps change. */
export function useAutoFocus(deps: unknown[]) {
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('[data-af]:not([disabled])') ?? document.querySelector<HTMLElement>('input:not([disabled])');
    el?.focus();
  }, deps);
}
