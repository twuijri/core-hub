// @ts-check
// The download page's switches: the one file to edit when a store listing goes live.
//
// A store button is a link only when its `enabled` is true AND its `url` is an https:// address;
// otherwise the page shows it as "Coming soon" (storeLink in releases.js). Turning one on is a
// one-line pull request here; .github/workflows/pages.yml republishes the page on merge.

/**
 * @typedef {{ enabled: boolean, url: string }} StoreFlag
 * @typedef {{ microsoftStore: StoreFlag, googlePlay: StoreFlag, appStore: StoreFlag }} StoreFlags
 */

/** The GitHub repository whose latest release the page offers. */
export const REPO = 'twuijri/core-hub';

/** @type {StoreFlags} */
export const STORES = {
  // Partner Center product 9MT62R5V3P5N (docs/RELEASING.md §Windows). Waiting for certification.
  microsoftStore: { enabled: false, url: 'https://apps.microsoft.com/detail/9MT62R5V3P5N' },
  // Google Play comes after the APK (docs/RELEASING.md, "Where each platform ships").
  googlePlay: {
    enabled: false,
    url: 'https://play.google.com/store/apps/details?id=com.twuijri.corehub',
  },
  // Placeholder: App Store Connect gives the link (https://apps.apple.com/app/id<number>) once the
  // app is approved. Fill `url` and set `enabled` together.
  appStore: { enabled: false, url: '' },
};
