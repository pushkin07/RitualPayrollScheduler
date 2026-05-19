# Ritual Payroll Scheduler

Ritual Payroll Scheduler is a user-facing Ritual Chain testnet dApp for scheduled contributor payouts.

Users deploy their own `PayrollScheduler` contract, add payout entries, fund payroll with testnet RITUAL, fund an automation fee balance, and enable hosted automation. Due payments can then be executed by a hosted keeper without asking the owner to approve every payout.

## What The dApp Does

- Connects a browser wallet to Ritual Chain `1979`.
- Deploys a user-owned payroll contract.
- Adds recipients with one-time, daily, weekly, monthly, or custom date/time schedules.
- Supports multiple same-day custom payout entries for the same recipient.
- Lets the owner fund payroll funds and automation execution fees separately.
- Registers the deployed contract with a hosted automation worker.
- Keeps manual `Execute Due Payments` as a fallback.
- Shows transaction hashes and explorer links for user and backend transactions.

## Automation Model

A smart contract cannot start transactions by itself. Automation is handled by a hosted keeper worker.

- The frontend never stores or asks for private keys.
- The user wallet is only used for user-approved actions such as deploy, add recipient, fund, or manual execute.
- The hosted keeper uses its own server-side wallet.
- The keeper can only call `executeDuePayments()`.
- The keeper cannot withdraw funds, edit recipients, change owner settings, or access the owner wallet.
- The payroll contract only pays recipients whose payment time is due.
- The owner funds an automation fee balance so successful executions can reimburse the keeper from the payroll contract.

Set the hosted worker URL in the frontend environment:

```text
NEXT_PUBLIC_AUTOMATION_API_URL=<worker_url>
```

Developer diagnostics are hidden by default. To show backend health, run-once, and raw JSON panels locally:

```text
NEXT_PUBLIC_SHOW_AUTOMATION_DIAGNOSTICS=true
```

## Funding Model

The contract holds native RITUAL, but the UI presents two logical pools:

- **Payroll funds**: reserved for recipient payouts.
- **Automation fee balance**: reserved for execution fees after real payout execution.

The dashboard currently shows a browser-tracked view of balances and history based on successful transactions from this browser session. The on-chain writes are real. For a production version, the dashboard should rebuild recipients and payment history from contract events or an indexer so it can recover state after browser storage is cleared.

## Demo Flow

1. Open the frontend and connect MetaMask.
2. Switch to Ritual Chain `1979`.
3. Deploy a payroll contract.
4. Confirm the Automation section shows `Contract registered`.
5. Fund payroll, for example `0.04 RITUAL`.
6. Fund the automation fee balance, for example `0.03 RITUAL`.
7. Set the fee paid per successful execution, for example `0.01 RITUAL`.
8. Add custom payout entries for near-future times.
9. Wait for the hosted keeper schedule.
10. Click `Refresh automation status`.
11. Confirm:
    - `Last automated execution succeeded`
    - receipt is `success`
    - recipients are marked paid/inactive
    - payment history contains explorer links

## Explorer Verification

Use the transaction links shown in the UI:

- deploy tx
- fund payroll tx
- fund automation fee balance tx
- add recipient tx
- backend execute tx

Explorer:

```text
https://explorer.ritualfoundation.org
```

## Local Commands

```bash
npm run test:contracts
npm run build:contracts
npm --prefix frontend install
npm run build:frontend
npm --prefix frontend run dev -- --hostname 127.0.0.1 --port 3029
```

## Worker

The Cloudflare Worker lives in:

```text
automation/cloudflare-worker
```

It exposes:

- `GET /`
- `GET /health`
- `GET /registrations`
- `GET /run-once`
- `POST /register`
- `POST /unregister`

Normal users do not open these URLs. The frontend registers deployed contracts automatically after deploy.

The Worker stores all registrations under one KV key to reduce free-tier KV usage and runs cron every 15 minutes for the MVP. For near-real-time execution, use a paid plan or a dedicated keeper service.

Never commit keeper private keys. Configure the Worker secret server-side:

```bash
wrangler secret put KEEPER_PRIVATE_KEY
wrangler secret put RITUAL_RPC_URL
```
