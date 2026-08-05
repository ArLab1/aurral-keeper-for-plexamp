# Plexamp → Aurral Keepers bridge

Receives Plex `media.rate` webhooks. A 5-star rating on a track in the Plex
`Aurral` library appends that track to an Aurral static playlist named
`Aurral Keepers`. Aurral can then reuse and retain the downloaded flow file
when the source flow rotates.

The service deliberately ignores ratings from other Plex libraries and ratings
below 5 stars. Lowering a rating does not remove a keeper.

Required configuration:

- `PLEX_URL` and `PLEX_TOKEN_FILE`
- `AURRAL_URL` and `AURRAL_API_KEY_FILE`
- `WEBHOOK_SECRET_FILE`

The Plex webhook URL is `http://<host>:<port>/plex/<webhook-secret>`. The health
endpoint is `/health`. Plex webhooks require Plex Pass.

Run tests with:

```sh
node --test bridge.test.mjs
```
