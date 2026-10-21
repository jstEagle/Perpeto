import { beforeEach, describe, expect, it } from 'vitest';
import { APPEARANCE_KEY, readAppearance, saveAppearance } from './appearance';

describe('appearance', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('defaults to system with no data-theme', () => {
    expect(readAppearance()).toBe('system');
  });

  it('persists light and dark and sets data-theme', () => {
    saveAppearance('dark');
    expect(localStorage.getItem(APPEARANCE_KEY)).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    saveAppearance('light');
    expect(readAppearance()).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('system removes data-theme so the device decides', () => {
    saveAppearance('dark');
    saveAppearance('system');
    expect(readAppearance()).toBe('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('ignores unknown stored values', () => {
    localStorage.setItem(APPEARANCE_KEY, 'sepia');
    expect(readAppearance()).toBe('system');
  });
});
