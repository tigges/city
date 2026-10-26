# Where is everyone? 🌍

A tiny, shareable group map. Everyone who opens the link enters their **name, city, country** and
(optionally) **industry**, and the whole group shows up as pins on a live map. It's built for dropping
the URL into a WhatsApp group, optionally behind a shared password.

- Mobile-first, works well inside WhatsApp's in-app browser
- Cities are looked up automatically with OpenStreetMap, so nobody needs to know coordinates
- People in the same city share one pin that shows a count, and tapping it lists their names
- Each person can edit or remove their own pin (remembered on their phone), and resubmitting updates their pin instead of adding a duplicate
- The map refreshes every 15 seconds, so new people appear without reloading
- A "Share link with the group" button opens WhatsApp or the phone's share sheet
- Zero npm dependencies: plain Node.js 18+, with Leaflet and the map tiles loaded from CDNs

## Run locally

```bash
npm start
# open http://localhost:3000
```

## Put it online (so you can share the link)

The app needs a small server because everyone has to see the same data. Any Node host works.

### Option A: Render + Upstash (free)

1. Create a free Redis database at [upstash.com](https://upstash.com) and copy its **REST URL** and **REST token**.
2. On [render.com](https://render.com), choose **New → Blueprint** and pick this repository. `render.yaml` sets everything up.
3. When asked, paste `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
4. Share the resulting `https://….onrender.com` URL in your WhatsApp group.

Free Render services go to sleep after a period of inactivity, so the first visit afterwards can take
around 30 seconds to load. Your data is safe in Upstash.

### Option B: any host with a persistent disk (Railway, Fly.io, a VPS, Docker)

Without Upstash, entries are stored in `data/entries.json`. Point `DATA_DIR` at a persistent volume:

```bash
docker build -t group-map .
docker run -p 3000:3000 -v group-map-data:/data group-map
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `APP_TITLE` | `Where is everyone?` | Page heading and WhatsApp link preview title |
| `DATA_DIR` | `./data` | Folder for `entries.json` when Upstash isn't configured |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | – | Store entries in Upstash Redis instead of a file |
| `SITE_PASSWORD` | – | If set, visitors must enter this password once (remembered for a year on their device) |
| `INDUSTRY_REQUIRED` | `false` | Set to `true` to make the Industry field mandatory |
| `ADMIN_KEY` | – | Lets you delete any entry (for spam) |

Name, city and country are always required, because the pin can't be placed without them. Changing
`SITE_PASSWORD` logs everyone out, and they'll be asked for the new password.

To remove someone else's entry as the admin:

```bash
curl -X DELETE https://your-app/api/entries/<id> -H "x-admin-key: $ADMIN_KEY"
```

Entry ids are listed at `https://your-app/api/entries`.
