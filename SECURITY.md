# Security

`depgraph` exposes a read-mostly package dependency graph plus one route that performs outbound npm-registry crawling. The service is intentionally keyless for normal graph reads, so production security depends on bounding the crawl surface and on infrastructure controls around the API and Postgres.

## Application controls

- CORS is an explicit allowlist configured by `DEPGRAPH_ALLOWED_ORIGINS`; do not use `*`.
- Package names and versions are validated before registry work begins.
- The crawler only contacts the fixed npm registry origin and bounds per-fetch timeouts/concurrency.
- `/crawl` has per-IP request limiting and a process-wide active-crawl cap so one worker cannot queue unbounded outbound work.
- API responses include CSP, HSTS, frame denial, MIME sniffing protection, referrer policy and permissions policy headers.
- SQL access uses SQLAlchemy expressions/parameters rather than request-built SQL strings.
- CI audits Python dependencies with `pip-audit` and npm dependencies through tracked lockfiles.

## Production requirements

Repository code cannot guarantee the following deployment controls. A production deployment should:

1. force HTTPS at the proxy/edge;
2. add a distributed/edge rate limit to `POST /crawl/*` in addition to the in-process limiter;
3. run Postgres with an application-specific least-privilege account, not a superuser;
4. keep `DATABASE_URL` in the deployment secret store and rotate it if it is ever exposed;
5. restrict database network access to the application/private network;
6. take encrypted database backups and periodically test a restore;
7. keep dependency/security alerts enabled and patch supported dependencies promptly;
8. avoid logging authorization headers, connection strings, request bodies or unnecessary client identifiers.

If `/crawl` is ever exposed to a high-abuse public audience, put authenticated or quota-backed access in front of that route rather than increasing the in-process limits.

## Reporting

If a real credential reaches GitHub, CI logs, an issue, or an artifact, revoke/rotate it immediately. Removing the current file does not remove the credential from git history.
