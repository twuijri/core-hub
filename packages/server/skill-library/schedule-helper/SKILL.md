---
name: schedule-helper
description: Turn a plain-language request into a Core Hub schedule.
version: 1.0.0
author: twuijri (Core Hub)
license: Apache-2.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [schedule, cron, reminder, recurring, every day, automation, جدولة, تذكير, كل يوم, موعد, تكرار]
    category: core-hub
    related_skills: [report-writer, research-brief, summarize]
  core_hub:
    library: core-hub
---

# Schedule Helper Skill

Turns "every Sunday at 8 a.m. send me a summary of…" / «كل يوم الساعة ٧ الصبح لخص لي الأخبار»
into a Core Hub schedule: a name, a trigger (a five-field cron expression, an interval, or one
date and time), a time zone, and the prompt the agent will run. When the hub's own tools are
connected (`mcp__corehub__schedules_*`) it creates the schedule directly after the person
confirms; otherwise it gives the exact values to enter on the Schedules page.

يحوّل طلبًا مكتوبًا بكلام عادي إلى جدولة في Core Hub: اسم وموعد ومنطقة زمنية ونص التشغيل.

## When to Use

- «ذكرني كل…»، «كل يوم/أسبوع/شهر سوّ…»، «بعد ساعتين…»، "every weekday at 9", "remind me on the 1st".
- Changing, pausing or running an existing schedule now.
- Not for a one-off task to do right now (just do it), and not for Hermes's own `cronjob` tool —
  Core Hub schedules are the ones the person sees and manages on the Schedules page.

## Prerequisites

- Best: the Core Hub tools in this conversation — `mcp__corehub__schedules_list`,
  `mcp__corehub__schedules_create`, `mcp__corehub__schedules_pause`,
  `mcp__corehub__schedules_run_now` (the "Core Hub tools" card on the agent's MCP page, with
  "allow changes" on for Schedules). A write refused as read-only means that switch is off.
- Without them: nothing to install — the skill explains the steps.

## How to Run

With the tools:

```
mcp__corehub__schedules_create {"name": "...", "prompt": "...", "cron": "0 8 * * 0", "timezone": "Asia/Riyadh"}
mcp__corehub__schedules_create {"name": "...", "prompt": "...", "every_minutes": 120}
mcp__corehub__schedules_create {"name": "...", "prompt": "...", "run_at": "2026-10-01T09:00:00+03:00"}
mcp__corehub__schedules_list {}
mcp__corehub__schedules_pause {"schedule_id": "...", "paused": true}
```

Give exactly one of `cron`, `every_minutes` or `run_at`. Omit `timezone` to use the hub's.

## Quick Reference

| Said | Trigger |
|---|---|
| every day at 7 a.m. / كل يوم ٧ الصبح | `cron: "0 7 * * *"` |
| weekdays at 9 (Sun–Thu) / أيام الدوام ٩ | `cron: "0 9 * * 0-4"` |
| weekdays at 9 (Mon–Fri) | `cron: "0 9 * * 1-5"` |
| every Sunday 8:30 / كل أحد ٨:٣٠ | `cron: "30 8 * * 0"` |
| first of every month at 10 / أول كل شهر | `cron: "0 10 1 * *"` |
| every 2 hours / كل ساعتين | `every_minutes: 120` |
| in 3 hours / بعد ٣ ساعات | `run_at`: now + 3 h, ISO 8601 with offset |
| tomorrow 4 p.m. / بكرة العصر ٤ | `run_at`: tomorrow 16:00 in the person's zone |

Cron fields: minute hour day-of-month month day-of-week (0 = Sunday). Arabic time words:
الفجر ≈ 5, الصبح ≈ 7–8, الظهر ≈ 12, العصر ≈ 15–16, المغرب ≈ 18, العشاء/الليل ≈ 20–21 — confirm
the exact hour when the person used one of these.

## Procedure

1. Extract: what to do (the prompt), when (trigger), where time is measured (time zone), and a
   short name in the person's language.
2. Write the prompt as a complete instruction the agent can run later without this conversation:
   what to do, where to put the result, in which language. Name a skill if one fits
   ("use the summarize skill …").
3. Confirm in one message before creating: name, the schedule in words ("every Sunday at 08:00,
   Riyadh time"), the cron/interval/date, and the prompt. Ask only if something is ambiguous
   (a.m./p.m., which weekdays, which time zone).
4. With the tools: create it, then report the schedule's name, its next run and how to pause it.
   Without them: give the values to enter on Schedules → New schedule, field by field.
5. To change a schedule, list first and act on the right `schedule_id`; never guess an id.

## Pitfalls

- Do not create anything before the person confirms.
- Local time matters: Saudi Arabia is `Asia/Riyadh` (UTC+3, no daylight saving); use the zone the
  person lives in, not the server's, when they differ.
- A run in the past is refused; say so and propose the next occurrence.
- Very frequent schedules (every few minutes) cost money and noise; suggest a sensible interval.

## Verification

- After creating, `mcp__corehub__schedules_list` shows the schedule with the expected next run.
- The confirmation you sent and the created schedule agree on time, zone and prompt.
