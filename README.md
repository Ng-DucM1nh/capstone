# Livestock Dashboard

Python FastAPI backend + HTML/CSS/JS frontend for livestock feedlot performance analytics. Multi-tenant on Supabase PostgreSQL, deployable to **Vercel**.

## Features

- **7 dashboard pages**: Summary Stats, Time Series, Prediction, Distributions, Cohorts, Data Management, Reports
- **Shared filter sidebar** with debounced queries, saved views (localStorage), EID privacy for non-admin users
- **JWT auth** with scrypt passwords (admin / owner / user roles)
- **Email scheduling** (daily/weekly/monthly/once) with cron worker
- **Admin CSV upload** with snapshot backup and skip/overwrite duplicates
- **Farm KF (Killara Feedlot)** seeded with real `Data.csv` (~12,117 records)

## Quick Start (Local)

### 1. Configure environment

```bash
cp backend/.env.example backend/.env
# Set DATABASE_URL to your Supabase pooler URL (port 6543; encode @ in password as %40)
# Note: For offline local development, DATABASE_URL can be omitted or left blank to automatically use local embedded DuckDB.
```

**Required: `EID_PSEUDONYM_KEY`.** The secret used to mask animal EIDs (`ID-XXXXXXXX`) for non-admin users.
Without it the API refuses every request (HTTP 503) and the pages show a banner saying it is missing.
Add a random value to `backend/.env` (and to Vercel's environment variables in production):

```bash
python -c "import secrets; print(secrets.token_hex(32))"
# backend/.env:  EID_PSEUDONYM_KEY=<that value>
```

Keep it secret and don't change it once users have seen masked EIDs: a new key gives every animal a new mask.

### 2. Install & seed

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
```

**Option A: Offline local development (DuckDB)**

Developers can test locally without an active Supabase/PostgreSQL instance by initializing an embedded DuckDB database:

```bash
# Seed default users + import sample CSV or DuckDB file
python scripts/init_duckdb.py --csv path/to/dev_data.csv --force

# Or initialize schema and default credentials only:
python scripts/init_duckdb.py --force
```

*Note: DuckDB is developer-only and barred in production/Vercel environments.*

**Option B: Remote database (Supabase PostgreSQL)**

```bash
python scripts/seed.py --force
```

### 3. Run (HTML frontend + API)

**One process (recommended):**

```bash
cd backend && uvicorn app.main:app --reload --port 8000
```

Open http://localhost:8000/login.html

**Or two processes:**

```bash
# Terminal 1
cd backend && uvicorn app.main:app --reload --port 8000

# Terminal 2
cd frontend && python -m http.server 3000
```

Open http://localhost:3000/login.html

### Default credentials

| Username | Password | Role |
|----------|----------|------|
| admin | admin123 | Admin |
| owner | owner123 | Admin |
| user | user123 | Viewer (EIDs anonymized) |

## Deploy to Vercel

Repo: https://github.com/tienvinh1210/F12_04  

Full guide: **[VERCEL_DEPLOYMENT.md](VERCEL_DEPLOYMENT.md)**

Quick summary:
1. Complete [Supabase setup](SUPABASE_SETUP.md) and seed data
2. Push this repo to GitHub
3. Import on [vercel.com](https://vercel.com) — **Root Directory = `.`**
4. Add env vars (`DATABASE_URL`, `JWT_SECRET`, `EID_PSEUDONYM_KEY`, `CORS_ORIGINS`, etc.)
5. Deploy → open `https://your-app.vercel.app/login.html`

After first deploy, set:

```
CORS_ORIGINS=https://your-app.vercel.app
```

then redeploy.

## API Health Check

```bash
curl https://your-app.vercel.app/api/health
# {"status":"ok","version":"1.0.0"}
```

## Project Structure

```
backend/app/           FastAPI application
frontend/              HTML/CSS/JS dashboard (primary UI)
api/                   Vercel serverless entry (Mangum)
database/              PostgreSQL schema
scripts/seed.py        Seed users + KF data from Data.csv (PostgreSQL)
scripts/init_duckdb.py Seed dev-only embedded DuckDB database (offline dev)
scripts/forecast_job.py Preview or backfill a farm's weight forecasts (Prediction page)
ml/                   Forecasting code and the trained XGBoost model
```

See [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) for layout details.

## Weight Prediction (MVP)

The **Prediction** page shows a 182-day (6-month) FinalPweight forecast per animal, starting from each
animal's last recorded day. Admins pick real EIDs; other users pick masked IDs, which the server resolves.

- **Model:** recursive XGBoost trained on the 2026 workbook (training script, backtest report and
  experiments live on the `ml` branch). The model is used for as many days as its backtest covered, then
  the animal follows the farm's typical daily gain for its weight (median gain per 50 kg band, never above
  the farm-wide median), so projections slow down at heavy weights. That part is an unvalidated
  projection. One model serves every animal; those with fewer than 14 consecutive recent days are flagged
  as "short history" on the page.
- **Tested range:** `fade_days` in `ml/models/model_meta.json`, set by the training script (`FADE_DAYS`).
  It is 20 for the current model, the furthest the backtest could check on 98 days of training data.
  Forecasts use the model for that many days and store the number with each row, and the page marks those
  days as tested. Nothing in the app needs editing: a model retrained on a longer dataset and backtested
  further ahead carries its own range, which the next refresh picks up.
- **Forecasts refresh on every upload, on the server.** After `POST /api/admin/farms/{farm_id}/upload`
  saves the records, the same request recomputes the farm's forecasts (a few seconds) and stores them in
  the `forecasts` table; the Prediction page only reads that table. The response's `forecasts` field
  says how it went. If the refresh fails, the upload still stands; retry with
  `POST /api/admin/farms/{farm_id}/forecasts/refresh`, which is also how to apply a newly deployed model.
  Send `forecast=false` with the upload to skip the refresh.
- **No xgboost on the server.** xgboost needs scipy, and the two would not fit in Vercel's 250 MB function
  limit, so the API runs the trained trees with numpy (`ml/tree_model.py`, from `ml/models/xgb_weight.json`).
  The tests check that this gives the same predictions as xgboost.
- The first refresh creates the `forecasts` table (the `DATABASE_URL` user needs permission to create
  tables; Supabase's default `postgres` user has it).

```bash
python admin-cli/admin.py upload --farm KF --file KF_2026-10-20.csv --api https://your-app.vercel.app --token <admin JWT>
python admin-cli/admin.py forecast --farm KF --api https://your-app.vercel.app --token <admin JWT>   # refresh only
python scripts/forecast_job.py --farm KF --dry-run  # preview against the database backend/.env selects
```

To try it locally without touching Supabase, run the server on the dev DuckDB
(`cd backend && DATABASE_BACKEND=duckdb EMAIL_DRY_RUN=true uvicorn app.main:app --port 8000`) and upload to
`--api http://localhost:8000`. Uploads and refreshes then go through that one server, so DuckDB's
one-writer limit does not get in the way.

After retraining (`ml` branch), export the model for the server as well, then redeploy and refresh:
`python -c "import xgboost as x; b = x.Booster(); b.load_model('ml/models/xgb_weight.ubj'); b.save_model('ml/models/xgb_weight.json')"`.

## Tests

```bash
# Run all tests (from backend directory)
cd backend
python -m pytest

# Run fast in-memory unit tests
python -m pytest -m unit

# Run HTTP API route contract tests
python -m pytest -m api
```

## Runbook

- **Change passwords**: `PUT /api/auth/password` or re-run seed
- **Upload CSV**: `POST /api/admin/farms/KF/upload`
- **Email dry run**: `EMAIL_DRY_RUN=true`
- See `TESTING.md`, `DEPLOYMENT.md`, `00_BLUEPRINT_MASTER.md`
