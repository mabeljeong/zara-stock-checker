# Zara stock checker

Watches a Zara product page and **emails you** when sold-out sizes (default **XS, S, M**)
come back in stock. Runs **for free in the cloud via GitHub Actions**, so it works no matter
which laptop you're on (Mac or Windows) — or whether your laptop is even on.

Currently watching (see [products.json](products.json)):

| Product | Sizes |
|---------|-------|
| [Faux Leather Cropped Bomber Jacket](https://www.zara.com/us/en/faux-leather-cropped-bomber-jacket-p06318041.html?v1=495675486) | XS, S, M |
| [Multi-Pocket Cargo Pants](https://www.zara.com/us/en/multi-pocket-cargo-pants-p03607021.html?v1=503389715) | 25 (US 0) |

## How it works

1. Every 15 minutes, GitHub runs `check.js` on its own servers.
2. For each product in `products.json` the script opens the Zara page in **real headless
   Chrome** (Zara blocks plain bots; real Chrome gets through) and reads the live stock
   status for each size.
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

No repo **Variables** are needed — the watch list lives in `products.json`.

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

## Adding / removing products
Edit [products.json](products.json) and push. Each entry is:
```json
{
  "name": "Multi-Pocket Cargo Pants",
  "url": "https://www.zara.com/us/en/multi-pocket-cargo-pants-p03607021.html?v1=503389715",
  "sizes": ["25"]
}
```
Sizes match loosely, so for a label like `25 (US 0)` any of `"25"`, `"US 0"`, or the full
`"25 (US 0)"` works. If a size can't be matched the log prints `not_found` along with every
size the page actually offers, so you can copy the right one.

To see all sizes on the pages you're watching:
```bash
node check.js --list
```

## Run it locally instead (quick test)
Requires Node 18+ and **Google Chrome installed**:
```bash
npm install
npx playwright install chromium   # fallback browser; real Chrome is used automatically
EMAIL_TO=you@gmail.com GMAIL_USER=you@gmail.com GMAIL_APP_PASSWORD=xxxx node check.js
```
Without the email vars it just prints stock status to the terminal.

To check a one-off product without touching `products.json`, the old env vars still work:
```bash
PRODUCT_URL='https://www.zara.com/...' SIZES='S,M' node check.js
```

## Notes / limitations
- Relies on GitHub's Ubuntu runners having Google Chrome preinstalled (they do).
- If Zara ever blocks GitHub's data-center IPs, the run logs will show `HTTP 403`; ping me and
  we'll add a proxy or switch to a residential runner.
- Zara doesn't guarantee restocks — some sold-out items never return. This maximizes your odds
  of catching one if it does.
