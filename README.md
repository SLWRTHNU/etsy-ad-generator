# Etsy Listing Assistant

A small web tool that takes a product photo + free-text notes and generates Etsy-ready listing copy (title, description, tags, category, attributes), plus the photo resized into three download-ready sizes (2000px / 1080px / 500px).

- **Frontend:** static HTML/CSS/vanilla JS in `public/` — no framework, no build step.
- **Backend:** one Cloudflare Pages Function (`functions/api/generate.js`) that calls the Claude API server-side.
- **Storage:** none — everything happens in the browser session and is discarded on refresh.

## Local development

```sh
npx wrangler pages dev public --compatibility-date=2026-09-01
```

This serves `public/` and runs `functions/api/generate.js` locally. Set your API key first:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
```

(On Windows PowerShell: `$env:ANTHROPIC_API_KEY = "sk-ant-..."`)

## Deploying to Cloudflare Pages

### 1. Connect the repo

Push this repo to GitHub, then in the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to Git**, pick the repo, and set:

- Build command: *(none)*
- Build output directory: `public`

Every push to `main` will auto-deploy.

### 2. Set the `ANTHROPIC_API_KEY` secret

In the Cloudflare dashboard: **your Pages project → Settings → Environment variables → Add variable**, name it `ANTHROPIC_API_KEY`, set the value to your Anthropic API key, and mark it **Encrypt** (this makes it a secret, not a plaintext var). Do this for both the **Production** and **Preview** environments if you want preview deploys to work too.

The function reads it via `env.ANTHROPIC_API_KEY` — never commit a key to the repo.

Docs: https://developers.cloudflare.com/pages/functions/bindings/#environment-variables

### 3. Set up Cloudflare Access (email allowlist)

This app has no login UI by design — access control is handled entirely by Cloudflare Access in front of the Pages deployment:

1. In the Cloudflare dashboard, go to **Zero Trust → Access → Applications → Add an application → Self-hosted**.
2. Point it at your Pages project's domain.
3. Add a policy with **Include → Emails** listing the specific email addresses allowed to use the tool (or an email domain, if you want to allow everyone at a domain).

Docs: https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/

## Notes

- Etsy's title/tag/category rules are baked into the system prompt in `functions/api/generate.js`. Etsy's specs can change — if listings start looking off, that prompt is the first place to check against current Etsy seller guidance.
- There's no rate limiting beyond Cloudflare Access. See the comment at the top of `functions/api/generate.js` for where to add it if abuse becomes a concern.
