# Free LLM API Discovery (site)

This folder is the static website: the discovery page (`index.html`), the test chat (`chat.html`) and the API guide (`api.html`). Publish it as its own GitHub Pages repo. See `../SETUP.md` step 7, and set `workerUrl` in `config.js` to your Cloudflare Worker.

`providers.json` is created by the daily discovery workflow (`.github/workflows/discover.yml`) after you add the `SEARCH_CHAT_API_KEY` secret (`SETUP.md` step 8).
