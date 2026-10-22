# Mail relay (`aetos-mail-relay`)
A tiny Cloudflare Worker that exists only because Pages can't run cron or receive email; all the logic stays in the Control Room.
Every 5 minutes it calls the Control Room's `/api/tick?reason=cron`, then `/api/tick?reason=health`, and checks in as the `relay` heartbeat.
Each email routed to it is saved raw (first 256 KB) to D1's `inbound_raw`, then it calls `/api/tick?reason=inbound`.
It's deployed by GitHub Actions (`.github/workflows/deploy-relay.yml`) on every push to `mail-relay/**`, never by hand: the workflow fills in `APP_URL`, `FORWARD_COPY_TO` and the D1 id.
