# Naan & Curry Food Cost Tracker

Auto-pulls Restaurant Depot receipts and Sysco orders daily, parses every line item,
and shows total food cost by vendor, category, and Sysco location.

Tracking starts **June 1, 2026**. Anything earlier is ignored.

## How it works

- **Restaurant Depot** — logs in, opens `/member/receipts`, picks the longest range
  covering June 1, clicks Request, waits for the list, downloads each receipt's
  Excel/CSV, parses it. Returns and voids net out automatically. One consolidated account.
- **Sysco** — logs in, loops all 5 locations through the account switcher
  (Durango Main, Cheyenne, Rhodes Ranch, St Rose, The Strip), reads every
  Delivered order since June 1 from `/app/orders`, opens each order and scrapes
  the line items.
- Everything dedupes by invoice/order number, so re-running never double-counts.
- Runs automatically **every day at 5:00 PM Las Vegas time**, plus a manual
  refresh button in the app.

## Deploy on Railway

1. Push this folder to a new GitHub repo.
2. New Railway project → Deploy from that repo.
3. Add a **Volume** mounted at `/data` (keeps invoices across restarts).
4. Set environment variables:

| Variable | Value |
|---|---|
| `RD_EMAIL` | Restaurant Depot login email |
| `RD_PASSWORD` | Restaurant Depot password |
| `SYSCO_EMAIL` | Sysco Shop login email |
| `SYSCO_PASSWORD` | Sysco Shop password |
| `GITHUB_TOKEN` | (optional) token for nightly JSON backup |
| `GITHUB_REPO` | (optional) e.g. `youruser/naan-curry-foodcost` |

5. Deploy. Open the app URL and tap **Pull invoices now** to backfill from June 1.

## API

- `GET /api/data?range=month|7|30` — dashboard payload (Current Month is default)
- `GET /api/trigger?source=all|rd|sysco` — manual scrape
- `GET /api/status` — scrape log + progress
- `GET /api/clear?vendor=rd|sysco&key=...` — remove one stored invoice/order
- `GET /api/force-backup` — push backup to GitHub now

## Tests

`node test.js` — parses 4 real RD receipts and verifies totals, void netting,
tax handling, categorization, and dashboard math (58 checks).
