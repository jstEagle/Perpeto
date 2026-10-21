/*
 * Appearance: System, Light or Dark. The tokens switch on data-theme on the
 * root element; System removes the attribute so prefers-color-scheme decides.
 * index.html applies the saved choice before first paint with the same key.
 */
import { useEffect, useState } from 'react';

export type Appearance = 'system' | 'light' | 'dark';

export const APPEARANCE_KEY = 'perpeto.appearance';

export function readAppearance(): Appearance {
  try {
    const v = localStorage.getItem(APPEARANCE_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Keeps the browser chrome (theme-color) on the current canvas. */
function syncThemeColor() {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) return;
  const canvas = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim();
  if (canvas) meta.content = canvas;
}

export function applyAppearance(value: Appearance) {
  const root = document.documentElement;
  if (value === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', value);
  syncThemeColor();
}

export function saveAppearance(value: Appearance) {
  try {
    localStorage.setItem(APPEARANCE_KEY, value);
  } catch {
    // Storage can be unavailable (private mode); the choice still applies to this page.
  }
  applyAppearance(value);
}

/** Applies the saved choice and follows system changes for theme-color. Call once at startup. */
export function initAppearance() {
  applyAppearance(readAppearance());
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', syncThemeColor);
  window.addEventListener('storage', (e) => {
    if (e.key === APPEARANCE_KEY) applyAppearance(readAppearance());
  });
}

export function useAppearance(): [Appearance, (value: Appearance) => void] {
  const [value, setValue] = useState<Appearance>(readAppearance);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === APPEARANCE_KEY) setValue(readAppearance());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  return [
    value,
    (next) => {
      setValue(next);
      saveAppearance(next);
    },
  ];
}
