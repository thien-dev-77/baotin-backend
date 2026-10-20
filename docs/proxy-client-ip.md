# Client IP and authentication limits

Authentication keeps the route's small limit per normalized account/email/reset
token (login: eight attempts per minute), plus a source-IP limit. Account keys
are SHA-256 hashes, not plaintext identities. Changing an unsigned forwarding
header cannot reset an account's limit. Different accounts behind the same
frontend proxy no longer share eight attempts.

Without a verified client IP, authentication uses an aggregate cap of 240
requests per source/route/minute in addition to the small subject limit. This
fallback works immediately after deployment. It does not claim to identify
individual visitors behind a hosting proxy. Other API route limits are unchanged.

For visitor-IP limits, generate a random server-only secret (for example with
`openssl rand -hex 32`) and set the same `PROXY_CLIENT_IP_SECRET` on backend and
frontend. Never use a `NEXT_PUBLIC_` variable or commit the value. On the frontend,
also set `PROXY_CLIENT_IP_HEADER` to a header that the trusted hosting ingress
overwrites or appends with the actual client IP. `PROXY_CLIENT_IP_FROM_RIGHT=1`
selects its rightmost comma-separated address; change the position only after
verifying the hosting proxy chain. Do not enable a header that callers can set
unchanged. No forwarding header is trusted by default.

The frontend signs the IP, timestamp, HTTP method and exact upstream path/query
with HMAC-SHA256. The API verifies the signature in constant time with a 60-second
clock-skew window. Invalid, expired, duplicated or unsigned values are ignored.
Browser-supplied signature headers are never relayed. Express `trust proxy` is
not globally enabled. Direct API callers cannot choose a bucket by forging
`X-Forwarded-For`. Configure both servers and keep their clocks synchronized.

Deploy the backend first. Configure the hosting header only when its provenance
is known; the per-account fallback remains active when the signed-IP setup is
absent. The default Nest throttler storage is still process-local; multiple API
instances would need a shared throttler store.

`npm run test:product-optimizations` uses only disposable local PostgreSQL/API
servers. It checks per-account isolation behind one proxy, repeated-account
blocking, signed source limits, forged/expired signatures and normal role guards.
