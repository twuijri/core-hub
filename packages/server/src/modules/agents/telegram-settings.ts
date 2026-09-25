/**
 * Telegram's own settings in a Hermes profile: every user-facing option Hermes has for it, read
 * and written where Hermes reads it.
 *
 * The owner, 2026-09-24: «التليجرام فيه خصائص كثيره … يطلع ثينكينج … في اكثر من شغله». Hermes
 * reads these from three places, and the table below says which for each option — observed in
 * Hermes's source (MIT, `/opt/hermes`), not guessed:
 *
 * - the platform block, `platforms.telegram.<key>` in the profile's `config.yaml` (Hermes copies
 *   every key that is not one of its typed ones into the adapter's `extra`; a key already under
 *   `platforms.telegram.extra` wins over the same key beside it, and a root `telegram:` block wins
 *   over both — `gateway/config.py` §PlatformConfig.from_dict, `gateway/config_loader.py`);
 * - the profile's display settings, `display.platforms.telegram.<key>`, which fall back to the
 *   profile-wide `display.<key>` and then to Hermes's Telegram default
 *   (`gateway/display_config.py`) — written per platform here, so they change Telegram only;
 * - the profile's `.env` for the options Hermes reads from the environment first
 *   (`TELEGRAM_REQUIRE_MENTION`, `TELEGRAM_ALLOWED_USERS`, …): when a variable is already there
 *   the value is changed there, since it would win over the file anyway.
 *
 * `shared` options (speech-to-text, voice replies) are kept once for the profile, not for
 * Telegram, and change every channel there. The file is edited in place like the MCP and channel
 * blocks, comments and the rest of the document untouched.
 *
 * Left out on purpose, and why: transport tuning (HTTP pool sizes and timeouts, text/media batch
 * delays, fallback IP discovery, typing cooldown); webhook mode (needs a public HTTPS address and
 * a published port the hub's image does not open — long polling works everywhere); a local Bot
 * API server (`base_url`, `local_mode`); structured maps that need an editor of their own
 * (per-chat prompts and model overrides, DM and group topics, wake-word patterns, topic id lists);
 * generic gateway routing (`notice_delivery`, `reply_in_thread`, session-per-user). And keys the
 * Telegram adapter never reads (`reply_prefix`, `send_read_receipts`, `typing_status_text`), or
 * that do not exist for it (a formatting choice: Hermes always sends MarkdownV2; image types and
 * size limits are fixed).
 */
import {
  SettingError,
  displayKey,
  homeKey,
  platformKey,
  readChannelSettings,
  typedKey,
  writeChannelSettings,
  type ChannelSettingView,
  type OptionSpec,
  type SettingKind,
  type SettingSection,
} from './channel-settings.js';

export { SettingError };
export type { ChannelSettingView, SettingKind, SettingSection };

/** `platforms.telegram.<key>`, with the places that beat it first. */
const platform = (key: string) => platformKey('telegram', key);
/** A key Hermes types itself (`enabled`, `reply_to_mode`, …): only the platform block counts. */
const typed = (key: string) => typedKey('telegram', key);
const display = (key: string) => displayKey('telegram', key);

const CHAT_ID = /^-?[0-9]{1,20}$/;
const USER_ID = /^[0-9]{1,20}$/;

export const TELEGRAM_OPTIONS: readonly OptionSpec[] = [
  // ------------------------------------------------ who may message the bot
  {
    key: 'allowed_users',
    section: 'access',
    kind: 'list',
    fallback: [],
    item: USER_ID,
    env: 'TELEGRAM_ALLOWED_USERS',
    envOnly: true,
  },
  {
    key: 'unauthorized_dm_behavior',
    section: 'access',
    kind: 'select',
    fallback: 'pair',
    choices: ['pair', 'ignore'],
    yaml: typed('unauthorized_dm_behavior'),
  },
  // ------------------------------------------------ replies
  {
    key: 'show_reasoning',
    section: 'replies',
    kind: 'toggle',
    fallback: false,
    yaml: display('show_reasoning'),
    inherit: ['display', 'show_reasoning'],
  },
  {
    key: 'reasoning_style',
    section: 'replies',
    kind: 'select',
    fallback: 'code',
    choices: ['code', 'blockquote', 'subtext'],
    yaml: display('reasoning_style'),
    inherit: ['display', 'reasoning_style'],
  },
  {
    key: 'tool_progress',
    section: 'replies',
    kind: 'select',
    fallback: 'off',
    choices: ['off', 'new', 'all', 'verbose'],
    yaml: display('tool_progress'),
    inherit: ['display', 'tool_progress'],
  },
  {
    key: 'cleanup_progress',
    section: 'replies',
    kind: 'toggle',
    fallback: false,
    yaml: display('cleanup_progress'),
    inherit: ['display', 'cleanup_progress'],
  },
  {
    key: 'streaming',
    section: 'replies',
    kind: 'toggle',
    fallback: false,
    yaml: display('streaming'),
    // Unset, Telegram follows the profile's top-level `streaming.enabled` (display.streaming is
    // the terminal's, not the gateway's).
    inherit: ['streaming', 'enabled'],
  },
  {
    key: 'reply_to_mode',
    section: 'replies',
    kind: 'select',
    fallback: 'first',
    choices: ['off', 'first', 'all'],
    yaml: typed('reply_to_mode'),
    env: 'TELEGRAM_REPLY_TO_MODE',
  },
  {
    key: 'reactions',
    section: 'replies',
    kind: 'toggle',
    fallback: false,
    yaml: platform('reactions'),
    env: 'TELEGRAM_REACTIONS',
  },
  {
    key: 'typing_indicator',
    section: 'replies',
    kind: 'toggle',
    fallback: true,
    yaml: typed('typing_indicator'),
  },
  {
    key: 'disable_link_previews',
    section: 'replies',
    kind: 'toggle',
    fallback: false,
    yaml: platform('disable_link_previews'),
  },
  {
    key: 'notifications',
    section: 'replies',
    kind: 'select',
    fallback: 'important',
    choices: ['important', 'all'],
    yaml: display('notifications'),
    env: 'HERMES_TELEGRAM_NOTIFICATIONS',
  },
  // ------------------------------------------------ groups
  {
    key: 'require_mention',
    section: 'groups',
    kind: 'toggle',
    fallback: false,
    yaml: platform('require_mention'),
    env: 'TELEGRAM_REQUIRE_MENTION',
  },
  {
    key: 'allowed_chats',
    section: 'groups',
    kind: 'list',
    fallback: [],
    item: CHAT_ID,
    yaml: platform('allowed_chats'),
    env: 'TELEGRAM_ALLOWED_CHATS',
  },
  {
    key: 'free_response_chats',
    section: 'groups',
    kind: 'list',
    fallback: [],
    item: CHAT_ID,
    yaml: platform('free_response_chats'),
    env: 'TELEGRAM_FREE_RESPONSE_CHATS',
  },
  {
    key: 'group_allowed_users',
    section: 'groups',
    kind: 'list',
    fallback: [],
    item: USER_ID,
    env: 'TELEGRAM_GROUP_ALLOWED_USERS',
    envOnly: true,
  },
  {
    key: 'observe_unmentioned_group_messages',
    section: 'groups',
    kind: 'toggle',
    fallback: false,
    yaml: platform('observe_unmentioned_group_messages'),
    env: 'TELEGRAM_OBSERVE_UNMENTIONED_GROUP_MESSAGES',
  },
  {
    key: 'guest_mode',
    section: 'groups',
    kind: 'toggle',
    fallback: false,
    yaml: platform('guest_mode'),
    env: 'TELEGRAM_GUEST_MODE',
  },
  {
    key: 'exclusive_bot_mentions',
    section: 'groups',
    kind: 'toggle',
    fallback: true,
    yaml: platform('exclusive_bot_mentions'),
    env: 'TELEGRAM_EXCLUSIVE_BOT_MENTIONS',
  },
  {
    key: 'allow_bots',
    section: 'groups',
    kind: 'select',
    fallback: 'none',
    // Hermes also knows `mentions`, which it treats as `all` on Telegram.
    choices: ['none', 'all'],
    aliases: { mentions: 'all' },
    yaml: platform('allow_bots'),
    env: 'TELEGRAM_ALLOW_BOTS',
  },
  // ------------------------------------------------ media and voice (the profile's, every channel)
  {
    key: 'stt_enabled',
    section: 'media',
    kind: 'toggle',
    fallback: true,
    shared: true,
    yaml: [['stt', 'enabled']],
  },
  {
    key: 'stt_echo_transcripts',
    section: 'media',
    kind: 'toggle',
    fallback: true,
    shared: true,
    yaml: [['stt', 'echo_transcripts']],
  },
  {
    key: 'voice_auto_tts',
    section: 'media',
    kind: 'toggle',
    fallback: false,
    shared: true,
    yaml: [['voice', 'auto_tts']],
  },
  // ------------------------------------------------ advanced
  {
    key: 'home_channel',
    section: 'advanced',
    kind: 'text',
    fallback: null,
    item: CHAT_ID,
    yaml: homeKey('telegram'),
    env: 'TELEGRAM_HOME_CHANNEL',
    home: true,
  },
  {
    key: 'gateway_restart_notification',
    section: 'advanced',
    kind: 'toggle',
    fallback: true,
    yaml: typed('gateway_restart_notification'),
  },
  {
    key: 'command_menu_max',
    section: 'advanced',
    kind: 'number',
    fallback: 60,
    min: 1,
    max: 100,
    // Hermes reads this one at this exact path only.
    yaml: [['platforms', 'telegram', 'extra', 'command_menu', 'max_commands']],
  },
  {
    key: 'proxy_url',
    section: 'advanced',
    kind: 'text',
    fallback: null,
    yaml: platform('proxy_url'),
    env: 'TELEGRAM_PROXY',
    url: true,
  },
];

export function readTelegramSettings(home: string): ChannelSettingView[] {
  return readChannelSettings(home, TELEGRAM_OPTIONS);
}

/**
 * Writes `values` (option key → value, `null` to go back to the default) into the profile's
 * files, all or nothing: every value is checked before anything is written.
 */
export function writeTelegramSettings(
  home: string,
  values: Record<string, unknown>,
): ChannelSettingView[] {
  return writeChannelSettings(home, 'telegram', TELEGRAM_OPTIONS, values);
}
