# Plexamp → Aurral keeper

Star a track 5 stars in Plexamp; get the whole album, properly, through Lidarr.

[Aurral](https://github.com/aurral) flows download throwaway copies of tracks it
thinks you might like. When one turns out to be a keeper, you want the real
release in your library — not the flow's temporary file. This bridge listens for
Plex `media.rate` webhooks and asks Aurral to request that track's **album**, so
Lidarr fetches it at your usual quality and it lands in your main music library.

- No dependencies — plain ESM on the Node standard library
- No state, no database, no writable volume
- Ignores everything except 5-star ratings inside your Aurral library

## Quick start

```bash
docker compose up -d
```

Using the [`compose.yaml`](compose.yaml) in this repo as a starting point:

```yaml
services:
  keeper:
    image: arlab1/plexamp-aurral-keeper:latest
    restart: unless-stopped
    ports:
      - "30074:3010"
    environment:
      PLEX_URL: "http://plex:32400"
      AURRAL_URL: "http://aurral:3000"
      PLEX_TOKEN_FILE: "/run/keeper-secrets/plex_token"
      AURRAL_API_KEY_FILE: "/run/keeper-secrets/aurral_api_key"
      WEBHOOK_SECRET_FILE: "/run/keeper-secrets/webhook_secret"
    volumes:
      - ./secrets:/run/keeper-secrets:ro
    read_only: true
```

Create the three secret files first:

```bash
mkdir -p secrets
printf '%s' 'your-plex-token'    > secrets/plex_token
printf '%s' 'your-aurral-key'    > secrets/aurral_api_key
openssl rand -hex 24             > secrets/webhook_secret
chmod 600 secrets/*
```

Then point Plex at it. In **Settings → Webhooks** (Plex Pass required), add:

```
http://<host>:30074/plex/<contents-of-webhook_secret>
```

The secret is part of the URL, which is how the endpoint authenticates. Check
it came up with `curl http://<host>:30074/health`:

```json
{"ok":true,"sourceLibrary":"Aurral","minRating":10,"flowTracksIndexed":168}
```

### Building the image yourself

```bash
docker build -t plexamp-aurral-keeper .
```

### Running without Docker

```bash
npm start
```

Requires Node 22+. Every secret also accepts a direct value instead of a file
(`PLEX_TOKEN` rather than `PLEX_TOKEN_FILE`), which is handy for local runs.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PLEX_URL` | `http://localhost:32400` | Plex server, used to re-read the rated track's metadata |
| `PLEX_TOKEN` / `PLEX_TOKEN_FILE` | — | Plex API token (required) |
| `AURRAL_URL` | `http://localhost:3000` | Aurral server |
| `AURRAL_API_KEY` / `AURRAL_API_KEY_FILE` | — | Aurral API key (required) |
| `WEBHOOK_SECRET` / `WEBHOOK_SECRET_FILE` | — | Shared secret in the webhook path (required) |
| `SOURCE_LIBRARY` | `Aurral` | Plex library whose ratings count |
| `SOURCE_PATH_FRAGMENT` | `/aurral-weekly-flow/` | Path marker shared by Plex and Aurral |
| `MIN_RATING` | `10` | Plex rating threshold; 10 is 5 stars |
| `FLOW_JOB_CACHE_MS` | `300000` | How long the flow track index is reused |
| `MAX_TRACKLIST_LOOKUPS` | `12` | Cap on tracklist reads per resolution |
| `TRIGGER_SEARCH` | `true` | Ask Lidarr to search immediately |
| `PORT` | `3010` | Listen port |

Endpoints: `POST /plex/<secret>` for the webhook, `GET /health` for liveness.

## How a rated track becomes an album request

Plex only tells us artist / track / album names and a file path, so the bridge
first identifies the track, then walks a ladder to the album worth downloading.

**Identify the track.** Every enabled flow's jobs are pulled from
`/api/playlists/jobs/{flowId}` and indexed by the path tail after
`/aurral-weekly-flow/`, which Plex and Aurral both share; artist + track name is
the secondary key when paths don't line up. The matched job carries the
MusicBrainz ids Aurral downloaded the track with.

Those ids are not trusted blindly: `/api/artists/{mbid}` is checked against the
job's artist name, and a mbid naming a different artist is discarded (this
happens in real flow data). Placeholder album tags (`Unknown Album`,
`Various Artists`) are treated as missing.

**Find the album**, taking the first confident answer:

1. The named album, when it is a **studio album** by this artist — `primary-type:
   Album` with no `Compilation` / `Live` / `Remix` / `Demo` / `Soundtrack`
   secondary type.
2. Aurral's own `albumMbid`, when `/api/artists/release-group/{mbid}` says that
   release group is itself a studio album.
3. Whichever studio album actually carries the track, found by reading
   tracklists from `/api/artists/release-group/{mbid}/tracks`, earliest release
   first. Bounded by `MAX_TRACKLIST_LOOKUPS` and memoized per process.
4. Failing a studio album: the best non-studio release by this artist — the
   named one, else the best `/api/search/unified` hit **by the same artist**,
   ranked album > EP > single > compilation.
5. Last resort: whatever Aurral downloaded it from.
6. Nothing confident → logged and ignored. Nothing is guessed.

Steps 1–3 exist because Aurral's flow metadata often points at a compilation the
song was licensed to ("Xmas Pop") rather than the album it belongs to. The
`resolvedBy` field in the log line says which rung answered.

The album then goes to `POST /api/library/albums/request` with
`triggerSearch: true`. Requests are deduplicated by album mbid for 10 minutes,
so starring three tracks off one album asks for it once. Failures are logged and
dropped — re-rate the track to try again.

Ratings below the threshold, ratings outside the Aurral library, and lowering a
rating are all ignored.

## Layout

```
src/bridge.mjs        the whole service
test/bridge.test.mjs  node --test suite, no network
Dockerfile            stock node:22-alpine, no build step
compose.yaml          example deployment
```

## Development

```bash
npm test
```

The tests inject a fake `fetch`, so nothing touches a real Plex or Aurral.

## License

MIT — see [LICENSE](LICENSE).
