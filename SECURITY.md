# Security

This page explains how the code protects keys, users and your free quotas, where each protection lives, and what it does **not** protect against. Line numbers are approximate; search for the function name if the code has moved.

## Threat model in one paragraph

The site is a **free public service**, so anyone may use the chat. The things worth protecting are:

1. **Your provider keys and other secrets:** they must never reach a browser, a repo or a log.
2. **Your free quotas:** strangers shouldn't be able to drain them faster than a normal visitor.
3. **Visitors:** a malicious model reply or web page mustn't run code in their browser.
4. **Your server:** the SearXNG machine must not be open to the internet.
5. **Discovery results:** web pages and AI output are untrusted. They mustn't turn into phishing links, scripts, or requests to internal addresses.

The design assumes that **anything in the site repo or the browser is public**.

---

## 1. Where secrets live (and why they can't leak)

| Secret | Lives in | Never in |
| --- | --- | --- |
| `GROQ_KEY`, `OPENROUTER_KEY`, `NVIDIA_KEY`, `TAVILY_KEY` | Cloudflare **Worker secrets** (encrypted at rest, write-only in the dashboard) | Repo, website, responses, logs |
| `API_KEYS` (your API keys) | Worker secret; your copy in `~/.config/search-chat/api-key` (mode 600); GitHub Actions secret `SEARCH_CHAT_API_KEY` | Repo, website |
| `SEARXNG_KEY` | Worker secret; `searxng/.env` (mode 600, gitignored) | Repo, website |
| `SEARXNG_SECRET`, tunnel credentials | `searxng/.env`, `~/.cloudflared/` | Repo |
| Cloudflare / GitHub CLI tokens | Your shell profile (mode 600) / `~/.config/gh/hosts.yml` | Repo |

How the code keeps them there:

- **The Worker reads secrets only from `env`** and uses them only in outgoing `fetch` headers:
  - Provider calls: `openAICompatible` and `listOpenAIModels` (`worker/worker.js` ~L116–L135).
  - SearXNG: `searchSearxng` (~L328).
- **Responses never include `env` values.** `/health` returns only provider **names**, model ids and booleans (`worker/worker.js` ~L476–L490). Error messages are fixed strings or provider status codes (`HttpError`); unexpected errors are logged and the client gets a generic message (~L520).
- **`.gitignore`** excludes `searxng/.env`, `.wrangler/`, `node_modules/`, `.browser-profile/`, `.claude/settings.local.json` and `.playwright-mcp/`.
- **The discovery job** (`site/scripts/discover.mjs`) reads the key from `process.env` and only puts it in an `Authorization` header. It never prints it, and GitHub masks secrets in Actions logs anyway. It writes only model ids, timings and provider error text to `providers.json`.
- **Visitors' own keys** (OpenRouter or a custom endpoint in Settings) stay in their browser:
  - They're kept in `sessionStorage`, or in `localStorage` if the visitor ticks "Remember" (`site/app.js` `loadKey`/`saveKey`, ~L94–L104).
  - They're sent only to the provider the visitor chose, with `credentials: 'omit'`.

**What is public on purpose:** all of `site/`, including the Worker URL in `config.js`; `providers.json`; `/health`; and the SearXNG hostname. None of these grant access to anything.

---

## 2. Who can call the server

`worker/worker.js`, in the `fetch` handler (~L462–L525):

| Check | Code | Effect |
| --- | --- | --- |
| **Origin lock** | `isAllowedOrigin` (~L406) | Only `ALLOWED_ORIGIN` (your github.io site) gets CORS headers. Browsers on any other site can't call `/chat` or `/search`. Preflight (`OPTIONS`) from other origins gets 403 (~L474). |
| **API keys** | `validApiKey` (~L412) | `Authorization: Bearer <key>` is compared with every key in `API_KEYS` using **`crypto.subtle.timingSafeEqual`** (~L419), so response timing doesn't reveal how much of a key matched. A wrong key gets 401, and no key and no allowed origin gets 403 (~L498). |
| **Issue log** | `logIssue` | Problems are logged as JSON lines (Cloudflare Workers Logs), and the last 100 are kept in KV. Only API keys can read them (`GET /v1/logs`). Entries hold short, clipped text, never secrets. Browser reports (`POST /report`) are rate-limited like every request, clipped to 200 characters, and KV writes are batched (at most one every 10 seconds per instance). |
| **Route allow-list** | `ROUTES` (~L443) | Only listed method and path pairs exist. Everything else gets 404 before any work is done. Provider ids from requests are looked up with `Object.hasOwn`, so ids like `__proto__` or `constructor` can't reach built-in object properties. |
| **Key-only features** | `chat(..., trusted)` (~L216–L260), `provider-models` (~L508) | Only API-key callers may use `strict`, try **arbitrary** model ids, or list a provider's models. The website may only pick models that discovery has checked (~L240), so it can't be used to run expensive or unexpected models. |

**Important limit:** the `Origin` header proves nothing outside a browser. A script can send `Origin: https://<you>.github.io` and use `/chat` like a visitor. That's accepted for a public free site. Such a script still hits the per-IP rate limit and can't reach any key-only feature.

---

## 3. Protecting your free quotas

| Protection | Code |
| --- | --- |
| **Rate limit:** 15 requests a minute per visitor IP, 30 per API key | `withinRateLimit` (~L394), `RATE_LIMIT_PER_MIN` / `API_RATE_LIMIT_PER_MIN` (~L38) |
| **Request size:** 64 KB body cap. The body is read in pieces and cut off as soon as it passes the cap, even when a client sends no `Content-Length` | `MAX_BODY` (~L40), `readJson` (~L192) |
| **Conversation shape:** at most 40 messages; roles limited to system/user/assistant; 12,000 characters each and 60,000 in total | `cleanMessages` (~L200) |
| **Search rationing:** Tavily (1,000 credits a month) runs only for time-sensitive questions, and only when SearXNG returns fewer than 3 results. Results are cached for an hour. | `search` |
| **Daily SearXNG budget:** `SEARXNG_DAILY_LIMIT` (default 300) searches a day across chat and discovery, counted in KV across all Worker instances (approximate). Once it's used up, chat search skips SearXNG (the browser's Wikipedia and DuckDuckGo still work) and discovery shows the last results. `/health` shows `searxngToday`. | `takeSearchBudget` |
| **Live discovery pace:** at most one live web search every 6 hours for everyone (`DISCOVERY_INTERVAL_HOURS`), and one at a time (KV lock). Each run uses 6 searches from the daily budget, so visitors can trigger at most 24 discovery searches a day. | `intervalMs` in `discover.js` |
| **Browser-side limits:** a 4-second cooldown and 2,000-character messages | `COOLDOWN_MS`, `MAX_INPUT` (`site/app.js` ~L9–L10) |
| **Discovery budget:** a capped number of tests per provider per run; OpenRouter gets only 8 (its free tier allows 50 a day), spaced to stay under the API rate limit | `PROVIDERS[].limit`, `WORKER_SPACING_MS` in `discover.mjs` |

**Limit:** the rate-limit counters live in memory **per Worker instance**, so they aren't global. Many IPs, or traffic spread across data centers, can still use up a provider's daily quota; the next provider then takes over. For hard global limits, add Cloudflare's [Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) or [Turnstile](https://developers.cloudflare.com/turnstile/).

---

## 4. Protecting visitors (the browser side)

| Protection | Code |
| --- | --- |
| **Strict Content-Security-Policy:** only the site's own scripts run (no inline scripts, no `eval`); network calls must be same-origin or HTTPS; no plugins, no `<base>` changes, no form posts | `<meta http-equiv="Content-Security-Policy">` in `site/index.html` and `site/api.html` (line 7) |
| **Escape first, then add a little Markdown:** model output is fully HTML-escaped, and only then are a few safe tags added (code, bold, italic, links, lists). Code spans and links are set aside before bold and citation rules run, so nothing can be inserted inside a link. Patterns have length limits, so hostile input renders quickly. | `escapeHtml` (~L353), `renderInline` (~L356), `renderMarkdown` (~L403) in `site/app.js` |
| **Safe links:** Markdown links must match `https?://`, so `javascript:` and `data:` URLs can't become links. Every link gets `target="_blank" rel="noopener noreferrer nofollow"`. Search result URLs go through `safeUrl`, which allows only http(s). | `renderInline`, `safeUrl` (~L130) |
| **No framing (clickjacking):** GitHub Pages can't send `frame-ancestors` or `X-Frame-Options` headers, so each page's script breaks out of any frame, or hides the page if that's blocked. | top of `home.js`, `app.js`, `api.js` |
| **`nosniff`:** every JSON response from the Worker carries `X-Content-Type-Options: nosniff`. | `json()` in `worker.js` |
| **`innerHTML` only with escaped output:** the only `innerHTML` writes use `renderMarkdown` output (~L618, ~L644). Everything else, including the API page's model list, is built with `textContent`. | `site/app.js`, `site/api.js` |
| **Prompt-injection guard:** web results are sent under a heading that labels them untrusted, and the system prompt tells the model to ignore instructions inside them | `site/app.js` ~L263 and ~L606 |
| **Safety check:** Llama Guard screens **everything the model will read**: every message of every role (callers can send any system prompt or history) and the web results block. The text is joined and checked in overlapping 4,000-character windows, in parallel, so nothing hides behind filler, in another role, or across a window edge. Anything too large to screen is refused, not skipped. A refusal comes back as a normal reply. | `isUnsafe`, `chat()` |
| **Web results as a separate field:** the site sends search results in `sources`. The Worker validates them (at most 8; http(s) URLs only; lengths clipped), formats the "Web results (untrusted data)" block itself, and screens it too. | `cleanSources`, `chat()` |
| **Links can't hijack the chat:** a `chat.html?provider=custom&base=…` link first asks the visitor to confirm, naming the host. It applies only for that visit, never saved, and clears any key saved for the custom provider, so a key can't reach an address the visitor didn't choose. | URL preselect block, `linkOverride` in `site/app.js` | `isUnsafe` (`worker/worker.js` ~L174) |

**Limits:**
- **The safety check fails open** (~L185): if Workers AI is down, questions go through, and the system prompt and providers' own moderation still apply.
- **No filter is perfect:** keep the on-page disclaimer.
- **Visitors' messages go to third-party AI providers:** the page tells them not to share private information, and `providers.json` records each provider's known data-training policy.

---

## 5. Protecting the SearXNG server

| Protection | Where |
| --- | --- |
| **No open ports:** the Compose file publishes no host ports. The only way in is the outbound Cloudflare Tunnel run by the `cloudflared` container. | `searxng/docker-compose.yml` |
| **Key gate:** the nginx gate forwards to SearXNG only when the `X-Search-Key` header matches `SEARXNG_KEY`; everything else gets 403. The key check runs before the rate limit, so strangers can't use up the budget. The header is stripped before reaching SearXNG. | `searxng/nginx.conf.template` |
| **Smallest possible surface:** only `GET /search` (and `GET /healthz`) are passed on. Every other path, including `/config`, `/stats` and `/preferences`, gets 404, and other methods are refused. | `location = /search` in `nginx.conf.template` |
| **Hard rate limit:** one shared bucket for all searches, `SEARXNG_RATE` (default 30 a minute) with short bursts of 10; over it, 429. This backstop holds even if the Worker misbehaves. | `limit_req` in `nginx.conf.template` |
| **Random 256-bit secrets:** `SEARXNG_KEY` and `SEARXNG_SECRET` come from `openssl rand -hex 32` and live in `.env` (mode 600) | `SETUP.md` step 9 |
| **Least privilege:** `cloudflared` runs as your user id, not root, and mounts only the one tunnel credentials file, read-only | `docker-compose.yml` (`user:`, `:ro`) |
| **Resource cap:** SearXNG is limited to 1 GB of memory | `mem_limit` |
| **Bot limiter off on purpose:** access is already restricted to the Worker, so SearXNG's own limiter isn't needed | `searxng/settings.yml` |

**Limits:**
- **nginx's header check** is a plain string comparison. With a 256-bit random key sent over TLS, that's not practically exploitable.
- **SearXNG queries search engines from your server's IP.** Some engines rate-limit or show CAPTCHAs to data-center IPs, and some forbid automated querying in their terms.
- **Keep the host itself patched** (SSH, OS updates, firewall).

---

## 6. Web discovery (worker/discover.js)

The live web search treats everything it reads as hostile.

| Protection | Code |
| --- | --- |
| **Untrusted input, labelled as such:** search results go to the AI as data, and the system prompt says to ignore instructions inside them | `extractProviders` |
| **Strict output validation:** every AI-provided link must be `https` with no credentials, no custom port and no IP literal (trailing-dot hostnames like `localhost.` included). API base URLs must also use only plain URL characters, because they end up in copy-paste code. It must be on a domain that appeared in the search results; an API base URL must be on the provider's own domain. Names and texts are clipped. Entries without a confirmed website or API address are dropped. `keyRequired: false` from the AI is ignored, because only a real test can say "no key needed". | `publicHttpsUrl`, `validate` |
| **Safe code snippets:** model ids taken from a tested endpoint's own model list must be plain (`[\w.:@/+-]`, 120 characters at most). Setup-guide snippets quote every value for their language: shell single quotes for curl, and JSON string literals for Python and JavaScript. So a hostile model name or URL can't run commands when pasted. | `SAFE_MODEL_ID`, `snippets()` in `home.js` |
| **Safe auto-tests (no SSRF):** only public https hosts; `localhost`, `.local`, `.internal` and IP literals (including decimal and hex forms) are refused. Redirects aren't followed. Timeouts are 8 s for the model list and 20 s for the chat. Responses are read in pieces and cut off at 256 KB. Cloudflare Workers can't reach private networks anyway. At most 6 tests per run. The prompt is a fixed "pong", so no visitor data is sent. | `testKeyless`, `readCapped` |
| **Quota and abuse control:** results are cached in KV and shared by everyone. A new live run happens at most every 6 hours. Parallel requests within an instance share one run. Across instances, a KV lock with a random token is read back after writing, and only its owner may release it. The AI extraction has a 90-second timeout. Only API keys may `force` a run. Community replies are capped at 2 MB. | `runDiscovery`, `LIVE_MIN_INTERVAL_MS` |
| **Safe rendering:** the page builds every card with `textContent`; links pass an `https` check and get `rel="noopener noreferrer nofollow"`. Web-found providers are labelled **unverified**, with their sources. | `site/home.js` (`el`, `link`) |
| **Community models are opt-in:** a keyless provider that passed the test can be *chosen* as `community/<id>/<model>`, but it's never part of **Automatic**. The website may only use the tested model. Calls re-check the URL and don't follow redirects. | `chat()` community branch, `communityRunner` |
| **The browser key test keeps keys local:** the visitor's key goes straight from their browser to the provider (`credentials: 'omit'`, `referrerPolicy: 'no-referrer'`). It's never sent to this site and never stored. | `keyTest` in `site/home.js` |

| **Deep check (reading docs):** docs pages are fetched only from public `https` hosts. Redirects are followed by hand, only within the provider's own domain. Only text content types are read, at most the first 150 KB. The page goes to the AI as untrusted text. The API address it returns must be on the provider's own domain and use plain characters, and example models must match `SAFE_MODEL_ID`. So a page that says "the API is at evil.example" can't make the Worker call another site. Only then is the "pong" test sent. | `fetchDocsPage`, `deepCheck` in `discover.js` |
| **Verified community list:** only keyless APIs that passed the test are stored. They're re-tested daily and dropped after 3 failed re-tests or 7 days without success, and capped at 30. They're still opt-in in the chat, never in Automatic. The daily re-test is the safety net, so a model can stop working between checks; the chat then falls back to the normal providers. | `recordCheck`, `deepCheckBatch` |

**Limits:**
- **The KV lock isn't a perfect mutex.** KV is eventually consistent across data centers, so two runs started at exactly the same moment in different regions could both proceed. The daily search budget and the nginx rate limit still cap the cost. A Durable Object would make it exact.
- **An AI can still be wrong about a real service's free tier.** Cards say "unverified", and the curated `directory.json` is the trusted source.
- **A keyless service that passes the test could change later, or log prompts.** That's why community models are opt-in and marked as found on the web.

## 7. The discovery workflow

`site/.github/workflows/discover.yml`:

- **Minimal permissions:** `contents: write` to commit `providers.json`, and `actions: write` to re-enable its own schedule. Nothing else.
- **One secret** (`SEARCH_CHAT_API_KEY`). Provider keys stay in Cloudflare; models are tested **through** the Worker (`strict: true`).
- **Only official actions** (`actions/checkout`, `actions/setup-node`), **pinned to commit SHAs**, so a moved tag can't change what runs. To update them, look up the new commit for the tag and replace the SHA.
- **Docker images** use moving tags (`searxng/searxng:latest`, `nginx:1-alpine`, `cloudflare/cloudflared:latest`), so `docker compose pull` picks up security fixes. The trade-off is that an update is not reviewed first; pin digests if you prefer control over freshness.
- **Only vetted providers are scanned** (the `PROVIDERS` list in `discover.mjs`). Discovery never adds a new provider; adding one is a manual code change.

---

## 8. Automated tests

`npm test` runs `worker/test/worker.test.mjs` (Node's built-in runner, mocked Cloudflare bindings, no network). It covers:
- secrets never appearing in responses
- the origin lock, API keys (401/403), preflight and unknown routes
- size, shape and chunked-body limits, and the rate limit
- the safety check: fake markers, long messages, earlier turns
- server-side sources and key-only features
- the URL safety rules for discovery (private and IP hosts, credentials, ports) and link validation against search results
- the 6-hour interval and budget limits, visitors not being able to force a run, community model restrictions, and the SearXNG key header
- prototype-key ids (`__proto__`), the `nosniff` header, and cut-off reading of huge auto-test responses

Run it after every change to the Worker.

## 9. Checklist for your deployment

- [ ] `ALLOWED_ORIGIN` is exactly your github.io origin.
- [ ] No key is in any committed file: `git log -p | grep -E 'gsk_|sk-or-|nvapi-|tvly-|sc_[0-9a-f]{48}'` returns nothing, in **both** repos.
- [ ] `searxng/.env`, `~/.config/search-chat/api-key` and your shell profile are mode 600.
- [ ] SearXNG hostname returns 403 without the key.
- [ ] Each project using the API has its **own** key.
- [ ] You haven't pasted tokens into chats, issues or screenshots. If you did, rotate them.

## 10. Rotating a secret

| Secret | Steps |
| --- | --- |
| Cloudflare token | dash.cloudflare.com/profile/api-tokens → **Roll** → update your shell profile |
| API key | Generate a new one (`SETUP.md` step 6) → `wrangler secret put API_KEYS` → `gh secret set SEARCH_CHAT_API_KEY` → update your projects |
| SearXNG key | New value in `searxng/.env` → `docker compose up -d` → `wrangler secret put SEARXNG_KEY` |
| Provider key | Regenerate on the provider's site → update the Worker secret |
| GitHub CLI token | github.com/settings/applications → revoke **GitHub CLI** → `gh auth login` |
| Tunnel | `cloudflared tunnel delete searxng`, then recreate it (`SETUP.md` step 9) |

## Reporting a problem

If you find a vulnerability, please open a private security advisory on the repository rather than a public issue.
