import { useState } from 'react';

export type Theme = 'dark' | 'light';

const THEME_KEY = 'foreman-theme';

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#000000' : '#f5f5f2');
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // The selected theme still applies for this page when storage is unavailable.
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() =>
    typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light'
      ? 'light'
      : 'dark',
  );
  const nextTheme: Theme = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      className="theme-toggle"
      type="button"
      aria-label={`Switch to ${nextTheme} theme`}
      aria-pressed={theme === 'light'}
      title={`Switch to ${nextTheme} theme`}
      onClick={() => {
        applyTheme(nextTheme);
        setTheme(nextTheme);
      }}
    >
      {theme === 'dark' ? (
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="none">
          <circle cx="10" cy="10" r="3.5" />
          <path d="M10 1.75v2M10 16.25v2M18.25 10h-2M3.75 10h-2m14.09-5.84-1.41 1.41M5.57 14.43l-1.41 1.41m11.68 0-1.41-1.41M5.57 5.57 4.16 4.16" />
        </svg>
      ) : (
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="none">
          <path d="M16.6 12.45A7 7 0 0 1 7.55 3.4a7.1 7.1 0 1 0 9.05 9.05Z" />
        </svg>
      )}
      <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
    </button>
  );
}
