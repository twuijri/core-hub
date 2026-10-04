# Closed test feedback log (Google Play)

Play asks, when applying for production access, how testers used the app, what feedback they
gave and what changed because of it. This log keeps those answers true and ready to copy: one row
per piece of feedback, written when it arrives. Only feedback that really came from a tester goes
here; changes we made on our own go under "Our own changes" so the two are never mixed.

No personal details here (this repository is public): a tester is named by their GitHub handle
when they opened the PR themselves, otherwise just "tester".

The closed test (track "Closed testing - Alpha", email list "Testers") opened on 2026-10-05 with
1.1.7 (100001). Feedback dated before that came from the same people while they used the GitHub
builds; Play's questions are about the closed test, so report those rows as earlier user feedback.

## Feedback from testers

| Date | Feedback | From | What changed | Where |
|---|---|---|---|---|
| 2026-09-26 | The Arabic interface and the download page read unnaturally | aboawadh (opened the PR) | Arabic UI and download-page wording rewritten | #167 |
| 2026-09-27 | Thinking and tool calls scattered through the reply are distracting; group them | tester | A turn's tool calls fold into one live window and a summary row (web, iOS, Android) | #178 |
| 2026-10-01 | Tapping a message in the chat doesn't let me copy it | tester | A long press on the agent's reply opens its menu (copy and more); swipe to reply | 42061d15, 1.1.7 (#233) |
| 2026-10-05 | I can't tell when a message arrived; show its time under it (on a light tap, or always) | tester (closed test) | A light tap on a message shows its time under it (today: time; yesterday; older: date + time); the web hover row follows the same rule | #236 |

## Our own changes during the test

| Date | Change | Where |
|---|---|---|

## Usage notes

Opted-in count from the Play Console dashboard ("Have at least 12 testers opted-in"):

| Date | Opted in | Note |
|---|---|---|
| 2026-10-05 | 1 | 6 on the email list |
