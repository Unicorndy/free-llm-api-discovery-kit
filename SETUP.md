# Set up your own Free LLM API Discovery

This guide deploys your own copy on **your own accounts**: the discovery website (live web search for free LLM APIs, a curated directory, setup guides and a browser key test), the test chat, the AI server and its API, and the daily model tests. Everything uses free tiers. Allow about 45 minutes.

In the commands, replace the placeholders:

| Placeholder | Example | What it is |
| --- | --- | --- |
| `<you>` | `janedoe` | Your GitHub username |
| `<site-repo>` | `search-chat` | Name of the public repo for your website |
| `<subdomain>` | `janedoe` | Your Cloudflare `workers.dev` subdomain |
| `<search.example.com>` | `search.janedoe.dev` | Optional: a hostname on your own domain for SearXNG |

Your site ends up at `https://<you>.github.io/<site-repo>/` (discovery), with the test chat at `chat.html`, and your server at `https://search-chat.<subdomain>.workers.dev`.

---

## What you need

**Required (free):**
- A **GitHub** account.
- A **Cloudflare** account.
- A computer with **Node.js 20+**, **git** and the **GitHub CLI** (`gh`).

**Optional:**
- **AI provider keys.** Workers AI works without any key. Adding keys gives more models and fallbacks: [Groq](https://console.groq.com/keys), [OpenRouter](https://openrouter.ai/keys), [NVIDIA](https://build.nvidia.com), and [Tavily](https://app.tavily.com) for news search.
- **Private web search (SearXNG).** A Linux machine with Docker that stays on (a home server or a small VPS), plus a domain managed in your Cloudflare account. **Live web discovery needs it.** Without it, the discovery page still shows the curated directory and the daily model tests, and chat search uses Wikipedia, DuckDuckGo and, if you add a key, Tavily.

---

## 1. Get the code

```bash
git clone https://github.com/Unicorndy/free-llm-api-discovery-kit.git
cd free-llm-api-discovery-kit
```

The repo has these parts:
- `site/`: the website.
- `worker/`: the AI server.
- `searxng/`: optional private search.
- `site/scripts/` and `site/.github/`: model discovery.

## 2. Log in to GitHub and Cloudflare

**GitHub:**

```bash
gh auth login                               # choose GitHub.com, HTTPS, "Login with a web browser"
gh auth refresh -h github.com -s workflow   # lets you push the discovery workflow file
gh auth setup-git
```

On a machine without a browser, `gh` prints a code. Open github.com/login/device on any device and enter it.

**Cloudflare:** choose one.
- **With a browser on this machine:** `npx wrangler login`.
- **Headless server:** go to dash.cloudflare.com/profile/api-tokens → **Create Token** → template **Edit Cloudflare Workers** → create. Then:
  ```bash
  echo 'export CLOUDFLARE_API_TOKEN=<token>' >> ~/.zshrc   # or ~/.bashrc
  chmod 600 ~/.zshrc && source ~/.zshrc
  npx wrangler whoami                                        # shows your account
  ```
  `wrangler login` can't work on a headless machine: after you approve, it redirects to `localhost`, which only exists on the machine itself.

## 3. Put your own values in the config

Only these values are specific to one deployment. The API guide page reads the server address from `site/config.js`, so it needs no edits.

| File | Setting | Set it to |
| --- | --- | --- |
| `worker/wrangler.toml` | `ALLOWED_ORIGIN` | `https://<you>.github.io` (scheme and host only, no path) |
| `worker/wrangler.toml` | `CATALOG_URL` | `https://<you>.github.io/<site-repo>/providers.json` |
| `worker/wrangler.toml` | `SEARXNG_URL` | `https://<search.example.com>`, or delete the line if you skip SearXNG |
| `worker/wrangler.toml` | `[[kv_namespaces]]` `id` | The id printed by `wrangler kv namespace create DISCOVERY` (step 4) |
| `site/config.js` | `workerUrl` | Your Worker URL (you get it in step 4) |

## 4. Deploy the AI server (Cloudflare Worker)

```bash
cd worker
npx wrangler kv namespace create DISCOVERY   # copy the printed id into wrangler.toml ([[kv_namespaces]])
npx wrangler deploy
```

The `DISCOVERY` KV namespace stores the latest web discovery results, shared by all visitors. The free plan's KV limits are plenty, because a live search runs at most once an hour.

**First time only:** if wrangler says you need a `workers.dev` subdomain, pick one in the dashboard (Workers & Pages → your subdomain), or register it through the API:

```bash
ACCOUNT_ID=$(npx wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1)
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/subdomain" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  --data '{"subdomain":"<subdomain>"}'
npx wrangler deploy
```

A new subdomain's HTTPS certificate takes a minute or two. Then check it:

```bash
curl https://search-chat.<subdomain>.workers.dev/health
# {"ok":true,"providers":["workers-ai"],...}
```

Put that URL into `site/config.js` as `workerUrl`.

## 5. Add AI provider keys (optional)

Each key is stored as an **encrypted Worker secret**. It never goes into a file or the repo.

```bash
npx wrangler secret put GROQ_KEY          # paste the key at the prompt
npx wrangler secret put OPENROUTER_KEY
npx wrangler secret put NVIDIA_KEY
npx wrangler secret put TAVILY_KEY
```

You can also add them in the dashboard: Workers & Pages → search-chat → Settings → Variables and Secrets → **Add** → type **Secret**. `/health` shows which providers are active.

## 6. Create an API key for your own projects

This key lets your other projects call the API, and the discovery job uses it too.

```bash
mkdir -p ~/.config/search-chat && chmod 700 ~/.config/search-chat
( umask 077; printf 'sc_%s' "$(openssl rand -hex 24)" > ~/.config/search-chat/api-key )
tr -d '\n' < ~/.config/search-chat/api-key | npx wrangler secret put API_KEYS
```

`API_KEYS` holds one or more keys separated by commas. Give each project its own key so you can revoke one without breaking the others.

## 7. Publish the website (GitHub Pages)

The website is a **separate public repo** that holds a copy of `site/`. The kit repo stays the source.

```bash
cd ..                                   # back to the kit root
cp -r site /tmp/<site-repo> && cd /tmp/<site-repo>
git init -b main && git add -A && git commit -m "Search Chat site"
gh repo create <site-repo> --public --source=. --push
gh api -X POST repos/<you>/<site-repo>/pages -f "source[branch]=main" -f "source[path]=/"
```

After a minute or two, open `https://<you>.github.io/<site-repo>/`, ask a question, and check the "Answered by" line under the reply.

## 8. Turn on daily model discovery

The workflow is in the site repo already (`.github/workflows/discover.yml`). It needs one secret, your API key from step 6:

```bash
tr -d '\n' < ~/.config/search-chat/api-key | gh secret set SEARCH_CHAT_API_KEY -R <you>/<site-repo>
gh workflow run discover.yml -R <you>/<site-repo>
gh run watch -R <you>/<site-repo>
```

When it finishes, the site repo has a `providers.json`. Your server starts using it within an hour, and the Settings dialog and the API page list the working models. After that it runs every day at 03:17 UTC.

## 9. Private web search with SearXNG (optional)

It runs in Docker on your machine and is reached only through a Cloudflare Tunnel, so **no ports are opened**. A small nginx gate rejects every request without your secret key and caps all searches at `SEARXNG_RATE` (default 30 a minute). The Worker also enforces a daily budget, `SEARXNG_DAILY_LIMIT` in `wrangler.toml` (default 300).

```bash
# One-time: authorize cloudflared for your domain (prints a URL to open and approve)
cloudflared tunnel login
cloudflared tunnel create searxng                 # prints the tunnel ID and writes ~/.cloudflared/<ID>.json
cloudflared tunnel route dns searxng <search.example.com>

cd searxng
cp .env.example .env && chmod 600 .env
# Edit .env: SEARXNG_HOSTNAME, TUNNEL_ID, TUNNEL_CREDENTIALS (the .json path), UID_GID (`id -u`:`id -g`),
# and fill SEARXNG_KEY and SEARXNG_SECRET with: openssl rand -hex 32
docker compose up -d                              # may need sudo

# Give the Worker the same key
grep '^SEARXNG_KEY=' .env | cut -d= -f2 | tr -d '\n' | (cd ../worker && npx wrangler secret put SEARXNG_KEY)
```

Check it: `curl https://<search.example.com>/` must return **403**. After that, `/health` on your Worker shows `"searxng": true`.

---

## 10. Final checks

- [ ] `npm test` passes (Worker tests, no network needed).

- [ ] `/health` lists your providers and `"api": true`.
- [ ] A POST to `/chat` with `-H "Origin: https://evil.example"` returns **403**.
- [ ] `/v1/models` with a wrong key returns **401**; with your key it lists models.
- [ ] The home page lists the curated providers, and **Run discovery** streams progress (needs SearXNG).
- [ ] A provider's **Setup guide** opens, and **Test my key** runs from your browser.
- [ ] The test chat answers and shows "Answered by …".
- [ ] The discovery run is green and `providers.json` exists.
- [ ] (SearXNG) The hostname returns 403 without the key.
- [ ] `git status` in the kit shows no `.env` and no key files. They're gitignored, but check anyway.

Then read [SECURITY.md](SECURITY.md) to see what protects your deployment and what doesn't.

## Updating later

- **Curated providers:** edit `site/directory.json`. Use official URLs only, and verify free-tier details on the provider's site.
- **Website:** edit `site/` in the kit, copy the changed files into your site repo clone, and push. **Don't** copy `providers.json` over the site repo's copy: the discovery bot owns it there.
- **Server:** edit `worker/`, then `npx wrangler deploy`.
- **SearXNG:** `docker compose pull && docker compose up -d`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `wrangler login` hangs or "port 8976 in use" | Headless machine: use `CLOUDFLARE_API_TOKEN` (step 2). Kill the leftover `wrangler login` process. |
| `curl` to the new Worker fails with HTTP 000 | The certificate for a new subdomain is still being issued. Wait 1–2 minutes. |
| The site says "This server only answers requests from its own website" | `ALLOWED_ORIGIN` must exactly match `https://<you>.github.io`, with no trailing slash or path. |
| Pushing the workflow is refused ("without `workflow` scope") | `gh auth refresh -h github.com -s workflow` |
| Discovery marks a Workers AI model "not available on the Workers Free plan" | Expected: that model is paid-only. It's skipped automatically. |
| SearXNG returns results but DuckDuckGo is missing | Data-center IPs get CAPTCHAs from some engines. Other engines (Brave, Google) keep working. |
| The site still shows an old version | Browser cache: reload, or add `?v=2` to the URL. |
