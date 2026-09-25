# Notes for App Review

The text below goes into App Store Connect → the version → **App Review Information → Notes**. The
demo account's username and password go into the **Sign-in required** fields next to it; the owner
enters them there himself and they are never written in this repository.

Replace `<DEMO_HUB_URL>` (twice) with the demo hub's address when pasting. The address is not
written here because this repository never names the owner's servers (AGENTS.md, hard rules).

---

Core Hub is a client for a self-hosted server. People run their own Core Hub server (a "hub") on
a computer of their choosing, and add AI agents and model providers to it; the app signs in to that
hub and shows its chats, agents, tasks and settings. The app has no server of ours behind it and
no account with us: it works only with a hub.

For this review we run a demo hub:

    <DEMO_HUB_URL>

It is a standard Core Hub server (version 1.1.0) with one agent connected to a free model. The
demo account's username and password are in the App Review Information sign-in fields.

HOW TO SIGN IN (no QR code needed)

1. Open the app. The first screen is "Sign in".
2. Below the two pairing-code buttons and the word "or", fill in:
   - Hub address: <DEMO_HUB_URL>
   - Username and Password: from the App Review Information fields
3. Tap "Sign in".

The "Scan a pairing code" and "Paste a pairing code" buttons are another way to sign in, for
people who already use their hub on the web; they are not needed for the review. The app follows
the phone's language (English or Arabic); the globe menu at the top of the sign-in screen switches
it.

WHAT TO TRY

- Chat: after sign-in the app opens a new chat. Type a message and send it. The reply streams in
  as the model writes it; a free model can take several seconds, and if it is busy the chat says
  so — send the message again.
- The menu button (three lines, top left) opens the drawer: New chat, Search, Agents, Tasks,
  Schedules, and the list of chats. Tap a chat to open it.
- Agents (shown to an admin account): each agent with its pages (Skills, MCP, Memory, Jobs,
  Channels, Plugins, Settings, as the agent supports them).
- Tasks and Schedules: the hub's task board and scheduled runs.
- In a chat, the "+" button attaches a photo or a file, and the microphone button dictates a
  message (the app asks for the microphone and speech recognition the first time).
- Settings: the gear at the bottom of the drawer. "This device" holds the voice and notification
  choices of this phone.
- Sign out: at the bottom of the drawer.

PERMISSIONS

Camera (scan a pairing code; take a photo to attach), Photos (attach chosen photos), Microphone
and Speech Recognition (dictation), Local Network (a hub on the home network), Notifications (a
reply is ready, an agent is waiting). Each is asked only when the feature is used, except
notifications, which are asked once after sign-in.

The app uses only the operating system's encryption (HTTPS); ITSAppUsesNonExemptEncryption is
false. It collects no data; the privacy policy is at
https://github.com/twuijri/core-hub/blob/main/docs/privacy.md

---

## For the owner, before each submission

- The demo hub answers at the address above, on the version being reviewed or newer, and its free
  model replies.
- The demo account can sign in with a username and password (not only by QR) and sees at least
  one agent. An admin account also shows the Agents page and every Settings page; a member sees
  fewer.
- The same username and password are in App Review Information → Sign-in required.
