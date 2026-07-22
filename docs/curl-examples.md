# TorHQ API — curl examples

Base URL assumes local access: `http://127.0.0.1:8787`.
TorHQ uses a session cookie + a CSRF token (returned by login/register and
required in the `X-CSRF-Token` header on all mutating requests).

## 0. Save the cookie jar and grab the CSRF token

```bash
BASE=http://127.0.0.1:8787
JAR=/tmp/torhq.cookies

# First run only: create the admin account.
curl -s -c $JAR -X POST $BASE/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"supersecret1"}'

# Subsequent logins:
CSRF=$(curl -s -c $JAR -X POST $BASE/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"supersecret1"}' | jq -r .csrfToken)
echo "CSRF=$CSRF"
```

## 1. Health / readiness (public)

```bash
curl -s $BASE/health
curl -s $BASE/ready
```

## 2. Configure a service (secret stored encrypted)

```bash
curl -s -b $JAR -X POST $BASE/api/services \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"kind":"radarr","label":"Radarr","baseUrl":"http://127.0.0.1:7878","secret":"RADARR_API_KEY"}'

# Test a connection (uses submitted or stored secret):
curl -s -b $JAR -X POST $BASE/api/services/test \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"kind":"radarr","label":"Radarr","baseUrl":"http://127.0.0.1:7878"}'

# List services (secrets are masked, never returned in full):
curl -s -b $JAR $BASE/api/services | jq
```

## 3. qBittorrent categories (ownership)

Configure qBittorrent with `secret` as `username:password`, then create the
ownership categories in qBittorrent itself:
`radarr`, `sonarr`, `lidarr`, `torhq-kavita`, `torhq-music`.

## 4. Submit requests (TorHQ only requests; the *arr owns the pipeline)

```bash
# Movie -> Radarr
curl -s -b $JAR $BASE/api/requests/movie/options | jq   # get profiles + root folders
curl -s -b $JAR -X POST $BASE/api/requests/movie \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"term":"Blade Runner 2049","qualityProfileId":1,"rootFolderPath":"/data/movies","searchNow":true}'

# TV -> Sonarr
curl -s -b $JAR -X POST $BASE/api/requests/tv \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"term":"Severance","qualityProfileId":1,"rootFolderPath":"/data/tv","searchNow":true}'

# Artist/Album -> Lidarr
curl -s -b $JAR -X POST $BASE/api/requests/music \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"term":"Radiohead","qualityProfileId":1,"rootFolderPath":"/data/music","searchNow":true}'
```

## 5. Manual intake (books/manga -> Kavita, music -> Navidrome)

```bash
# Define a destination library:
curl -s -b $JAR -X POST $BASE/api/libraries \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"key":"kavita-manga","label":"Kavita Manga","kind":"manga","targetService":"kavita","destPath":"/srv/torhq/libraries/manga","stagingPath":"/srv/torhq/staging/manga"}'

# Preview (dry run — validates paths, shows what will move):
curl -s -b $JAR -X POST $BASE/api/intake/preview \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"libraryKey":"kavita-manga","sourcePath":"/srv/torhq/downloads/torhq-kavita/SomeSeries"}'

# Enqueue the intake job (durable, idempotent):
curl -s -b $JAR -X POST $BASE/api/intake \
  -H "x-csrf-token: $CSRF" -H 'content-type: application/json' \
  -d '{"libraryKey":"kavita-manga","sourcePath":"/srv/torhq/downloads/torhq-kavita/SomeSeries"}'
```

## 6. Jobs, activity, and retries

```bash
curl -s -b $JAR $BASE/api/jobs | jq
curl -s -b $JAR $BASE/api/jobs/<jobId> | jq
curl -s -b $JAR -X POST $BASE/api/jobs/<jobId>/retry -H "x-csrf-token: $CSRF"
curl -s -b $JAR $BASE/api/activity?limit=50 | jq
```

## 7. Dashboard data

```bash
curl -s -b $JAR $BASE/api/status/health | jq
curl -s -b $JAR $BASE/api/status/downloads | jq
curl -s -b $JAR $BASE/api/status/arr-activity | jq
curl -s -b $JAR $BASE/api/status/slskd | jq
curl -s -b $JAR $BASE/api/status/storage | jq
curl -s -b $JAR $BASE/api/status/failures | jq
```

## 8. slskd completed-download webhook (token auth)

Set a `webhookToken` in the slskd service's `extra` config, then:

```bash
curl -s -X POST $BASE/webhooks/slskd \
  -H "x-torhq-token: THE_WEBHOOK_TOKEN" -H 'content-type: application/json' \
  -d '{"localPath":"/srv/torhq/downloads/torhq-music/Artist - Album","filename":"Artist - Album"}'
```

## 9. OpenAPI spec

```bash
curl -s $BASE/api/openapi.json | jq
```
