/**
 * Opening a conversation at one message: the Search page's way in (owner, 2026-09-23).
 *
 * «في البحث اذا بحثت عن كلمه وجابلي باي محادثه وضغطت عليها يوديني للكلمه داخل المحادثه»
 * — a long conversation is no use as a search result if it opens at the bottom. The hub
 * already says which message matched (`Session.match.message_id`); the result links to
 * `/chat/<id>?m=<message id>&q=<what was searched>`, and the chat scrolls that message to
 * the middle of the screen, flashes it once, and marks the words inside it.
 *
 * The two parameters are read once and then taken out of the address (`replace`): the jump
 * is something that happened, not what the conversation is. A reload opens at the bottom
 * as it always has; Back still returns to the search.
 */
import { routeOf } from '../navigation/manifest.js';
import { highlightParts, matchRanges } from '../ui/combobox-filter.js';

/** The query parameters of an anchored open. */
export const ANCHOR_PARAM = 'm';
export const QUERY_PARAM = 'q';

/** A ULID as the contract writes it; anything else in `?m=` is ignored. */
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export interface Anchor {
  messageId: string;
  /** What was searched, to mark inside the message; empty marks nothing. */
  query: string;
}

/** The chat's address for a session, opened at `messageId` when there is one. */
export function chatHref(sessionId: string, messageId?: string | null, query?: string): string {
  const base = routeOf('chat').replace(':sessionId?', sessionId);
  if (!messageId) return base;
  const params = new URLSearchParams({ [ANCHOR_PARAM]: messageId });
  const q = query?.trim();
  if (q) params.set(QUERY_PARAM, q);
  return `${base}?${params.toString()}`;
}

export function readAnchor(params: URLSearchParams): Anchor | null {
  const messageId = params.get(ANCHOR_PARAM);
  if (!messageId || !ULID.test(messageId)) return null;
  return { messageId, query: (params.get(QUERY_PARAM) ?? '').trim() };
}

// ------------------------------------------------------------------ paging back

export interface MessagePageLike<M> {
  items: M[];
  has_more: boolean;
}

/** One page of older messages is at most this many (the contract's `limit` maximum). */
export const OLDER_PAGE = 200;
/** How far back an anchored open will go: 25 pages of 200, past any real conversation. */
export const MAX_OLDER_PAGES = 25;

/**
 * The chat opens with the newest page only (`sessions.listMessages`). A search can point
 * further back than that, so an anchored open keeps asking for the page before the oldest
 * one it holds (`before` = that message's id) until the anchor is there, nothing older
 * exists, or `MAX_OLDER_PAGES` is spent. Messages come back oldest first, as the contract
 * returns them.
 */
export async function pageBackUntil<M extends { id: string }>(
  first: MessagePageLike<M>,
  anchorId: string,
  older: (before: string) => Promise<MessagePageLike<M>>,
): Promise<M[]> {
  let items = first.items;
  let hasMore = first.has_more;
  for (let pages = 0; pages < MAX_OLDER_PAGES; pages += 1) {
    if (!hasMore || items.some((m) => m.id === anchorId)) break;
    const oldest = items[0];
    if (!oldest) break;
    const page = await older(oldest.id);
    if (page.items.length === 0) break;
    items = [...page.items, ...items];
    hasMore = page.has_more;
  }
  return items;
}

// ------------------------------------------------------------------ marking the words

/** A minimal HAST node: only what the marker reads and writes. */
interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** The class every marked occurrence wears, in plain text and in Markdown alike. */
export const HIT_CLASS = 'msg-hit';

/**
 * A rehype plugin that wraps each occurrence of `query` in `<mark class="msg-hit">`.
 *
 * It runs after Markdown has become HTML (and after code highlighting), and it only ever
 * splits text nodes: the structure of lists, tables, links and code blocks is untouched,
 * and a code block's copy button still copies the text (it reads the text, not the tags).
 * An occurrence split by formatting (`**زع**فران`) is not marked; the message still is.
 */
export function rehypeMarkQuery(options: { query: string }) {
  const query = options.query;
  const walk = (node: HastNode) => {
    if (!node.children) return;
    const next: HastNode[] = [];
    for (const child of node.children) {
      if (child.type === 'text' && child.value) {
        const ranges = matchRanges(child.value, query);
        if (ranges.length === 0) {
          next.push(child);
          continue;
        }
        for (const part of highlightParts(child.value, ranges)) {
          next.push(
            part.hit
              ? {
                  type: 'element',
                  tagName: 'mark',
                  properties: { className: [HIT_CLASS] },
                  children: [{ type: 'text', value: part.text }],
                }
              : { type: 'text', value: part.text },
          );
        }
      } else {
        walk(child);
        next.push(child);
      }
    }
    node.children = next;
  };
  return (tree: HastNode) => {
    if (query.trim() !== '') walk(tree);
  };
}
