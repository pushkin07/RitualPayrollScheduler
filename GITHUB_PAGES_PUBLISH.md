# Publish With GitHub Pages

Use this when you want the site link from GitHub, not Vercel.

## Files To Add To GitHub

Upload these new/updated files to your GitHub repository:

```text
.github/workflows/deploy-github-pages.yml
frontend/next.config.mjs
```

## Turn On GitHub Pages

1. Open your GitHub repository.
2. Go to `Settings`.
3. Open `Pages`.
4. In `Build and deployment`, choose:
   - Source: `GitHub Actions`
5. Save.

## Run Deployment

After the files are uploaded:

1. Open the `Actions` tab in GitHub.
2. Open `Deploy GitHub Pages`.
3. Click `Run workflow`.
4. Wait until it becomes green.

## Your Site Link

The public site will be:

```text
https://YOUR_GITHUB_USERNAME.github.io/RitualPayrollScheduler/
```

Replace `YOUR_GITHUB_USERNAME` with your GitHub username.

## Important

The frontend uses this Worker URL:

```text
https://ritual-payroll-scheduler-automation.pushkin-evgenii01.workers.dev
```

No private key is stored in GitHub. The keeper private key stays only in Cloudflare Worker secrets.
