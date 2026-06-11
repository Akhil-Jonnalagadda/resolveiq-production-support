# ResolveIQ

**AI Production Support Copilot** -- local-first incident diagnosis, Jira integration, real-time collaboration, and resolution tracking powered by Ollama and SQLite.

## What it does

A support engineer creates a customer incident (or syncs it from Jira), the system auto-analyzes it with local AI, the engineer reviews and approves the output, then resolves with tracked SLAs and preventive actions. Resolved cases are auto-indexed into a knowledge base for future lookup and runbook generation.

**Core workflow:** Intake > Auto-analyze > Human review > Approve > Resolve > Auto-index

**Key capabilities:**

- **Jira bidirectional sync** -- import tickets from Jira, auto-push local cases to Jira, sync comments both ways, and auto-transition Jira tickets to Done on resolution
- **Auto AI analysis** -- cases are automatically analyzed on creation with severity, cause, workaround, diagnostic steps, and a customer response draft
- **Human approval gate** -- review and edit AI-generated guidance before any customer communication
- **SLA monitoring** -- per-severity response and resolution targets with breach alerts and at-risk warnings
- **Knowledge base** -- auto-index resolved cases, surface similar incidents with resolutions, and auto-generate grounded runbooks
- **Real-time messaging** -- internal notes and customer-facing messages with WebSocket delivery, Jira comment sync, and unread badges
- **Gmail integration** -- create customer update drafts from approved analysis (optional)
- **Operations dashboard** -- open/urgent/breached counts, service hotspots, recurring problems, and trend metrics
- **Audit trail** -- actor-tagged history of every action and downloadable Markdown incident reports

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | React + TypeScript + Vite |
| Backend | FastAPI + Python |
| Database | SQLite |
| AI | Ollama (`llama3.2:3b` + `nomic-embed-text`) |
| Real-time | WebSockets (uvicorn) |
| Integrations | Jira Cloud API, Gmail API (optional) |

## Setup

### Prerequisites

- Python 3.11+
- Node.js 18+
- [Ollama](https://ollama.com) installed and running

Pull the models:

```bash
ollama pull llama3.2:3b
ollama pull nomic-embed-text
```

### macOS / Linux

```bash
# Backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
cp backend/.env.example backend/.env   # edit credentials before first run
uvicorn backend.app.main:app --port 8010

# Frontend (new terminal)
cd frontend
npm install
npm run dev
```

### Windows (PowerShell)

```powershell
# Backend
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt
copy backend\.env.example backend\.env
uvicorn backend.app.main:app --port 8010

# Frontend (new terminal)
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173** and sign in.

Default credentials (change in `backend/.env` before any demo):

```
Username: support-admin
Password: resolveiq-local-demo
```

## Configuration

All settings live in `backend/.env`. Key variables:

| Variable | Default | Purpose |
|---|---|---|
| `RESOLVEIQ_AUTH_USERNAME` | `support-admin` | Login username |
| `RESOLVEIQ_AUTH_PASSWORD` | `resolveiq-local-demo` | Login password |
| `RESOLVEIQ_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama endpoint |
| `RESOLVEIQ_OLLAMA_MODEL` | `llama3.2:3b` | Analysis model |
| `RESOLVEIQ_EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model |

### Jira integration (optional, free tier)

| Variable | Purpose |
|---|---|
| `RESOLVEIQ_JIRA_SITE_URL` | Your Atlassian site (e.g. `https://your-domain.atlassian.net`) |
| `RESOLVEIQ_JIRA_EMAIL` | Jira account email |
| `RESOLVEIQ_JIRA_API_TOKEN` | [API token](https://id.atlassian.com/manage-profile/security/api-tokens) |
| `RESOLVEIQ_JIRA_PROJECT_KEY` | Project key (e.g. `SUP`) |
| `RESOLVEIQ_JIRA_ISSUE_TYPE` | Issue type (default: `Task`) |
| `RESOLVEIQ_JIRA_SYNC_JQL` | JQL filter for sync (default: `status != Done ORDER BY created DESC`) |

When configured:
- Local cases auto-create a Jira ticket on creation
- "Sync Jira" imports tickets from Jira with correct priority mapping
- Messages sync as Jira comments (both directions)
- Resolving a case auto-transitions the Jira ticket to Done

### Gmail integration (optional)

| Variable | Purpose |
|---|---|
| `RESOLVEIQ_GMAIL_CLIENT_ID` | OAuth client ID |
| `RESOLVEIQ_GMAIL_CLIENT_SECRET` | OAuth client secret |
| `RESOLVEIQ_GMAIL_REFRESH_TOKEN` | OAuth refresh token |

When configured, approved analyses can generate Gmail customer update drafts.

## SLA targets

| Severity | Response | Resolution |
|---|---|---|
| Critical | 15 min | 4 hours |
| High | 1 hour | 8 hours |
| Medium | 4 hours | 24 hours |
| Low | 8 hours | 72 hours |

## Automation

These actions happen automatically without manual intervention:

| Trigger | Action |
|---|---|
| Case created (local or Jira sync) | AI analysis runs in background |
| Case created locally | Jira ticket auto-created (if configured) |
| Case resolved | Resolution auto-indexed into knowledge base |
| Case resolved | Jira ticket auto-transitioned to Done |
| Case resolved + similar cases exist | Runbook auto-generated from resolved evidence |
| Message sent | Synced as Jira comment |
| Messages tab opened | Jira comments pulled into ResolveIQ |

## Tests

```bash
# Backend (from project root)
.venv/bin/python -m unittest backend.tests.test_api -v

# E2E browser tests
cd frontend
npx playwright install chromium
npm run build
npm run test:e2e
```

## Quick demo

Create a case with these values to see the full workflow:

```
Title:    Payment processing timeout on checkout
Customer: Meridian Healthcare
Service:  Billing Gateway
Priority: Critical
Issue:    Customers report checkout page hangs for 60+ seconds
          then returns a gateway timeout error.
Logs:     ERROR POST /api/payments/charge 504
          Stripe webhook timeout after 30000ms
          Connection pool exhausted: max_connections=10
```
### Sample Incident Case 2

**Title:** User Authentication Failures After Identity Provider Update

| Field        | Value                  |
| ------------ | ---------------------- |
| **Customer** | Northstar Financial    |
| **Service**  | Authentication Service |
| **Priority** | Critical               |

**Issue**

Users report they cannot log in after a scheduled identity provider update. Login attempts fail immediately with an authentication error. Affected users include both web and mobile clients.

**Logs**

```text
ERROR POST /api/auth/login 401 Unauthorized
JWT validation failed: invalid signature
OIDC token issuer mismatch: expected=https://login.northstar.com
Connection to identity provider reset after 15000ms
```


The case will auto-analyze in a few seconds. Review the output, approve, resolve with a fix description, and the resolution is auto-indexed for future similar-case lookup.

## Project structure

```
backend/
  app/
    main.py          API endpoints and WebSocket
    models.py        Pydantic models
    database.py      SQLite operations
    config.py        Environment configuration
    services/
      analysis.py    Ollama AI analysis
      auth.py        Session authentication
      gmail.py       Gmail draft publishing
      jira.py        Jira sync, escalation, comments
      memory.py      Embedding and similarity
  tests/
    test_api.py      Backend integration tests
  .env.example       Configuration template
  requirements.txt   Python dependencies

frontend/
  src/
    App.tsx          UI components
    api.ts           API client
    types.ts         TypeScript types
    styles.css       Styles
    main.tsx         Entry point
  e2e/               Playwright tests
```
