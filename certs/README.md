# Supabase Database CA

`prod-ca-2021.crt` is a public CA certificate, not a private key or secret.
Downloaded via verified HTTPS on 04/10/2026 from the URL used by the
[official Supabase dashboard configuration](https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json):

https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt

Subject: Supabase Root 2021 CA. Valid until 26/04/2031.
SHA-256 fingerprint:

```txt
80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA
```

Set `DB_SSL=true` and `DB_SSL_CA_FILE=./certs/prod-ca-2021.crt` in the
private backend env. Relative paths resolve against the source repository or
the compiled runtime directory, independent of the working directory.
`npm run build` copies this public certificate into `dist/certs/` for
output-only deployments. Explicit absolute paths are used unchanged.
DatabaseService keeps `rejectUnauthorized: true`, verifying both the CA
chain and hostname. Do not use `NODE_TLS_REJECT_UNAUTHORIZED=0` or trust a
certificate copied from an unverified database handshake.

If Supabase rotates its CA, download the new certificate from Database
Settings -> SSL Configuration and verify its provenance before replacing
this file. See [Supabase SSL documentation](https://supabase.com/docs/guides/platform/ssl-enforcement).
