// The sidebar's version (owner, 2026-10-27): this app's own number, and on hover or focus each
// version on its own line — gone the moment the pointer or focus leaves.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../src/i18n/context.js';
import { VersionLabel, versionFacts } from '../src/shell/VersionLabel.js';

afterEach(() => {
  cleanup();
  delete (globalThis as { corehubDesktop?: unknown }).corehubDesktop;
});

const mount = () =>
  render(
    <I18nProvider language="en">
      <VersionLabel hubVersion="1.1.6-preview.46" />
    </I18nProvider>,
  );

const desktopApp = (appVersion: string) => {
  (globalThis as { corehubDesktop?: unknown }).corehubDesktop = {
    surface: 'desktop',
    getState: async () => ({ appVersion }),
  };
};

describe('what the version says', () => {
  it('in a browser: the hub, which served the page', () => {
    expect(versionFacts(null, '1.1.8')).toEqual({
      shown: '1.1.8',
      lines: [{ key: 'hub', version: '1.1.8' }],
    });
  });

  it('in the desktop app: the app itself, then the hub', () => {
    expect(versionFacts('1.1.10', '1.1.6-preview.46')).toEqual({
      shown: '1.1.10',
      lines: [
        { key: 'desktop', version: '1.1.10' },
        { key: 'hub', version: '1.1.6-preview.46' },
      ],
    });
  });
});

describe('the version label', () => {
  it('shows the lines on hover and hides them as soon as the pointer leaves', () => {
    mount();
    const label = screen.getByTestId('app-version');
    expect(label.textContent).toBe('v1.1.6-preview.46');
    expect(screen.queryByTestId('version-popover')).toBeNull();
    fireEvent.mouseEnter(label);
    const popover = screen.getByTestId('version-popover');
    expect(popover.getAttribute('role')).toBe('tooltip');
    expect(popover.textContent).toContain('Hub: ');
    expect(popover.textContent).toContain('1.1.6-preview.46');
    expect(popover.textContent).not.toContain('Desktop app');
    expect(label.getAttribute('aria-describedby')).toBe(popover.id);
    fireEvent.mouseLeave(label);
    expect(screen.queryByTestId('version-popover')).toBeNull();
  });

  it('opens on keyboard focus and closes on blur or Escape', () => {
    mount();
    const label = screen.getByTestId('app-version');
    fireEvent.focus(label);
    expect(screen.getByTestId('version-popover')).toBeTruthy();
    fireEvent.keyDown(label, { key: 'Escape' });
    expect(screen.queryByTestId('version-popover')).toBeNull();
    fireEvent.focus(label);
    fireEvent.blur(label);
    expect(screen.queryByTestId('version-popover')).toBeNull();
  });

  it('in the desktop app shows its own version, and both lines on hover', async () => {
    desktopApp('1.1.10');
    mount();
    const label = screen.getByTestId('app-version');
    await screen.findByText('v1.1.10');
    fireEvent.mouseEnter(label);
    const lines = [...screen.getByTestId('version-popover').children].map(
      (line) => line.textContent,
    );
    expect(lines).toEqual(['Desktop app: ⁨1.1.10⁩', 'Hub: ⁨1.1.6-preview.46⁩']);
  });
});
