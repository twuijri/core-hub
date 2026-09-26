/**
 * The microphone, for dictation through the hub (B11): what the app window may ask the OS for.
 *
 * The page may have the microphone — sound only, never the camera or the screen — and only its
 * own page on the app's loopback origin. On macOS the OS asks the person once (the words are
 * `NSMicrophoneUsageDescription`, electron-builder.config.cjs) and remembers; the app asks it
 * again only while the answer is "not decided". On Windows a microphone switched off in Privacy
 * settings is a "no" the page is told about. Linux has no such switch.
 *
 * Pure apart from the two OS calls it is handed, so it is tested without Electron.
 */

/** `systemPreferences.getMediaAccessStatus('microphone')`, or `unknown` where there is none. */
export type MicAccess = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';

/** Everything else the page may ask for: notifications and the clipboard. */
export const ALLOWED_PERMISSIONS = new Set([
  'notifications',
  'clipboard-sanitized-write',
  'clipboard-read',
]);

export interface MicHooks {
  platform: string;
  /** The OS's answer now. */
  status(): MicAccess;
  /** macOS: shows the OS question and resolves with the answer. */
  ask(): Promise<boolean>;
}

/** Whether a request is for sound alone: `media` with only `audio` among its types. */
export function isAudioOnly(mediaTypes: readonly string[] | undefined): boolean {
  return (
    Array.isArray(mediaTypes) && mediaTypes.length > 0 && mediaTypes.every((t) => t === 'audio')
  );
}

/** From the app's own page? (`origin` is the loopback origin, e.g. `http://127.0.0.1:47112`.) */
export function fromOrigin(url: string, origin: string): boolean {
  return url === origin || url.startsWith(`${origin}/`);
}

/** The answer to `session.setPermissionRequestHandler`. */
export async function answerPermission(
  request: { permission: string; url: string; mediaTypes?: readonly string[] },
  origin: string,
  hooks: MicHooks,
): Promise<boolean> {
  if (!fromOrigin(request.url, origin)) return false;
  if (ALLOWED_PERMISSIONS.has(request.permission)) return true;
  if (request.permission !== 'media' || !isAudioOnly(request.mediaTypes)) return false;
  return microphoneAllowed(hooks);
}

/** The OS lets the app have the microphone, asking the person where the OS wants that. */
export async function microphoneAllowed(hooks: MicHooks): Promise<boolean> {
  const status = hooks.status();
  if (status === 'granted') return true;
  if (status === 'denied' || status === 'restricted') return false;
  if (hooks.platform === 'darwin') {
    try {
      return await hooks.ask();
    } catch {
      return false;
    }
  }
  // Windows reports only granted or denied; Linux has no OS switch (`unknown`).
  return true;
}

/** The answer to `session.setPermissionCheckHandler`: a question, never a prompt. */
export function checkPermission(
  permission: string,
  requestingOrigin: string,
  origin: string,
  details: { mediaType?: string },
  status: MicAccess,
): boolean {
  if (requestingOrigin !== origin) return false;
  if (ALLOWED_PERMISSIONS.has(permission)) return true;
  return (
    permission === 'media' &&
    details.mediaType === 'audio' &&
    status !== 'denied' &&
    status !== 'restricted'
  );
}

/** Where the OS's own microphone switch is, for the page's "Open settings". */
export function micSettingsUrl(platform: string): string | null {
  if (platform === 'darwin')
    return 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
  if (platform === 'win32') return 'ms-settings:privacy-microphone';
  return null;
}
