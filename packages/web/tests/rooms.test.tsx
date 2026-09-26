// Rooms on the web (DECISIONS §69): the mention rules the composer sends by, the transcript
// the socket feeds, and the composer's `@` list.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n/context.js';
import { RoomComposer } from '../src/rooms/RoomComposer.js';
import { insertMention, mentionQuery, mentionsIn, suggest } from '../src/rooms/mentions.js';
import { codeFrom } from '../src/rooms/queries.js';
import { applyRoomEvent, loaded, prepend, textOf } from '../src/rooms/transcript.js';
import type { Message } from '../src/types.js';
import type * as attachmentQueries from '../src/attachments/queries.js';

// The room composer uploads through the chat's own upload (attachments/queries.ts); here the
// hub answers at once with the attachment it would have stored.
vi.mock('../src/attachments/queries.js', async (original) => ({
  ...(await original<typeof attachmentQueries>()),
  useUploadAttachment: () => ({
    upload: async ({ file }: { file: File }) => ({
      id: `ATT-${file.name}`,
      name: file.name,
      mime: file.type,
      size_bytes: file.size,
      kind: file.type.startsWith('image/') ? 'image' : 'file',
    }),
  }),
}));

afterEach(cleanup);

const seats = [
  { id: 'S1', name: 'المخطِّط' },
  { id: 'S2', name: 'Code' },
  { id: 'S3', name: 'Code Reviewer' },
];

describe('mentions', () => {
  it('finds the @… being typed, and not an e-mail address', () => {
    expect(mentionQuery('hi @Co', 6)).toEqual({ start: 3, query: 'Co' });
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('mail a@b.c', 10)).toBeNull();
    expect(mentionQuery('no mention', 10)).toBeNull();
    expect(mentionQuery('@Code\nnext', 10)).toBeNull();
  });

  it('suggests names that start with the letters first, then names that contain them', () => {
    expect(suggest(seats, 'code').map((s) => s.id)).toEqual(['S2', 'S3']);
    expect(suggest(seats, 'rev').map((s) => s.id)).toEqual(['S3']);
    expect(suggest(seats, '').map((s) => s.id)).toEqual(['S1', 'S2', 'S3']);
  });

  it('a pick replaces what was typed with the whole name and a space', () => {
    expect(insertMention('hi @Co please', 3, 6, 'Code Reviewer')).toEqual({
      text: 'hi @Code Reviewer  please',
      caret: 18,
    });
  });

  it('reads whole names only, the longest first, in any script, and @all when allowed', () => {
    expect(mentionsIn('@Code Reviewer look', seats, false)).toEqual([
      { kind: 'seat', seat_id: 'S3' },
    ]);
    expect(mentionsIn('@Code and @Code Reviewer', seats, false)).toEqual([
      { kind: 'seat', seat_id: 'S3' },
      { kind: 'seat', seat_id: 'S2' },
    ]);
    expect(mentionsIn('@المخطِّط ما الخطوة؟', seats, false)).toEqual([
      { kind: 'seat', seat_id: 'S1' },
    ]);
    expect(mentionsIn('@Coder is not a seat', seats, false)).toEqual([]);
    expect(mentionsIn('a@Code', seats, false)).toEqual([]);
    expect(mentionsIn('@all hello', seats, true)).toEqual([{ kind: 'all', seat_id: null }]);
    expect(mentionsIn('@all hello', seats, false)).toEqual([]);
  });

  it('a join link comes down to its code', () => {
    expect(codeFrom('https://hub.example/join/7kq2m9xw/')).toBe('7KQ2M9XW');
    expect(codeFrom(' 9PZM4KQ7 ')).toBe('9PZM4KQ7');
  });
});

function message(id: string, seq: number, extra: Partial<Message> = {}): Message {
  return {
    id,
    profile: 'default',
    owner_id: 'U',
    created_at: '2026-09-25T10:00:00Z',
    updated_at: '2026-09-25T10:00:00Z',
    session_id: 'R',
    room_id: 'R',
    seat_id: null,
    seq,
    role: 'user',
    author: { kind: 'user', id: 'U', name: 'Tariq', avatar: null },
    content: [{ type: 'text', text: `m${seq}` }],
    reasoning: null,
    tool_calls: [],
    run_id: null,
    status: 'complete',
    mentions: [],
    handoff: null,
    usage: null,
    reply_to_message_id: null,
    ...extra,
  };
}

describe('the room transcript', () => {
  it('keeps messages in seq order, once each, and puts an older page in front', () => {
    let state = loaded([message('b', 2), message('a', 1)], true);
    state = applyRoomEvent(state, 'message.created', { message: message('c', 3) });
    state = applyRoomEvent(state, 'message.created', { message: message('c', 3) });
    expect(state.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    state = prepend(state, [{ ...message('z', 1), seq: 0 }], false);
    expect(state.messages.map((m) => m.id)).toEqual(['z', 'a', 'b', 'c']);
    expect(state.hasMore).toBe(false);
  });

  it('streams a seat reply into its message and swaps in the final one', () => {
    const shell = message('r', 2, {
      role: 'assistant',
      status: 'streaming',
      content: [],
      run_id: 'RUN',
      seat_id: 'S1',
      author: { kind: 'agent', id: 'A', name: 'المخطِّط', avatar: null },
    });
    let state = loaded([message('a', 1), shell], false);
    state = applyRoomEvent(state, 'message.delta', {
      message_id: 'r',
      run_id: 'RUN',
      session_id: 'X',
      delta: 'نبدأ ',
    });
    state = applyRoomEvent(state, 'message.delta', {
      message_id: 'r',
      run_id: 'RUN',
      session_id: 'X',
      delta: 'بالواجهة',
    });
    expect(textOf(state.messages[1]!)).toBe('نبدأ بالواجهة');
    state = applyRoomEvent(state, 'tool.started', {
      run_id: 'RUN',
      tool_call: { name: 'read_file', preview: 'docs/plan.md' },
    });
    expect(state.tools).toEqual({ RUN: 'docs/plan.md' });
    state = applyRoomEvent(state, 'run.completed', {
      run: { id: 'RUN' },
      message: {
        ...shell,
        status: 'complete',
        content: [{ type: 'text', text: 'نبدأ بالواجهة.' }],
      },
    });
    expect(state.tools).toEqual({});
    expect(state.messages[1]!.status).toBe('complete');
    expect(textOf(state.messages[1]!)).toBe('نبدأ بالواجهة.');
  });

  it('knows who is typing', () => {
    let state = loaded([], false);
    state = applyRoomEvent(state, 'member.typing', { member_id: 'M1', name: 'سارة', typing: true });
    expect(state.typing).toEqual({ M1: 'سارة' });
    state = applyRoomEvent(state, 'member.typing', {
      member_id: 'M1',
      name: 'سارة',
      typing: false,
    });
    expect(state.typing).toEqual({});
  });
});

describe('the room composer', () => {
  function renderComposer(onSend = vi.fn(async () => true)) {
    render(
      <I18nProvider language="en">
        <RoomComposer
          seats={seats}
          allowAll
          leadName="المخطِّط"
          disabledReason={null}
          sending={false}
          onSend={onSend}
          onTyping={() => {}}
        />
      </I18nProvider>,
    );
    return { onSend, input: screen.getByTestId('room-input') as HTMLTextAreaElement };
  }

  it('opens the seats on @, picks one with Enter, and sends it as a structured mention', async () => {
    const { onSend, input } = renderComposer();
    expect(screen.getByTestId('room-composer-hint').textContent).toContain('@المخطِّط');
    fireEvent.change(input, { target: { value: '@Cod', selectionStart: 4 } });
    const options = screen.getAllByTestId('mention-option').map((o) => o.textContent);
    expect(options).toEqual(['@Code', '@Code Reviewer']);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('@Code Reviewer ');
    fireEvent.change(input, {
      target: { value: '@Code Reviewer please look', selectionStart: 26 },
    });
    fireEvent.keyDown(input, { key: 'Enter' });
    await vi.waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(onSend).toHaveBeenCalledWith(
      [{ type: 'text', text: '@Code Reviewer please look' }],
      [{ kind: 'seat', seat_id: 'S3' }],
    );
  });

  it('sends a picture and a file with the words, and a picture alone (§99)', async () => {
    const { onSend, input } = renderComposer();
    const picker = screen.getByTestId('room-file-input') as HTMLInputElement;
    expect(screen.getByTestId('room-attach').getAttribute('aria-label')).toBe('Attach files');
    fireEvent.change(picker, {
      target: {
        files: [
          new File(['png'], 'plan.png', { type: 'image/png' }),
          new File(['pdf'], 'brief.pdf', { type: 'application/pdf' }),
        ],
      },
    });
    await vi.waitFor(() =>
      expect(
        [...screen.getByTestId('room-composer-attachments').querySelectorAll('li')].map((li) =>
          li.getAttribute('data-status'),
        ),
      ).toEqual(['done', 'done']),
    );
    fireEvent.change(input, { target: { value: 'look at these', selectionStart: 13 } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenLastCalledWith(
      [
        { type: 'text', text: 'look at these' },
        {
          type: 'image',
          attachment_id: 'ATT-plan.png',
          name: 'plan.png',
          mime: 'image/png',
          size_bytes: 3,
        },
        {
          type: 'file',
          attachment_id: 'ATT-brief.pdf',
          name: 'brief.pdf',
          mime: 'application/pdf',
          size_bytes: 3,
        },
      ],
      [],
    );
    // What went is gone from the tray.
    await vi.waitFor(() => expect(screen.queryByTestId('room-composer-attachments')).toBeNull());

    // Words are not required: a picture alone is a message.
    fireEvent.change(picker, {
      target: { files: [new File(['jpg'], 'site.jpg', { type: 'image/jpeg' })] },
    });
    await vi.waitFor(() =>
      expect((screen.getByTestId('room-send') as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByTestId('room-send'));
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend).toHaveBeenLastCalledWith(
      [
        {
          type: 'image',
          attachment_id: 'ATT-site.jpg',
          name: 'site.jpg',
          mime: 'image/jpeg',
          size_bytes: 3,
        },
      ],
      [],
    );
  });

  it('offers @all when the room allows it', () => {
    const { input } = renderComposer();
    fireEvent.change(input, { target: { value: '@al', selectionStart: 3 } });
    expect(screen.getAllByTestId('mention-option').map((o) => o.textContent)).toEqual([
      '@allevery agent',
    ]);
  });
});
