# Zara stock checker

Watches a Zara product page and **emails you** when sold-out sizes (default **XS, S, M**)
come back in stock. Runs **for free in the cloud via GitHub Actions**, so it works no matter
which laptop you're on (Mac or Windows) — or whether your laptop is even on.

Currently watching: **[Oversized High Collar Bomber Jacket](https://www.zara.com/us/en/oversized-high-collar-bomber-jacket-p06318042.html)** — sizes XS, S, M.

## How it works

1. Every 30 minutes, GitHub runs `check.js` on its own servers.
2. The script opens the Zara page in **real headless Chrome** (Zara blocks plain bots; real
   Chrome gets through), reads the live stock status for each size.
3. If a watched size flips from *out of stock* → *in stock*, it emails you via Gmail.
4. A small `state.json` is committed each time so you only get **one** email per restock,
   not one every 30 minutes.

## One-time setup (~10 min)

### 1. Put this project on GitHub
- Create a new repository (private is fine) at <https://github.com/new>.
- Push these files to it:
  ```bash
  git init && git add . && git commit -m "Zara stock checker"
  git branch -M main
  git remote add origin https://github.com/<you>/<repo>.git
  git push -u origin main
  ```

### 2. Create a Gmail App Password (so the job can email you)
- Your Google account needs **2-Step Verification ON**.
- Go to <https://myaccount.google.com/apppasswords>, create one named "zara", copy the
  16-character password.

### 3. Add secrets & variables in the repo
Repo → **Settings → Secrets and variables → Actions**:

**Secrets** (tab "Secrets"):
| Name | Value |
|------|-------|
| `GMAIL_USER` | your full Gmail address (the account that sends) |
| `GMAIL_APP_PASSWORD` | the 16-char app password from step 2 |
| `EMAIL_TO` | where alerts go — e.g. `a24558023@gmail.com` |

**Variables** (tab "Variables", optional — defaults are baked in):
| Name | Value |
|------|-------|
| `PRODUCT_URL` | a different Zara product URL to watch |
| `SIZES` | comma-separated sizes, e.g. `XS,S,M` |

### 4. Turn it on & test
- Repo → **Actions** tab → enable workflows if prompted.
- Open **"Zara stock check"** → **Run workflow** to test immediately.
- Check the run log — it prints each size's status. If email is configured and a size is in
  stock, you'll get a message.

## Changing how often it checks
Edit the `cron` line in [.github/workflows/stock-check.yml](.github/workflows/stock-check.yml):
- `*/30 * * * *` — every 30 min (default)
- `*/15 * * * *` — every 15 min
- `0 */6 * * *` — every 6 hours

**Recommendation:** during sales, restocks are often brief (a returned/cancelled unit
reappears for minutes). More frequent = better catch rate, and it's free. 15–30 min is a good
sweet spot; 6h will miss most return-driven restocks.

## Watching more than one product
Duplicate the repo, or extend `SIZES`/`PRODUCT_URL`. (For multiple products at once, ask and
I'll add a small `products.json` loop.)

## Run it locally instead (quick test)
Requires Node 18+ and **Google Chrome installed**:
```bash
npm install
npx playwright install chromium   # fallback browser; real Chrome is used automatically
EMAIL_TO=you@gmail.com GMAIL_USER=you@gmail.com GMAIL_APP_PASSWORD=xxxx node check.js
```
Without the email vars it just prints stock status to the terminal.

## Notes / limitations
- Relies on GitHub's Ubuntu runners having Google Chrome preinstalled (they do).
- If Zara ever blocks GitHub's data-center IPs, the run logs will show `HTTP 403`; ping me and
  we'll add a proxy or switch to a residential runner.
- Zara doesn't guarantee restocks — some sold-out items never return. This maximizes your odds
  of catching one if it does.
