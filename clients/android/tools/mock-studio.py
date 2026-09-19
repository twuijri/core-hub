"""
A stand-in for a Hermes Studio server, so the app can be run and screenshotted
without one.

    python3 tools/mock-studio.py

Then sign in from a debug build with any username and password:

    emulator   http://10.0.2.2:8099
    device     http://<your machine's LAN address>:8099

Debug builds allow plain HTTP to those two hosts (see
app/src/debug/res/xml/network_security_config.xml); release builds do not.

This mock speaks REST only. The app tries the /chat-run socket first and falls
back to POST /api/studio/chat-run/runs when it cannot connect, so running against this
file exercises that fallback rather than streaming.
"""
import base64, json, re, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, unquote, urlparse

# A 1x1 grey PNG stands in for /logo.png; the app only has to fetch and cache it.
LOGO = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
)

PROFILES = [
    {"name": "manager", "model": "claude-opus-5", "active": True, "avatar": None},
    {"name": "barq", "model": "claude-sonnet-5", "active": False, "avatar": None},
    {"name": "deep-engineer", "model": "gpt-5", "active": False, "avatar": None},
]
SESSIONS = [
    {"id": "s1", "title": "تقرير الأسبوع", "model": "claude-opus-5", "updated_at": "2026-07-30T18:20:00", "profile": "manager"},
    {"id": "s2", "title": "Deploy the staging box", "model": "claude-sonnet-5", "updated_at": "2026-07-30T14:02:00", "profile": "barq"},
    {"id": "s3", "title": "مراجعة كود الاستديو", "model": "gpt-5", "updated_at": "2026-07-29T09:41:00", "profile": "deep-engineer"},
]
MESSAGES = [
    {"id": "m1", "role": "user", "content": "وش وضع التقرير؟", "timestamp": "2026-07-30T18:19:00"},
    {"id": "m2", "role": "assistant", "content": "خلصت الجزء الأول ورفعته على السيرفر. باقي المراجعة النهائية.", "timestamp": "2026-07-30T18:20:00"},
]
ROOM_AGENTS = [
    {"id": "seat-1", "agentId": "seat-1", "agent": "hermes", "agentMode": "scoped", "profile": "manager",
     "provider": "anthropic", "model": "claude-opus-5", "apiMode": "", "reasoningEffort": "high",
     "name": "برق", "description": "يراجع الكود", "avatar": None, "connectionStatus": "online"},
    {"id": "seat-2", "agentId": "seat-2", "agent": "claude", "agentMode": "global", "profile": "barq",
     "provider": "anthropic", "model": "claude-sonnet-5", "apiMode": "responses", "reasoningEffort": "",
     "name": "Ada", "description": "writes the tests", "avatar": None, "connectionStatus": "online"},
]
ROOM_MEMBERS = [{"id": "u1", "userId": "1", "name": "owner", "description": "", "avatar": None, "connectionStatus": "online"}]
ROOMS = [{
    "id": "r1", "name": "غرفة التطوير", "inviteCode": "ABC234", "canManage": True,
    "workspace": "/home/agent/projects/core-hub", "totalTokens": 18432,
    "summaryProfile": "manager", "summaryProvider": "", "summaryModel": "", "summaryApiMode": "", "summaryEveryTurns": 10,
    "agentHandoffEnabled": True, "agentHandoffMaxDepth": 3, "agentHandoffUnlimited": False,
    "lastActiveAt": 1785000000000, "createdAt": 1784000000000, "agents": ROOM_AGENTS,
}]
ROOM_MESSAGES = [
    {"id": "g1", "roomId": "r1", "senderId": "1", "senderName": "owner", "senderType": "member",
     "role": "user", "content": "وش وضع المراجعة؟", "timestamp": 1785000000000},
    {"id": "g2", "roomId": "r1", "senderId": "seat-1", "senderName": "برق", "senderType": "agent",
     "role": "tool", "run_id": "run-1", "toolName": "Bash", "toolStatus": "done",
     "toolPreview": "git status", "content": "clean", "timestamp": 1785000001000},
    {"id": "g3", "roomId": "r1", "senderId": "seat-1", "senderName": "برق", "senderType": "agent",
     "role": "assistant", "run_id": "run-1", "content": "راجعت الفرع وكل شيء نظيف.", "timestamp": 1785000002000},
]
ROOM_SUMMARY = {"summary": "الفريق يراجع فرع الجوال.", "status": "ready", "summarizedTurnCount": 4, "updatedAt": 1785000000000, "lastError": None}
HANDOFFS = [{"chainId": "ch-1", "roomId": "r1", "targetAgentId": "seat-2", "status": "stopped",
             "stopReason": "depth_reached", "currentDepth": 3, "maxDepth": 3, "unlimited": False,
             "continueUsed": False, "lastError": None, "updatedAt": 1785000000000}]
AGENT_PRESETS = [{"id": "p1", "name": "مراجع الكود", "description": "يقرأ الفروقات", "agent": "claude",
                  "agentMode": "scoped", "profile": "manager", "provider": "anthropic", "model": "claude-opus-5",
                  "apiMode": "", "reasoningEffort": "high", "avatar": None, "available": True, "validationError": ""}]
SESSION_CATEGORIES = [{"id": 1, "name": "العمل"}, {"id": 2, "name": "شخصي"}]
WORKFLOWS = [{
    "id": "wf-1", "name": "تقرير الليل", "profile": "manager", "workspace": "/home/agent/projects/core-hub",
    "updated_at": 1785000000000,
    "nodes": [
        {"id": "n1", "data": {"title": "اجمع الأخبار", "agent": "hermes", "model": "claude-opus-5", "input": "اجمع آخر الأخبار"}},
        {"id": "n2", "data": {"title": "اكتب التقرير", "agent": "claude", "model": "claude-sonnet-5", "approvalRequired": True}},
        {"id": "n3", "data": {"title": "أرسل", "agent": "hermes", "model": "claude-opus-5"}},
    ],
    "edges": [{"id": "e1", "source": "n1", "target": "n2"}, {"id": "e2", "source": "n2", "target": "n3"}],
}]
WORKFLOW_RUNS = [{
    "id": "run-1", "workflow_id": "wf-1", "status": "running", "created_at": 1785000000000,
    "started_at": 1785000000000, "trigger_source": "manual", "profile": "manager", "error": None,
    "node_sessions": [
        {"id": "ns1", "node_id": "n1", "execution_id": "x1", "status": "completed", "session_id": "s1",
         "profile": "manager", "agent": "hermes", "sequence": 0, "started_at": 1785000000000, "finished_at": 1785000004000},
        {"id": "ns2", "node_id": "n2", "execution_id": "x2", "status": "blocked", "session_id": "s2",
         "profile": "manager", "agent": "claude", "sequence": 1, "started_at": 1785000004000},
    ],
}]
WORKFLOW_SCHEDULES = [{"id": "sch-1", "workflow_id": "wf-1", "schedule": "0 9 * * *",
                       "timezone": "Asia/Riyadh", "enabled": True, "next_run_at": 1785086400000}]
JOBS = [
    {
        "job_id": "morning-brief",
        "id": "morning-brief",
        "name": "ملخص الصباح",
        "prompt": "راجع آخر المستجدات وأرسل لي ملخصًا قصيرًا.",
        "prompt_preview": "راجع آخر المستجدات وأرسل لي ملخصًا قصيرًا.",
        "skills": ["web-research"],
        "model": "claude-opus-5",
        "provider": "anthropic",
        "schedule": {"kind": "cron", "expr": "0 9 * * *", "display": "يوميًا 09:00"},
        "schedule_display": "يوميًا 09:00",
        "repeat": {"times": None, "completed": 4},
        "enabled": True,
        "state": "scheduled",
        "created_at": "2026-07-20T10:00:00Z",
        "next_run_at": "2026-08-01T09:00:00Z",
        "last_run_at": "2026-07-31T09:00:00Z",
        "last_status": "ok",
        "last_error": None,
        "deliver": "telegram:12345",
        "last_delivery_error": None,
    },
    {
        "job_id": "weekly-review",
        "id": "weekly-review",
        "name": "مراجعة الأسبوع",
        "prompt": "اجمع إنجازات الأسبوع واقترح أولويات الأسبوع القادم.",
        "skills": [],
        "model": None,
        "provider": None,
        "schedule": {"kind": "cron", "expr": "0 18 * * 4", "display": "الخميس 18:00"},
        "schedule_display": "الخميس 18:00",
        "repeat": {"times": 12, "completed": 2},
        "enabled": False,
        "state": "paused",
        "created_at": "2026-07-15T12:00:00Z",
        "next_run_at": None,
        "last_run_at": "2026-07-24T18:00:00Z",
        "last_status": "ok",
        "last_error": None,
        "deliver": "local",
        "last_delivery_error": None,
    },
]
RUN_OUTPUT = "# ملخص التشغيل\n\nاكتملت المهمة بنجاح، وهذه نتيجة تجريبية من سيرفر الاختبار المحلي.\n"
CONFIG = {
    "model": {"default": "claude-opus-5"},
    "display": {"streaming": True, "compact": False, "show_reasoning": True, "show_cost": False,
                "inline_diffs": True, "bell_on_complete": False, "notify_on_complete": False,
                "chat_input_height": 96},
    "agent": {"max_turns": 24, "gateway_timeout": 0, "restart_drain_timeout": 45,
              "tool_use_enforcement": "auto"},
    "memory": {"memory_enabled": True, "user_profile_enabled": True, "memory_char_limit": 2000,
               "user_char_limit": 2000, "write_approval": False},
    "skills": {"write_approval": False},
    "compression": {"enabled": True, "threshold": 0.5, "target_ratio": 0.2,
                    "protect_last_n": 20, "protect_first_n": 3},
    "session_reset": {"mode": "both", "idle_minutes": 60, "at_hour": 4},
    "privacy": {"redact_pii": True},
    "approvals": {"mode": "manual"},
    "gatewayAutoStart": {"enabled": True, "include": None, "exclude": [], "management": "unified"},
    "proxy": {"HTTPS_PROXY": "", "HTTP_PROXY": "", "ALL_PROXY": "", "NO_PROXY": "localhost,127.0.0.1"},
    "platforms": {"telegram": {"enabled": True}},
    "platformCredentialStatus": {"telegram": True},
}
PROVIDERS = [
    {"provider": "anthropic", "label": "Anthropic", "builtin": True, "base_url": "https://api.anthropic.com",
     "api_key": "configured", "models": ["claude-opus-5", "claude-sonnet-5"]},
    {"provider": "openai", "label": "OpenAI", "builtin": True, "base_url": "https://api.openai.com/v1",
     "api_key": "", "models": ["gpt-5"]},
]
USERS = [
    {"id": 1, "username": "twuijri", "role": "super_admin", "status": "active", "profiles": [],
     "default_profile": None, "last_login_at": 1785492000000},
    {"id": 2, "username": "operator", "role": "admin", "status": "active", "profiles": ["manager"],
     "default_profile": "manager", "last_login_at": None},
]
LOCKS = [{"ip": "192.0.2.10", "type": "password", "failures": 5,
          "lockedUntil": int(time.time() * 1000) + 15 * 60 * 1000}]
ACCOUNT_AVATAR = {"type": "default", "seed": "twuijri"}
KANBAN_TASKS = [
    {"id": "k1", "title": "تصميم تجربة كانبان للجوال", "body": "بطاقات واضحة وسحب بين المراحل.",
     "assignee": "manager", "status": "running", "priority": 4, "created_at": 1785520000,
     "skills": ["android", "product-design"]},
    {"id": "k2", "title": "مراجعة ترجمة الواجهة", "body": "فحص العربية والإنجليزية على شاشة صغيرة.",
     "assignee": "barq", "status": "review", "priority": 2, "created_at": 1785510000,
     "skills": ["summarize"]},
    {"id": "k3", "title": "اختبار MCP", "body": "التأكد من اتصال سيرفر filesystem.",
     "assignee": None, "status": "todo", "priority": 1, "created_at": 1785500000, "skills": []},
    {"id": "k4", "title": "نشر نسخة أندرويد", "body": "إنشاء APK موقّع وإرفاقه في GitHub.",
     "assignee": "deep-engineer", "status": "done", "priority": 3, "created_at": 1785400000,
     "result": "تم النشر بنجاح", "skills": ["android"]},
]
KANBAN_COMMENTS = {"k1": [{"id": "c1", "author": "twuijri", "body": "خل السحب واضح على الجوال.", "created_at": 1785520100}]}
SKILL_CATEGORIES = [{"name": "Local", "description": "مهارات خاصة بالاستديو", "skills": [
    {"name": "android", "description": "بناء وفحص تطبيقات Android", "enabled": True, "source": "local", "pinned": True, "useCount": 12},
    {"name": "product-design", "description": "تصميم واجهات جوال انسيابية", "enabled": True, "source": "local", "pinned": False, "useCount": 8},
    {"name": "web-research", "description": "جمع المعلومات من المصادر", "enabled": False, "source": "builtin", "pinned": False, "useCount": 4},
]}]
SKILL_CONTENT = {"android": "# Android\n\nBuild, test, and verify native Android applications.",
                 "product-design": "# Product design\n\nDesign clear mobile-first interfaces.",
                 "web-research": "# Web research\n\nResearch using primary sources."}
PLUGINS = [
    {"key": "mobile-notifications", "name": "Mobile notifications", "kind": "standalone", "source": "local",
     "configStatus": "configured", "effectiveStatus": "enabled", "version": "1.2.0",
     "description": "يرسل إشعارات عند اكتمال مهام الوكيل.", "author": "Hermes",
     "providesTools": ["notify"], "providesHooks": ["after_run"], "requiresEnv": []},
    {"key": "bundled-memory", "name": "Memory", "kind": "builtin", "source": "bundled",
     "configStatus": "configured", "effectiveStatus": "enabled", "version": "0.6.35",
     "description": "إضافة الذاكرة المدمجة.", "author": "Hermes",
     "providesTools": ["memory_search", "memory_write"], "providesHooks": [], "requiresEnv": []},
]
MCP_SERVERS = [
    {"name": "filesystem", "transport": "stdio", "connected": True, "tools": 2, "tools_registered": 2,
     "tool_details": [{"name": "read_file", "description": "Read a file"}, {"name": "list_directory", "description": "List files"}],
     "raw_config": {"transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]}},
]
PETS = [
    {"slug": "luna", "displayName": "Luna", "kind": "cat", "submittedBy": "Hermes", "previewUrl": "/mock/pet.png"},
    {"slug": "barq", "displayName": "Barq", "kind": "fox", "submittedBy": "Studio", "previewUrl": "/mock/pet.png"},
]
ACTIVE_PET = {"enabled": True, "slug": "luna", "displayName": "Luna", "kind": "cat", "scale": 1.0,
              "spritesheetDataUrl": "data:image/png;base64," + base64.b64encode(LOGO).decode()}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def send(self, payload, code=200):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def json_body(self):
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length)
        return json.loads(raw or b'{}')

    def find_job(self, job_id):
        return next((job for job in JOBS if job['job_id'] == job_id), None)

    def m4_write(self, path, body):
        """
        One writer for the M4 routes (rooms, presets, workflows, sessions).
        The mock keeps no real state machine; it answers with the envelope the
        app parses so every screen can show a saved state instead of an error.
        """
        if path.endswith('/config') or path.endswith('/workspace'):
            ROOMS[0].update({k: v for k, v in body.items() if k in ROOMS[0] or k.startswith('agentHandoff')})
            return {"room": ROOMS[0]}
        if path.endswith('/clone'):
            return {"room": dict(ROOMS[0], id="r2", name=body.get('name') or 'نسخة')}
        if path.endswith('/invite-code'):
            ROOMS[0]['inviteCode'] = body.get('inviteCode', ROOMS[0]['inviteCode'])
            return {"ok": True}
        if path.endswith('/summary'):
            ROOM_SUMMARY['summary'] = body.get('summary', ROOM_SUMMARY['summary'])
            return {"summary": ROOM_SUMMARY}
        if re.fullmatch(r'/api/studio/group-chat/rooms/[^/]+/agents', path):
            return {"agent": dict(ROOM_AGENTS[0], id="seat-3", name=body.get('name') or body.get('profile', 'seat'))}
        if re.fullmatch(r'/api/studio/group-chat/rooms/[^/]+/agents/[^/]+', path):
            return {"agents": ROOM_AGENTS}
        if re.fullmatch(r'/api/studio/group-chat/rooms/[^/]+/members/[^/]+', path):
            return {"members": ROOM_MEMBERS}
        if path.endswith('/continue'):
            return {"chain": dict(HANDOFFS[0], status="running", continueUsed=True)}
        if path.startswith('/api/studio/group-chat/agent-presets'):
            return {"preset": dict(AGENT_PRESETS[0], name=body.get('name', AGENT_PRESETS[0]['name']))}
        if path == '/api/studio/session-categories':
            new_id = max([item['id'] for item in SESSION_CATEGORIES] + [0]) + 1
            SESSION_CATEGORIES.append({"id": new_id, "name": body.get('name', f'فئة {new_id}')})
            return {"category": SESSION_CATEGORIES[-1]}
        if path.startswith('/api/studio/workflows/import'):
            return {"preview": {"token": "tok", "summary": {"name": WORKFLOWS[0]['name']}}, "ok": True}
        if path.endswith('/schedules'):
            WORKFLOW_SCHEDULES.append(dict(WORKFLOW_SCHEDULES[0], id=f"sch-{len(WORKFLOW_SCHEDULES) + 1}",
                                           schedule=body.get('schedule', '0 9 * * *')))
            return {"ok": True}
        if 'batch' in path:
            return {"updated": len(body.get('ids', [])), "failed": 0}
        return {"ok": True, "success": True}

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path in ('/logo.png', '/mock/pet.png'):
            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.send_header('Content-Length', str(len(LOGO)))
            self.end_headers()
            self.wfile.write(LOGO)
        elif path == '/api/auth/me': self.send({"user": USERS[0]})
        elif path == '/health': self.send({"status": "ok", "webui_version": "1.0.2-mock"})
        elif path == '/api/auth/avatar': self.send({"avatar": json.dumps(ACCOUNT_AVATAR)})
        elif path == '/api/auth/users': self.send({"users": USERS, "profiles": [p["name"] for p in PROFILES]})
        elif path == '/api/auth/locked-ips': self.send({"locks": LOCKS})
        elif path == '/api/hermes/profiles': self.send({"profiles": PROFILES})
        elif path == '/api/studio/sessions': self.send({"sessions": SESSIONS})
        elif re.match(r'/api/studio/sessions/conversations/.+/messages', path): self.send({"messages": MESSAGES})
        elif path == '/api/studio/sessions/search':
            needle = parse_qs(parsed.query).get('q', [''])[0]
            hits = [dict(item, snippet=needle) for item in SESSIONS if needle in item['title']] or SESSIONS[:1]
            self.send({"sessions": hits})
        elif path == '/api/studio/session-categories': self.send({"categories": SESSION_CATEGORIES})
        elif path == '/api/studio/sessions/hermes':
            self.send({"sessions": SESSIONS + [dict(SESSIONS[0], id='s9', title='محادثة مؤرشفة', is_archived=True)]})
        elif path == '/api/studio/group-chat/rooms': self.send({"rooms": ROOMS})
        elif path == '/api/studio/group-chat/agent-presets': self.send({"presets": AGENT_PRESETS})
        elif re.fullmatch(r'/api/studio/group-chat/rooms/join/[^/]+', path): self.send({"room": ROOMS[0]})
        elif re.fullmatch(r'/api/studio/group-chat/rooms/[^/]+/summary', path): self.send({"summary": ROOM_SUMMARY})
        elif re.fullmatch(r'/api/studio/group-chat/rooms/[^/]+/handoffs', path): self.send({"chains": HANDOFFS})
        elif re.fullmatch(r'/api/studio/group-chat/rooms/[^/]+/agents', path): self.send({"agents": ROOM_AGENTS})
        elif re.match(r'/api/studio/group-chat/rooms/.+', path):
            self.send({"room": ROOMS[0], "agents": ROOM_AGENTS, "members": ROOM_MEMBERS,
                       "messages": ROOM_MESSAGES, "total": len(ROOM_MESSAGES), "hasMore": False,
                       "handoffChains": HANDOFFS, "roomSummary": ROOM_SUMMARY, "executionQueue": [],
                       "pendingApprovals": [], "pendingClarifies": [], "activities": []})
        elif path == '/api/studio/workflows': self.send({"workflows": WORKFLOWS})
        elif re.fullmatch(r'/api/studio/workflows/[^/]+/runs', path): self.send({"runs": WORKFLOW_RUNS})
        elif re.fullmatch(r'/api/studio/workflows/[^/]+/runs/[^/]+', path): self.send({"run": WORKFLOW_RUNS[0]})
        elif re.fullmatch(r'/api/studio/workflows/[^/]+/schedules', path): self.send({"schedules": WORKFLOW_SCHEDULES})
        elif re.fullmatch(r'/api/studio/workflows/[^/]+', path): self.send({"workflow": WORKFLOWS[0]})
        elif path == '/api/hermes/config':
            section = parse_qs(parsed.query).get('section', [None])[0]
            self.send({section: CONFIG.get(section, {})} if section else CONFIG)
        elif path == '/api/hermes/available-models':
            self.send({"default": "claude-opus-5", "default_provider": "anthropic", "groups": PROVIDERS,
                       "allProviders": PROVIDERS})
        elif path == '/api/hermes/jobs': self.send({"jobs": JOBS})
        elif path == '/api/hermes/jobs/delivery-targets':
            self.send({"updated_at": "2026-07-31T09:00:00Z", "targets": [
                {"platform": "telegram", "id": "12345", "name": "التحديثات", "type": "group", "thread_id": None, "value": "telegram:12345"}
            ]})
        elif re.fullmatch(r'/api/hermes/jobs/[^/]+', path):
            job = self.find_job(unquote(path.rsplit('/', 1)[1]))
            self.send({"job": job}, 200 if job else 404)
        elif path == '/api/hermes/kanban/boards':
            counts = {}
            for task in KANBAN_TASKS: counts[task['status']] = counts.get(task['status'], 0) + 1
            self.send({"boards": [{"slug": "default", "name": "تطوير التطبيق", "description": "مهام الجوال",
                                   "is_current": True, "counts": counts, "total": len(KANBAN_TASKS)}]})
        elif path == '/api/hermes/kanban': self.send({"tasks": KANBAN_TASKS})
        elif path == '/api/hermes/kanban/assignees':
            self.send({"assignees": [{"name": p['name'], "on_disk": True} for p in PROFILES]})
        elif re.fullmatch(r'/api/hermes/kanban/[^/]+', path):
            task_id = unquote(path.rsplit('/', 1)[1])
            task = next((item for item in KANBAN_TASKS if item['id'] == task_id), None)
            self.send({"task": task, "latest_summary": task.get('result') if task else None,
                       "comments": KANBAN_COMMENTS.get(task_id, []), "events": [],
                       "runs": [{"id": "run-1", "status": "success", "summary": "تم التشغيل", "started_at": 1785520000}] if task else []},
                      200 if task else 404)
        elif path == '/api/hermes/skills': self.send({"categories": SKILL_CATEGORIES, "archived": []})
        elif re.fullmatch(r'/api/hermes/skills/[^/]+/[^/]+', path):
            name = unquote(path.rsplit('/', 1)[1])
            self.send({"content": SKILL_CONTENT.get(name, f"# {name}\n")})
        elif path == '/api/hermes/plugins': self.send({"plugins": PLUGINS, "warnings": []})
        elif path == '/api/hermes/mcp/servers': self.send({"servers": MCP_SERVERS})
        elif path == '/api/hermes/petdex/manifest':
            self.send({"generatedAt": "2026-07-31", "total": len(PETS), "pets": PETS})
        elif path == '/api/hermes/pets/active': self.send({"pet": ACTIVE_PET})
        elif path == '/api/cron-history':
            job_id = parse_qs(parsed.query).get('jobId', ['morning-brief'])[0]
            self.send({"runs": [{"jobId": job_id, "fileName": "2026-07-31T09-00-00.md", "runTime": "2026-07-31 09:00:00", "size": len(RUN_OUTPUT.encode()), "hasOutput": True, "status": "ok"}]})
        elif re.fullmatch(r'/api/cron-history/[^/]+/[^/]+', path):
            _, _, _, job_id, file_name = path.split('/')
            self.send({"jobId": unquote(job_id), "fileName": unquote(file_name), "runTime": "2026-07-31 09:00:00", "content": RUN_OUTPUT})
        else: self.send({"error": "not found"}, 404)

    def do_POST(self):
        path = self.path.split('?')[0]
        if path == '/api/hermes/skills/import':
            length = int(self.headers.get('Content-Length') or 0)
            self.rfile.read(length)
            self.send({"name": "imported-skill"})
            return
        body = self.json_body()
        if path.startswith('/api/studio/group-chat/') or path.startswith('/api/studio/workflows') or path.startswith('/api/studio/sessions'):
            self.send(self.m4_write(path, body))
            return
        if path == '/api/auth/login': self.send({"token": "mock-token"})
        elif path in ('/api/auth/change-password', '/api/auth/change-username'):
            if path.endswith('change-username') and body.get('newUsername'):
                USERS[0]['username'] = body['newUsername']
            self.send({"success": True})
        elif path == '/api/auth/users':
            next_id = max(user['id'] for user in USERS) + 1
            USERS.append({"id": next_id, "username": body.get('username', f'user{next_id}'),
                          "role": body.get('role', 'admin'), "status": body.get('status', 'active'),
                          "profiles": body.get('profiles', []), "default_profile": body.get('defaultProfile'),
                          "last_login_at": None})
            self.send({"users": USERS})
        elif path == '/api/studio/chat-run/runs':
            time.sleep(1)
            self.send({"output": "تم، سجلت الملاحظة.", "session_id": "s1"})
        elif path.endswith('/gateway/restart'): self.send({"success": True})
        elif path == '/api/hermes/jobs':
            job_id = f"mock-job-{len(JOBS) + 1}"
            job = {
                "job_id": job_id, "id": job_id, "name": body.get('name', job_id),
                "prompt": body.get('prompt', ''), "skills": body.get('skills', []),
                "model": body.get('model'), "provider": body.get('provider'),
                "schedule": body.get('schedule', ''), "schedule_display": body.get('schedule', ''),
                "repeat": {"times": body.get('repeat'), "completed": 0}, "enabled": True,
                "state": "scheduled", "created_at": "2026-07-31T12:00:00Z",
                "next_run_at": "2026-08-01T09:00:00Z", "last_run_at": None,
                "last_status": None, "last_error": None, "deliver": body.get('deliver', 'local'),
                "last_delivery_error": None,
            }
            JOBS.append(job)
            self.send({"job": job})
        elif path == '/api/hermes/kanban':
            task = {"id": f"k{len(KANBAN_TASKS) + 1}", "title": body.get('title', 'New task'),
                    "body": body.get('body'), "assignee": body.get('assignee'),
                    "status": "triage" if body.get('triage') else "todo", "priority": body.get('priority', 1),
                    "created_at": int(time.time()), "skills": body.get('skills', [])}
            KANBAN_TASKS.append(task)
            self.send({"task": task})
        elif path == '/api/hermes/kanban/tasks/bulk':
            for task in KANBAN_TASKS:
                if task['id'] in body.get('ids', []): task['status'] = body.get('status', task['status'])
            self.send({"results": [{"id": item, "ok": True} for item in body.get('ids', [])]})
        elif re.fullmatch(r'/api/hermes/kanban/[^/]+/assign', path):
            task_id = unquote(path.split('/')[-2])
            task = next((item for item in KANBAN_TASKS if item['id'] == task_id), None)
            if task: task['assignee'] = body.get('profile')
            self.send({"task": task}, 200 if task else 404)
        elif re.fullmatch(r'/api/hermes/kanban/[^/]+/comments', path):
            task_id = unquote(path.split('/')[-2])
            comment = {"id": f"c{int(time.time())}", "author": body.get('author', 'phone'),
                       "body": body.get('body', ''), "created_at": int(time.time())}
            KANBAN_COMMENTS.setdefault(task_id, []).append(comment)
            self.send({"comment": comment})
        elif re.fullmatch(r'/api/hermes/plugins/[^/]+/(enable|disable)', path):
            key, action = path.rsplit('/', 2)[1:]
            plugin = next((item for item in PLUGINS if item['key'] == unquote(key)), None)
            if plugin: plugin['effectiveStatus'] = 'enabled' if action == 'enable' else 'disabled'
            self.send({"success": True})
        elif path == '/api/hermes/mcp/servers':
            config = body.get('config', {})
            MCP_SERVERS.append({"name": body.get('name'), "transport": config.get('transport', 'stdio'),
                                "connected": True, "tools": 0, "tools_registered": 0,
                                "tool_details": [], "raw_config": config})
            self.send({"success": True})
        elif path == '/api/hermes/mcp/reload' or re.fullmatch(r'/api/hermes/mcp/servers/[^/]+/test', path):
            self.send({"success": True})
        elif path == '/api/hermes/pets/adopt':
            pet = next((item for item in PETS if item['slug'] == body.get('slug')), PETS[0])
            ACTIVE_PET.update({"enabled": True, "slug": pet['slug'], "displayName": pet['displayName'],
                               "kind": pet['kind'], "scale": 1.0})
            self.send({"pet": ACTIVE_PET})
        elif re.fullmatch(r'/api/hermes/jobs/[^/]+/(pause|resume|run)', path):
            job_id, action = path.rsplit('/', 2)[1:]
            job = self.find_job(unquote(job_id))
            if not job: self.send({"error": {"message": "Job not found"}}, 404); return
            if action == 'pause': job.update({"enabled": False, "state": "paused", "next_run_at": None})
            elif action == 'resume': job.update({"enabled": True, "state": "scheduled", "next_run_at": "2026-08-01T09:00:00Z"})
            else: job.update({"last_run_at": "2026-07-31T12:00:00Z", "last_status": "ok"})
            self.send({"job": job}, 202 if action == 'run' else 200)
        else: self.send({"success": True})

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self.json_body()
        if path.startswith('/api/studio/group-chat/') or path.startswith('/api/studio/workflows'):
            self.send(self.m4_write(path, body))
            return
        if path == '/api/hermes/config':
            section = body.get('section')
            if section:
                CONFIG.setdefault(section, {}).update(body.get('values', {}))
            self.send({"success": True})
        elif re.fullmatch(r'/api/hermes/config/providers/.+', path):
            provider_id = unquote(path.rsplit('/', 1)[1])
            provider = next((item for item in PROVIDERS if item['provider'] == provider_id), None)
            if provider: provider.update(body)
            self.send({"success": True})
        elif re.fullmatch(r'/api/auth/users/\d+', path):
            user = next((item for item in USERS if item['id'] == int(path.rsplit('/', 1)[1])), None)
            if user:
                for key in ('username', 'role', 'status', 'profiles'):
                    if key in body: user[key] = body[key]
                if 'defaultProfile' in body: user['default_profile'] = body['defaultProfile']
            self.send({"users": USERS})
        elif path == '/api/auth/avatar':
            avatar = body.get('avatar', {})
            if isinstance(avatar, str):
                try: avatar = json.loads(avatar)
                except json.JSONDecodeError: avatar = {}
            ACCOUNT_AVATAR.clear()
            ACCOUNT_AVATAR.update(avatar if isinstance(avatar, dict) else {"type": "default"})
            self.send({"success": True})
        elif path == '/api/hermes/skills/toggle':
            for category in SKILL_CATEGORIES:
                for skill in category['skills']:
                    if skill['name'] == body.get('name'): skill['enabled'] = body.get('enabled', True)
            self.send({"success": True})
        elif path == '/api/hermes/skills/pin':
            for category in SKILL_CATEGORIES:
                for skill in category['skills']:
                    if skill['name'] == body.get('name'): skill['pinned'] = body.get('pinned', False)
            self.send({"success": True})
        elif re.fullmatch(r'/api/hermes/skills/[^/]+/[^/]+', path):
            SKILL_CONTENT[unquote(path.rsplit('/', 1)[1])] = body.get('content', '')
            self.send({"success": True})
        else:
            self.send({"success": True})

    def do_PATCH(self):
        path = urlparse(self.path).path
        body = self.json_body()
        if path.startswith('/api/studio/workflows'):
            self.send(self.m4_write(path, body))
            return
        if re.fullmatch(r'/api/hermes/mcp/servers/[^/]+', path):
            name = unquote(path.rsplit('/', 1)[1])
            server = next((item for item in MCP_SERVERS if item['name'] == name), None)
            if server:
                server['raw_config'] = body.get('config', server['raw_config'])
                server['transport'] = server['raw_config'].get('transport', server['transport'])
            self.send({"success": True})
            return
        if path == '/api/hermes/pets/active':
            ACTIVE_PET.update(body)
            self.send({"pet": ACTIVE_PET})
            return
        match = re.fullmatch(r'/api/hermes/jobs/([^/]+)', path)
        job = self.find_job(unquote(match.group(1))) if match else None
        if not job: self.send({"error": {"message": "Job not found"}}, 404); return
        for key in ('name', 'prompt', 'deliver', 'model', 'provider'):
            if key in body: job[key] = body[key]
        if 'schedule' in body:
            job['schedule'] = body['schedule']
            job['schedule_display'] = body['schedule']
        if 'skills' in body: job['skills'] = body['skills']
        if 'repeat' in body: job['repeat']['times'] = body['repeat']
        self.send({"job": job})

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith('/api/studio/group-chat/') or path.startswith('/api/studio/workflows') or path.startswith('/api/studio/session'):
            self.send(self.m4_write(path, {}))
            return
        if path == '/api/auth/locked-ips':
            ip = parse_qs(parsed.query).get('ip', [None])[0]
            before = len(LOCKS)
            if ip: LOCKS[:] = [lock for lock in LOCKS if lock['ip'] != ip]
            else: LOCKS.clear()
            self.send({"count": before - len(LOCKS)})
            return
        user_match = re.fullmatch(r'/api/auth/users/(\d+)', path)
        if user_match:
            USERS[:] = [user for user in USERS if user['id'] != int(user_match.group(1))]
            self.send({"users": USERS})
            return
        mcp_match = re.fullmatch(r'/api/hermes/mcp/servers/([^/]+)', path)
        if mcp_match:
            name = unquote(mcp_match.group(1))
            MCP_SERVERS[:] = [server for server in MCP_SERVERS if server['name'] != name]
            self.send({"success": True})
            return
        skill_match = re.fullmatch(r'/api/hermes/skills/([^/]+)/([^/]+)', path)
        if skill_match:
            name = unquote(skill_match.group(2))
            for category in SKILL_CATEGORIES:
                category['skills'][:] = [skill for skill in category['skills'] if skill['name'] != name]
            SKILL_CONTENT.pop(name, None)
            self.send({"success": True})
            return
        match = re.fullmatch(r'/api/hermes/jobs/([^/]+)', path)
        job = self.find_job(unquote(match.group(1))) if match else None
        if not job: self.send({"error": {"message": "Job not found"}}, 404); return
        JOBS.remove(job)
        self.send({"ok": True})

if __name__ == '__main__':
    print('mock Hermes Studio on http://0.0.0.0:8099 — any credentials work')
    HTTPServer(('0.0.0.0', 8099), Handler).serve_forever()
