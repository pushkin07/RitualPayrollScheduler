# Upload By Browser

This folder is ready to upload to GitHub manually.

## What To Upload

Upload the contents of this prepared folder:

```text
RitualPayrollScheduler_GitHub_Upload
```

Or upload this archive:

```text
RitualPayrollScheduler_GitHub_Upload.zip
```

## Browser Steps

1. Open GitHub.
2. Create a new empty repository named `RitualPayrollScheduler`.
3. Open the new repository page.
4. Click `uploading an existing file`.
5. Drag all files and folders from `RitualPayrollScheduler_GitHub_Upload` into GitHub.
6. Click `Commit changes`.

## Do Not Upload

These were intentionally excluded:

- private keys
- `frontend/.env.local`
- `automation/cloudflare-worker/wrangler.toml`
- `node_modules`
- `.next`
- `out`
- `dist`
- `contracts/out`
- `contracts/cache`
- local Codex/Foundry cache folders

## After Upload

The repository should contain source code only. Secrets stay local or inside Cloudflare secrets.
