# Ritual Payroll Scheduler Automation Worker

This Cloudflare Worker is the hosted keeper backend for real payroll automation.

## Confirmed Capabilities

- `POST /register` stores payroll contract registrations.
- `GET /registrations` returns stored registrations for debugging.
- A scheduled cron handler runs every 15 minutes.
- Registrations are stored in one Cloudflare KV value through the `REGISTRY_KV` binding.
- The worker uses `viem`, `createPublicClient`, `createWalletClient`, and `privateKeyToAccount`.
- The keeper key is server-side only through `KEEPER_PRIVATE_KEY`.
- The worker only calls `executeDuePayments()`.
- Cron checks use one registry KV key, avoid KV writes when the observed result is unchanged, and throttle `lastObservedAt` to at most once every 6 hours per contract.

Cloudflare KV's free plan is intentionally small. This MVP uses one registry KV key and a 15-minute cron schedule to stay below the free daily operation limit. For near-real-time payroll execution, use a paid Cloudflare plan or a dedicated keeper service.

The worker does not add recipients, withdraw funds, change keeper rewards, access the owner wallet, or change payroll settings.

## API

### Register Payroll

```http
POST /register
Content-Type: application/json
```

Request:

```json
{
  "contractAddress": "0x...",
  "ownerAddress": "0x...",
  "payrollName": "Core Contributors",
  "chainId": 1979
}
```

Success response:

```json
{
  "ok": true,
  "registered": true,
  "contractAddress": "0x...",
  "ownerAddress": "0x...",
  "chainId": 1979
}
```

Error response:

```json
{
  "ok": false,
  "error": "..."
}
```

### Debug Registrations

```http
GET /registrations
```

Development-only cleanup and migration endpoints are guarded by `ALLOW_DEV_CLEAR=true`:

```http
GET /clear-registrations-dev
GET /migrate-old-kv-dev
```

## Browser Setup In Cloudflare

Use the Cloudflare dashboard for account resources:

1. Open Cloudflare Dashboard.
2. Go to **Workers & Pages**.
3. Create a new Worker named `ritual-payroll-scheduler-automation`.
4. Go to **Storage & Databases** then **KV**.
5. Create a KV namespace named `ritual-payroll-scheduler-registry`.
6. Open the Worker settings.
7. Add a KV binding:
   - Variable name: `REGISTRY_KV`
   - KV namespace: `ritual-payroll-scheduler-registry`
8. Add environment variables / secrets:
   - `RITUAL_RPC_URL`
   - `KEEPER_PRIVATE_KEY`
9. Add a cron trigger:
   - `*/15 * * * *`
10. Save the Worker settings.

Because this worker imports `viem`, deploy the code with Wrangler so dependencies are bundled correctly.

## Manual Deploy With Wrangler

From `automation/cloudflare-worker`:

1. Install dependencies.
2. Copy `wrangler.example.toml` to `wrangler.toml`.
3. Replace `id` and `preview_id` with the KV namespace IDs from Cloudflare.
4. Add the keeper secret:

```bash
wrangler secret put KEEPER_PRIVATE_KEY
```

Use a separate keeper wallet. Do not use the payroll owner wallet.

5. Add the RPC URL secret:

```bash
wrangler secret put RITUAL_RPC_URL
```

Use:

```text
https://rpc.ritualfoundation.org
```

6. Build-check the Worker:

```bash
npm run build
```

7. Deploy:

```bash
npm run deploy
```

8. Copy the deployed Worker URL.

## Frontend Connection

Set the frontend environment variable:

```text
NEXT_PUBLIC_AUTOMATION_API_URL=<worker_url>
```

Then rebuild and restart the frontend. Once configured, clicking **Enable automation** registers the user payroll contract with the hosted Worker.

No private key belongs in the frontend. The user never sees, enters, or manages the keeper private key.
