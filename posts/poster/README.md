# gwei-poster

The gwei.domains publisher for GNS posts ([../SPEC.md](../SPEC.md)). Authors put a fee in escrow on
`GnsPosts` for the exact blob their post makes; this publisher rebuilds that blob from the post,
checks its versioned hash, delivers it and is paid in the same transaction. Anyone can run a publisher
like it; this one has no special standing.

**Money rules.** A blob is only sent if its deposits that can't be refunded within six hours
(`SAFETY_MARGIN`) cover sending it alone at current prices (`min_fee`), so cheap posts never ride on
others' fees. No transaction may spend more than those deposits, replacements included (`fee_caps`,
checked again in `send`). Payments count after 3 confirmations and exactly once. `test_poster.py` has a
test for each griefing case, and its end-to-end tests check on anvil that the publisher's balance
never ends lower than it started.

**Run it** (eth-node): `/opt/gwei-poster` holds this directory, with an `.env` setting
`POSTER_CONTRACT`, `POSTER_FROM_BLOCK` and optionally `POSTER_NTFY_URL` and
`POSTER_NTFY_TOKEN_FILE=/run/secrets/ntfy-token`.

```sh
sudo install -d -m 0750 -o 10088 /etc/gwei-poster /var/lib/gwei-poster
docker compose build
docker compose run --rm --no-deps -v /etc/gwei-poster:/keys --entrypoint python gwei-poster \
  /opt/gwei-poster/gwei_poster.py keygen /keys/key        # prints the address; the key never leaves the file
docker compose up -d
docker compose run --rm gwei-poster status
```

Fund the printed address with a little ETH: a batch needs its worst-case cost up front before the
posts' fees reimburse it. Fees accumulate on the same address.

**Test:** `POSTER_TRUSTED_SETUP=trusted_setup.txt python -m unittest test_poster` (the end-to-end
tests need anvil, cast and `forge build`).
