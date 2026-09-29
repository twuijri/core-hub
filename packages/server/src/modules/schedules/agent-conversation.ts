/**
 * An agent step's conversation (DECISIONS §136): a new one for every run (the default, as it
 * always was), or one existing conversation that every run of the step talks in.
 *
 * This file only reads the step's field; the conversation itself belongs to `sessions`, which
 * the composition root lends the engine (`WorkflowPorts.conversations`). The rules a run
 * applies — the conversation is in the run's profile, open to the person the run acts as, and
 * has the step's agent — live there too, so "Test conversation" and the run give one answer.
 */
import { ULID_PATTERN } from '../../db/ids.js';
import { pathsIn } from './expr.js';
import type { WorkflowNode } from './schema.js';

/** The modes a step may say; any other is refused when the workflow is saved. */
export const CONVERSATION_MODES = ['new', 'reuse'] as const;

/** What an agent step with `mode: reuse` asks for, before its templates are rendered. */
export interface ReuseConversation {
  /** The conversation's id, or a template that renders to one. */
  sessionId: string;
  createIfMissing: boolean;
  /** The title of a conversation made for the step (a template); empty: the step's title. */
  title: string;
}

/** The step's reused conversation; `null` when it opens a new one every run. */
export function reuseOf(node: WorkflowNode): ReuseConversation | null {
  if (node.kind !== 'agent') return null;
  const conversation = node.conversation;
  if (!conversation || conversation.mode !== 'reuse') return null;
  return {
    sessionId: (conversation.session_id ?? '').trim(),
    createIfMissing: conversation.create_if_missing === true,
    title: (conversation.title ?? '').trim(),
  };
}

/** Whether an id, as written in the step, is filled in when the step runs. */
export function isTemplate(value: string): boolean {
  return pathsIn(value).length > 0;
}

/**
 * Invisible marks a pasted id may carry (copied from right-to-left text) and the spaces
 * around it, cut out — an id is letters and digits only.
 */
export function cleanConversationId(value: string): string {
  return value.replace(/[\s‎‏‪-‮⁦-⁩﻿]/g, '');
}

/** Whether a rendered id can name a conversation at all (a ULID). */
export function isConversationId(value: string): boolean {
  return ULID_PATTERN.test(value);
}

/** What is wrong with an agent step's conversation field, as `WorkflowIssue` codes. */
export function conversationProblems(node: WorkflowNode): string[] {
  if (node.kind !== 'agent' || !node.conversation) return [];
  const conversation = node.conversation;
  if (!(CONVERSATION_MODES as readonly string[]).includes(String(conversation.mode))) {
    return ['conversation_mode_unknown'];
  }
  if (conversation.mode !== 'reuse') return [];
  const id = (conversation.session_id ?? '').trim();
  if (!id) return ['conversation_id_missing'];
  if (!isTemplate(id) && !isConversationId(cleanConversationId(id))) {
    return ['conversation_id_invalid'];
  }
  return [];
}

/** The templates of the field (`session_id`, `title`), whose paths are checked like a prompt's. */
export function conversationTemplates(node: WorkflowNode): string[] {
  const reuse = reuseOf(node);
  if (!reuse) return [];
  return [reuse.sessionId, reuse.title].filter((text) => text.length > 0);
}
