# Core Hub privacy policy

*For the Core Hub app for iPhone and iPad (`com.twuijri.corehub`). Last updated 26 September 2026.*
[العربية](privacy.ar.md)

Core Hub is an app for **your own Core Hub server** (a "hub"): software you or someone you trust
runs on a computer of your choosing. The app is a window onto that hub. It is developed by
twuijri, who does not run your hub and cannot see it.

## In short

- **The developer collects no data.** No account with us, no analytics, no advertising, no
  tracking, no crash reporting of our own. The app contains no third-party SDK.
- **The app talks only to the hub you choose**, at the address you type or the pairing code you
  scan. What you send there is kept by that hub and by whoever runs it, under their rules.
- A few things necessarily pass through **Apple**: push notifications, and speech recognition when
  you dictate with the phone's own voice. They are described below.

## What the app sends to your hub

Everything you do in the app is a request to your hub: signing in, your messages and the photos
and files you attach, your answers to an agent, changes to tasks, schedules and settings. When you
sign in, the app also tells your hub how to list this phone among your devices: the phone's name
and model, the app's version, and a random identifier made by the app. When you allow
notifications, it gives your hub this phone's push token so the hub can notify you.

Your sign-in (the hub's address and the token it gave the app) is kept in the phone's Keychain.
Your choices on this phone (language, theme, voice) stay on the phone.

## Notifications

When a reply is ready or an agent is waiting for you, your hub can send a notification. It goes
through **Apple Push Notification service**, like every notification on iPhone:

- with the hub's own Apple key, if whoever runs your hub set one up; or
- **when enabled**, through the Core Hub push relay run by the developer (a Cloudflare Worker),
  for hubs that have no Apple key of their own. The relay passes each notification on to Apple
  and stores no content: no title, no text, no message and no push token. To know which hub may
  notify which phone, it keeps only a one-way hash of the push token, and it keeps counters to
  limit abuse. A hub can turn on private notifications, which then say only "New notice in
  Core Hub" and the app reads the rest from your hub.

You can turn notifications off at any time in the iPhone's Settings. Without them, the app looks
for new notices from your hub now and then while it is closed.

## Permissions the app asks for, and why

| Permission | Why |
|---|---|
| **Camera** | To scan the pairing code your hub shows on the web, and to take a photo you attach to a message. |
| **Photos** | To attach the photos you pick to a message. Only the photos you choose are read. |
| **Microphone** | To hear you while you dictate a message. |
| **Speech recognition** | To turn your dictation into text when the app uses the phone's own voice (see below). |
| **Local network** | To reach a hub on your home or office network. |
| **Notifications** | To tell you when a reply is ready or an agent is waiting for you. |

Nothing is recorded or read unless you start it.

## Dictation and spoken replies

When you dictate, the app uses the voice setting in **Settings → This device**:

- **Core Hub** (the default): if your hub has a speech service set up, your recording goes to your
  hub, which turns it into text. Otherwise the phone's own recognizer is used.
- **This phone**: the phone's own speech recognition. This is **Apple's speech recognition**, which
  may send the audio to Apple to be processed, under
  [Apple's privacy policy](https://www.apple.com/legal/privacy/).

Replies read aloud come from your hub's speech service or from the phone's own voice.

## Sharing into Core Hub

When you share text or a link to Core Hub from another app, it is kept on the phone until you open
Core Hub, where it becomes the draft of a new chat. Nothing is sent until you send it.

## Children

Core Hub is a tool for people who run their own server. It is not directed at children.

## Changes and contact

Changes to this policy are made in this file, in the open, and its history shows every change.
Questions: [open an issue](https://github.com/twuijri/core-hub/issues).
