# Free LLM API Discovery

Find AI model APIs you can use for free. The site searches the web for free LLM APIs, tests the ones that need no key, checks a curated list of providers every day, and shows you how to set each one up, including a key test that runs in your own browser. A test chat and an OpenAI-compatible API let you try the working models. Everything runs on free tiers.

**Live demo:** https://unicorndy.github.io/free-llm-api-discovery/

To run your own copy on your own GitHub and Cloudflare accounts, follow **[SETUP.md](SETUP.md)**. To see how it's protected, read **[SECURITY.md](SECURITY.md)**.


---

## Architecture

```
                 ┌──────────────────────────── GitHub Pages (public site repo) ────────────────────────────┐
                 │ index.html  Discovery: directory.json + providers.json + live web results + setup guides │
 Visitor ───────►│ chat.html   Test chat          api.html  API guide                                       │
    │            │ Daily Action 03:17 UTC: scripts/discover.mjs tests models → commits providers.json       │
    │            └───────────────────────────────────────────────┬─────────────────────────────────────────┘
    │ /discover, /chat, /search                                   │ /v1/* with the site's API key
    ▼                                                             ▼
 ┌───────────────────────────── Cloudflare Worker "search-chat" ─────────────────────────────┐
 │ origin lock or API key · rate limits · size caps · Llama Guard · provider keys as secrets  │
 │ discover.js: web search → AI extraction → URL validation → keyless auto-test → KV (6-hourly)│
 └───────┬──────────────────────────────┬──────────────────────────────┬────────────────────┘
         │ chat                         │ search                        │ results
         ▼                              ▼                               ▼
   Workers AI · Groq ·           Tunnel → nginx (key + rate) →     KV "DISCOVERY"
   OpenRouter · NVIDIA ·         SearXNG (your server, Docker,     (shared by all visitors)
   community/* (opt-in)          no open ports) · Tavily fallback
```

**Discovery (the main feature).** The home page combines three sources:

1. **Curated directory** (`site/directory.json`): well-known free providers with official sign-up and key pages, API base URL, an example model, the free-tier summary, whether they train on your data, and whether browsers may call them.
2. **Daily model tests** (`providers.json`): the GitHub Action lists each vetted provider's free models, sends each one a "pong" test through the Worker, and records which ones work.
3. **Live web search** (**Run discovery**, which calls the Worker's `POST /discover` and streams progress):
   - It runs six searches through SearXNG.
   - Workers AI reads the results and lists free LLM API providers.
   - Every link must be `https` and on a domain that appeared in the results; anything without a confirmed website or API address is dropped.
   - Keyless OpenAI-compatible endpoints are auto-tested with a "pong" prompt, with timeouts, size caps and redirects not followed.
   - The result is stored in KV and shared by everyone. A new live run happens at most every 6 hours (`DISCOVERY_INTERVAL_HOURS`); in between, the page shows the most recent run and when the next one is due.

Each provider card has a **setup guide**: sign up, get a key, curl/Python/JavaScript snippets, and a **key test that runs in the visitor's browser**, so the key goes straight to the provider and never to this site. There's also a **Try it in the test chat** link.

**Web-found providers that work without a key** become selectable as `community/<id>/<model>` in the test chat and the API. They're never used by **Automatic**, so a prompt only goes to an unknown service when someone chooses it.

**How a chat question is answered**

1. The browser decides whether the question needs a search. If it does, it asks the Worker's `/search` in parallel with Wikipedia and DuckDuckGo.
2. The Worker's `/search` asks SearXNG first. Tavily (1,000 credits a month) is only used for time-sensitive questions when SearXNG returns fewer than 3 results.
3. The browser sends the question plus the numbered results, labelled as untrusted, to the Worker's `/chat`.
4. The Worker runs Llama Guard, then tries providers in `PROVIDER_ORDER` (Groq → Workers AI → OpenRouter → NVIDIA), using the models discovery marked as working: the default first, then bigger models, very slow ones last.
5. The reply says which provider and model answered. The page shows it in the header pill and under each answer.

**Files**

| Path | Purpose |
| --- | --- |
| `site/index.html`, `home.js`, `home.css`, `directory.json` | Discovery home page and the curated provider directory |
| `site/chat.html`, `app.js`, `style.css` | Test chat. `config.js` holds the Worker URL |
| `site/api.html`, `api.js`, `api.css` | API guide page with a live free-model list |
| `site/scripts/discover.mjs`, `site/.github/workflows/discover.yml` | Daily model tests (only run in the site repo) |
| `worker/worker.js`, `worker/discover.js`, `worker/wrangler.toml` | The Worker, the web discovery engine, and non-secret settings (incl. the KV binding) |
| `searxng/` | Docker Compose stack: SearXNG, nginx gate (key check + rate limit), cloudflared. Settings and secrets in `searxng/.env` |
| `SETUP.md`, `SECURITY.md` | Setup guide for your own accounts; security walkthrough |
| `setup.mjs`, `lib/`, `ui/` | Guided setup assistant (needs someone at a screen). Deploys the Worker with discovery storage and the site; the daily model tests still need SETUP.md step 8 |

---

## How to use it

### Discover free APIs

Open the home page. The curated providers and today's test results load instantly. Press **Run discovery** to search the web for more. Filter by **No key needed**, **Working now** or **Doesn't train on your data**, open a provider's **Setup guide**, test your key in the browser, then **Try it in the test chat**.

### Test chat

Web search is on **Auto**; switch it to **Always** or **Off** under the input box. **Settings** lets you pick **This site's server** (Automatic, or any checked model), **Pollinations**, **OpenRouter** with your own key, or any OpenAI-compatible endpoint. Links from the discovery page preselect the model.

### The API, from your other projects

Full guide with copy buttons: [api.html](https://YOUR-USERNAME.github.io/YOUR-SITE-REPO/api.html). In short:

```bash
export SEARCH_CHAT_API_KEY="$(cat ~/.config/search-chat/api-key)"   # see SETUP.md step 6

curl https://search-chat.YOUR-SUBDOMAIN.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer $SEARCH_CHAT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello!"}]}'
```

- **Endpoints:** `POST /v1/chat/completions`, `POST /v1/search`, `GET /v1/models`, `POST /v1/discover` (`{"force": true}` starts a fresh web search).
- **Model:** `auto`, a provider id (`groq`), an exact `provider/model`, or a `community/<id>/<model>` from `/v1/models`.
- **Limits:** 30 requests a minute per key. Server side only (no CORS).

---

## Setup guide

**To deploy your own copy on your own accounts, follow [SETUP.md](SETUP.md).** It covers:
- Accounts and logins, including servers without a browser.
- The values to change for your deployment.
- The Worker, provider keys, API keys and GitHub Pages.
- Daily discovery, optional SearXNG, final checks and troubleshooting.


---

## Day-to-day tasks

| Task | How |
| --- | --- |
| **Add an AI provider** | Cloudflare dashboard → Workers & Pages → search-chat → Settings → Variables and Secrets → add `GROQ_KEY` / `OPENROUTER_KEY` / `NVIDIA_KEY` as a **Secret**. It works immediately; discovery lists its models on the next run. |
| **Run the daily model tests now** | `gh workflow run discover.yml -R YOUR-USERNAME/YOUR-SITE-REPO` (or the Actions tab → Run workflow) |
| **Force a fresh web search** | `curl -N -X POST https://search-chat.YOUR-SUBDOMAIN.workers.dev/v1/discover -H "Authorization: Bearer $(cat ~/.config/search-chat/api-key)" -H 'Content-Type: application/json' -d '{"force":true}'` |
| **Add or fix a curated provider** | Edit `site/directory.json` (official URLs only), then copy it to the site repo |
| **Add or revoke an API key** | Edit the `API_KEYS` secret (comma-separated) in the dashboard. Your own key is in `~/.config/search-chat/api-key` (SETUP.md step 6). |
| **Change provider order or default models** | `[vars]` in `worker/wrangler.toml` (`PROVIDER_ORDER`, `GROQ_MODEL`, `WORKERS_AI_MODEL`, …), then `npx wrangler deploy` |
| **Update the website** | Edit `site/` here, then copy the changed files into a clone of the site repo and push. Never copy `providers.json` over the site repo's, because the bot owns it there. |
| **SearXNG logs, restart, update** | `cd searxng && sudo docker compose logs -f searxng` · `sudo docker compose restart` · `sudo docker compose pull && sudo docker compose up -d` |
| **See what went wrong** | `curl -s https://search-chat.YOUR-SUBDOMAIN.workers.dev/v1/logs -H "Authorization: Bearer $(cat ~/.config/search-chat/api-key)" \| jq '.issues[:20]'`: the last 100 issues, newest first. Full console logs: Cloudflare dashboard → Workers & Pages → search-chat → Logs, or `npx wrangler tail`. |
| **Is everything up?** | `SITE_URL=https://YOUR-USERNAME.github.io/YOUR-SITE-REPO/ WORKER_URL=https://search-chat.YOUR-SUBDOMAIN.workers.dev scripts/smoke-live.sh` (add `SEARXNG_URL` and `SITE_REPO` for the full 27 checks), plus `npm test` (offline) |

---

## Security

**[SECURITY.md](SECURITY.md) explains the security design, with pointers into the code:**
- Where each secret lives and why it can't leak.
- The origin lock and API keys.
- Rate limits and size caps.
- The browser protections: CSP, escaping, safe links and prompt-injection guards.
- The SearXNG key gate and the discovery workflow's permissions.
- The known limits, and how to rotate every secret.

---

## Free-tier facts (researched Sept 2026; verify before relying on them)

- **Workers AI:** 10,000 neurons a day; several newer models (GLM 5.x, Kimi, DeepSeek v4) are paid-plan only.
- **Workers:** 100,000 requests a day, 10 ms CPU per request.
- **Groq:** about 30 requests a minute and 1,000 a day per model.
- **OpenRouter free:** 20 a minute; 50 a day under $10 lifetime credit, 1,000 after. Free models rotate without warning.
- **NVIDIA:** one-time credits, no CORS.
- **Tavily:** 1,000 credits a month.
- **GitHub Actions:** scheduled workflows switch off after 60 days without activity; the discovery workflow re-enables itself.

## Setup assistant (original, optional)

`npm install && npx playwright install chromium && npm run setup` opens a local guided assistant, on `127.0.0.1` with a session code. It collects keys in a real browser window, deploys the Worker (with its discovery module and KV storage) and publishes the site. It doesn't set up SearXNG or the daily model tests: use SETUP.md steps 8 and 9 for those. It needs someone physically at a screen; on this headless server, use the CLI steps above instead.

## License

[MIT](LICENSE)
