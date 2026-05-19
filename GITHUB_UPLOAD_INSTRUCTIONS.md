# GitHub Upload Instructions

These steps publish the project source code safely. Do not upload private keys, `.env.local`, `wrangler.toml`, `node_modules`, build folders, or local caches.

## 1. Create The Repository

1. Open GitHub.
2. Create a new empty repository named `RitualPayrollScheduler`.
3. Do not add GitHub's README, `.gitignore`, or license during creation because this folder already has project files.

## 2. Check Local Files

From the project folder:

```bash
cd /Users/home/Documents/Codex/2026-05-03/create-a-new-project-folder-and/RitualPayrollScheduler
git init
git status
```

`git status` should not show:

- `frontend/.env.local`
- `automation/cloudflare-worker/wrangler.toml`
- `node_modules`
- `frontend/.next`
- `frontend/out`
- `contracts/out`
- `contracts/cache`
- private keys

## 3. Commit And Push

Replace `<your-github-username>` with your GitHub username.

```bash
git add .
git status
git commit -m "Initial Ritual Payroll Scheduler MVP"
git branch -M main
git remote add origin https://github.com/<your-github-username>/RitualPayrollScheduler.git
git push -u origin main
```

If GitHub asks you to authenticate, use your normal GitHub login flow or a GitHub personal access token.

## 4. Frontend Setup After Clone

```bash
npm --prefix frontend install
cp frontend/.env.example frontend/.env.local
```

Edit `frontend/.env.local` and set:

```text
NEXT_PUBLIC_AUTOMATION_API_URL=https://ritual-payroll-scheduler-automation.pushkin-evgenii01.workers.dev
```

Then run:

```bash
npm run build:frontend
npm --prefix frontend run dev -- --hostname 127.0.0.1 --port 3029
```

Open:

```text
http://127.0.0.1:3029/
```

## 5. Cloudflare Worker Setup After Clone

Only the project owner does this. Normal users never touch Cloudflare.

```bash
npm --prefix automation/cloudflare-worker install
cp automation/cloudflare-worker/wrangler.example.toml automation/cloudflare-worker/wrangler.toml
```

In `automation/cloudflare-worker/wrangler.toml`, fill your real Cloudflare KV namespace IDs locally. Do not commit this file.

Set Worker secrets in Cloudflare/Wrangler. Never paste private keys into the frontend or GitHub:

```bash
cd automation/cloudflare-worker
npx wrangler secret put KEEPER_PRIVATE_KEY
npx wrangler secret put RITUAL_RPC_URL
npm run deploy
```

The keeper private key must be a separate keeper wallet, not the owner wallet.

## 6. Final Demo Checklist

1. Connect wallet.
2. Switch to Ritual Chain `1979`.
3. Deploy payroll contract.
4. Confirm automation says `Contract registered`.
5. Fund payroll with enough RITUAL for all due payouts.
6. Fund execution balance for keeper rewards.
7. Add custom payout entries.
8. Wait for the hosted worker schedule.
9. Click `Refresh automation status`.
10. Confirm completed payouts move into Payment history with explorer links.

## 7. Safe To Upload

Upload source files such as:

- `contracts/`
- `frontend/app/`, `frontend/components/`, `frontend/lib/`, `frontend/public/`
- `frontend/package.json` and lockfile if present
- `automation/cloudflare-worker/src/`
- `automation/cloudflare-worker/package.json`
- `automation/cloudflare-worker/wrangler.example.toml`
- `README.md`
- `package.json`
- `.gitignore`

Do not upload generated or secret files. The `.gitignore` protects the common dangerous folders and files.
