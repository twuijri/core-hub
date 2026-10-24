/**
 * Gemini Desktop's `RobinService.ProcessQuery` frames (DECISIONS §155).
 *
 * A turn is three client frames — the initial request (extension 1000), the query text
 * (extension 1007, field 1) and the commit (extension 1007, field 2) — answered by a stream of
 * frames whose extension 1003 carries the answer as it grows. The field and extension numbers are
 * those of Gemini macOS 1.135.1.1291 as the owner's plugin sends them; what continues a
 * conversation was found on a live account on 2026-10-24 (`docs/research/gemini-desktop-2026-10.md`).
 */
import { firstString, msg, nested, num, parseWire } from './protobuf.js';

/** What a turn asks for beyond its words. */
export interface TurnSelection {
  /** The account's mode category (`requested_mode_category`, template field 47); 0 = Google picks. */
  category: number;
  /** The mode's variant (`mode_variant_id`, template field 66), when the account named one. */
  variantId: string | null;
}

/** The three ids that place a turn in a Gemini conversation. */
export interface ConversationIds {
  /** The conversation, `c_…`. */
  conversation: string;
  /** The answer, `r_…`. */
  response: string;
  /** The chosen candidate of that answer, `rc_…`. */
  choice: string;
}

/**
 * The client frames of one turn. `resume` is the turn this one follows: template field 4 carries
 * `{1: c_, 2: r_, 3: rc_}` of that turn, and the answer joins its conversation. All three are
 * needed — with only `c_` the id is kept but the history is not — and an older turn's ids branch
 * the conversation from that turn (an edit or a regenerate).
 */
export function turnFrames(
  text: string,
  selection: TurnSelection,
  resume: ConversationIds | null,
): Buffer[] {
  const metadata = Buffer.concat([
    num(4, 21), // RequestMetadata.client_type = MACOS
    num(5, 1),
    msg(6), // capabilities
    msg(7, 'en'),
    msg(2, msg(1, 'en-US')),
  ]);
  const template: Buffer[] = [];
  if (resume) {
    template.push(
      msg(
        4,
        Buffer.concat([
          msg(1, resume.conversation),
          msg(2, resume.response),
          msg(3, resume.choice),
        ]),
      ),
    );
  }
  if (selection.category > 0) {
    template.push(num(47, selection.category));
    if (selection.variantId) template.push(msg(66, selection.variantId));
  }
  const initial = Buffer.concat([
    msg(1, metadata),
    msg(1001, msg(1, Buffer.concat(template))), // ClientGenerateFeature.template
    msg(1004), // PrefetchInputFeature
  ]);
  return [msg(1000, initial), msg(1007, msg(1, text)), msg(1007, msg(2))];
}

/** What one server frame says, each part only when the frame carries it. */
export interface AnswerFrame {
  /** The answer so far: the service sends growing snapshots, not deltas. */
  text: string | null;
  conversation: string | null;
  response: string | null;
  choice: string | null;
  /** The conversation's title, as the Gemini app shows it. */
  title: string | null;
  /** "Used 3.5 Flash-Lite model". */
  modelNote: string | null;
}

/** Reads one server frame. Throws when the frame is not protobuf at all. */
export function readAnswerFrame(frame: Buffer): AnswerFrame {
  parseWire(frame);
  const nonEmpty = (value: string | null) => (value ? value : null);
  return {
    text: firstString(frame, 1003, 1, 1, 2, 1),
    conversation:
      nonEmpty(firstString(frame, 1003, 1, 2, 1)) ?? nonEmpty(firstString(frame, 1014, 1, 1)),
    response: nonEmpty(firstString(frame, 1003, 1, 2, 2)),
    choice: nonEmpty(firstString(frame, 1003, 1, 1, 1)),
    title: nonEmpty(firstString(frame, 1003, 1, 4, 1)),
    modelNote: nonEmpty(firstString(frame, 1003, 1, 30)),
  };
}

/** Whether a frame has any answer part at all (extension 1003). */
export function isAnswerFrame(frame: Buffer): boolean {
  return nested(frame, 1003).length > 0;
}
