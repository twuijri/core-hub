/**
 * An agent's HTML page, shown without letting it into the client (decision §47).
 *
 * It is rendered in an `<iframe sandbox="allow-scripts">` from `srcdoc`: no `allow-same-origin`,
 * so the page runs in an opaque origin of its own and cannot read the client's storage, its
 * token or its DOM. A Content-Security-Policy is put in front of it: it may run its own
 * scripts and load scripts, styles, pictures and fonts over https (a report that draws its
 * charts from a CDN still draws them), but it cannot call anything (`connect-src 'none'`),
 * send a form, open frames or plugins, or change its base URL.
 */
export const PREVIEW_SANDBOX = 'allow-scripts';

export const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'unsafe-inline' https:",
  'img-src data: blob: https:',
  'font-src data: https:',
  'media-src data: blob: https:',
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

function escapeAttribute(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * The page with the policy first. A `<meta>` before everything is placed in the document's
 * head by the parser, so it governs all that follows, whatever the page's own markup.
 */
export function withPolicy(html: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">${html}`;
}

/**
 * A page for "open in new tab": a blob page has the client's own origin, so the agent's HTML
 * is never opened as one. The tab gets a frame around it, sandboxed the same way.
 */
export function sandboxedPage(title: string, html: string): string {
  // The wrapper has no script of its own. Its policy is inherited by the `srcdoc` frame, so
  // it allows what the page may do and no more; the frame adds its own policy on top.
  const wrapperPolicy = PREVIEW_CSP.replace("default-src 'none'; ", '').replace(
    "; frame-src 'none'",
    '',
  );
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${wrapperPolicy}">`,
    `<title>${escapeAttribute(title)}</title>`,
    '<style>html,body,iframe{margin:0;border:0;inline-size:100%;block-size:100%;display:block}</style>',
    `</head><body><iframe sandbox="${PREVIEW_SANDBOX}" srcdoc="${escapeAttribute(withPolicy(html))}"></iframe></body></html>`,
  ].join('');
}
