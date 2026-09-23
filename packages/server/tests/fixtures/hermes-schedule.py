"""Parse schedule strings with the real Hermes, from a checkout of its source, stdlib only.

The cron bridge's integration test sends each string the hub would put in `schedule` and
reads back what Hermes's own `cron.jobs.parse_schedule` made of it — or the error it gave.
Cron expressions need `croniter`, which Hermes's image has; without it the answer says so.
"""
import json
import sys

from cron.jobs import parse_schedule

out = []
for text in sys.argv[1:]:
    try:
        out.append({"ok": True, "schedule": parse_schedule(text)})
    except Exception as error:  # the test reads Hermes's own words
        out.append({"ok": False, "error": str(error)})
print(json.dumps(out))
