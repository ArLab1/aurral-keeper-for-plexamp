# Plexamp → Aurral album requests

Receives Plex `media.rate` webhooks. A 5-star rating on a track in the Plex
`Aurral` library asks Aurral to request that track's **album** through Lidarr,
so the album is fetched properly instead of the flow's throwaway download being
pinned in a playlist.

The service deliberately ignores ratings from other Plex libraries and ratings
below 5 stars. Lowering a rating does not undo a request.

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

## Configuration

- `PLEX_URL` and `PLEX_TOKEN_FILE`
- `AURRAL_URL` and `AURRAL_API_KEY_FILE`
- `WEBHOOK_SECRET_FILE`
- Optional: `SOURCE_LIBRARY` (`Aurral`), `SOURCE_PATH_FRAGMENT`
  (`/aurral-weekly-flow/`), `MIN_RATING` (`10`), `FLOW_JOB_CACHE_MS`
  (`300000`), `MAX_TRACKLIST_LOOKUPS` (`12`), `TRIGGER_SEARCH` (`true`),
  `PORT` (`3010`)

The Plex webhook URL is `http://<host>:<port>/plex/<webhook-secret>`. The health
endpoint is `/health`. Plex webhooks require Plex Pass.

## Deployment

Runs as a custom compose app on a NAS: stock `node:22-alpine` with
`/srv/apps/plexamp-aurral-keeper/app` bind-mounted read-only and
`node /app/bridge.mjs` as the command. There are no dependencies and no build
step — deploying is copying `bridge.mjs` into that directory and restarting the
app.

Run tests with:

```sh
node --test bridge.test.mjs
```
