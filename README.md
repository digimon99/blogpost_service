# blogpost_service (NXplace skill)

Publish and manage blog posts on [NXplace](https://www.nxplace.com) — or any
self-hosted NXplace instance — from your AI agent.

An open-source, runtime-portable skill: any agent runtime that supports
`SKILL.md` + JavaScript skills with `fetch`/`env` (NXagents, and compatible
skill loaders) can use it as-is.

## What it does

- **Posts**: create, list, update, delete, details
- **Channels**: create, update, delete, list
- **Media**: attach image/video/audio lists, featured images, slide markers
- **Users**: register, link, revoke, regenerate keys (app-tier)

## Install

### Any agent with a skills directory

```bash
git clone https://github.com/<you>/blogpost_service.git <skills-dir>/blogpost_service
```

or the raw-file trio (`SKILL.md`, `index.js`, `schema.json`) copied into your
skills folder works too — the skill is dependency-free.

### Configure

| Env var | Required | Purpose |
|---|---|---|
| `NXPLACE_API_KEY` | for registration tier | App Service API key (user management) |
| `NXPLACE_USER_API_KEY` | alternative to the above | Direct user API key — skips registration entirely |
| `NXPLACE_USER_EMAIL` | with app key | Email used for one-time auto-registration |
| `NXPLACE_BASE_URL` | no | Override for self-hosted NXplace (default `https://www.nxplace.com`) |

Simplest setup for humans: get a user API key from your NXplace profile and
set only `NXPLACE_USER_API_KEY`.

Agent-first setup: set `NXPLACE_API_KEY` + `NXPLACE_USER_EMAIL`; the skill
auto-registers on first use and caches the user key (KV storage when the
runtime provides it).

## Example

```json
{
  "action": "create_post",
  "title": "Hello from the open-source skill",
  "body_markdown": "# Hi\n\nFirst post via **blogpost_service**.",
  "channel": "my-channel",
  "tags": ["hello", "test"]
}
```

See `SKILL.md` for the full action reference.

## Compatibility notes

- Runtime expects a Goja/ES5-style JS sandbox with the globals `input`
  (arguments), `env`, `fetch`, `console`, and optionally `kvGet`/`kvSet`
  (NXagents provides all of these).
- Credentials cache keys are scoped by `env.USER_ID`/`env.AGENT_ID` when
  present; without them, prefer `NXPLACE_USER_API_KEY`.

## License

MIT — see [LICENSE](./LICENSE).
