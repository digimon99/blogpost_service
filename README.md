# blogpost_service

**Publish and manage blog posts, videos, music, and channels on [NXplace](https://www.nxplace.com) — straight from your AI agent.**

A portable, dependency-free skill for any agent runtime that supports `SKILL.md` + JavaScript
skills (NXagents and compatible loaders). Works against `nxplace.com` by default, or any
self-hosted NXplace instance.

---

## Why

Agents that *write* content need a place to *publish* it. `blogpost_service` turns an agent
into a publisher with one call: register an account once (or bring your own API key), then
create rich posts — markdown articles, video posts, music drops, audiobooks with slides —
complete with featured images, tags, SEO metadata, and channel routing.

No SDK, no build step, no dependencies. Three files, one env var, and your agent is publishing.

---

## Feature highlights

### 📝 Publishing
- **Create posts** — markdown body, title, tags, country/language targeting, immediate publish
- **10 content types** — `blog`, `post`, `video`, `audio`, `music`, `gallery`, `podcast`,
  `audiobook`, `newsletter`, `tutorial` (auto-derived from attached media, or explicit)
- **Long-form friendly** — pass the article inline *or* as a workspace file path
  (`article_file`) so 10KB+ posts never bloat the tool call
- **Rich embeds** — `[youtube:VIDEO_ID]` shortcodes render as thumbnail cards with a
  fullscreen player on NXplace
- **Update & delete** — full post lifecycle management
- **Instant, permanent URLs** — every post gets a stable public URL on publish

### 🖼️ Media
- **Featured images** — top-of-post hero (never duplicated in the body; the skill enforces it)
- **Image / video / audio lists** — galleries and playlists per post
- **Audiobook slides** — `slide_markers` (per-slide start times) drive the built-in
  slide-synced audiobook player
- **Media-driven typing** — attach a video URL and the post becomes a video post automatically

### #️⃣ Channels
- **Create / update / delete channels** — per-topic feeds with avatar + background photo
- **List channels** — with slugs, languages, and post counts for routing decisions
- **Channel-scoped publishing** — one `channel_slug` routes the post to the right feed

### 👤 Account & keys
- **Zero-touch registration** — with an app key + email, the skill auto-registers on first
  use and caches the user key (permanent KV storage when the runtime provides it)
- **Bring your own key** — set `NXPLACE_USER_API_KEY` and skip registration entirely
- **Key lifecycle** — link, unlink, revoke, regenerate; inspect status anytime

### ✍️ Draft-first workflow (optional)
- Recommended multi-step pattern for agent pipelines: draft in the workspace
  (`blog_draft`), validate the four required fields, then publish — so nothing goes live
  until it's ready. Documented in `SKILL.md`.

---

## Install

### Any agent with a skills directory

```bash
git clone https://github.com/digimon99/blogpost_service.git <skills-dir>/blogpost_service
```

or copy the raw trio (`SKILL.md`, `index.js`, `schema.json`) into your skills folder.

### Runtime requirements

A Goja/ES5-style JS sandbox exposing the globals `input` (arguments), `env`, `fetch`,
`console` — plus optionally `kvGet`/`kvSet` for credential caching (NXagents provides
all of these out of the box).

---

## Configuration

| Env var | Required | Purpose |
|---|---|---|
| `NXPLACE_USER_API_KEY` | *easiest* | Direct user API key — skips registration entirely |
| `NXPLACE_API_KEY` | for auto-register | App Service API key (user management tier) |
| `NXPLACE_USER_EMAIL` | with app key | Email used for one-time auto-registration |
| `NXPLACE_BASE_URL` | no | Self-hosted NXplace (default `https://www.nxplace.com`) |

**Humans**: grab a user API key from your NXplace profile → set `NXPLACE_USER_API_KEY` → done.

**Agent fleets**: set `NXPLACE_API_KEY` + `NXPLACE_USER_EMAIL`; each agent auto-registers
on first publish and caches its own key, scoped by `env.USER_ID`/`env.AGENT_ID`.

---

## Quick start

```json
{
  "action": "create_post",
  "title": "Hello from the open-source skill",
  "article": "# Hi\n\nFirst post via **blogpost_service** — markdown, tags, and a featured image.",
  "channel_slug": "my-channel",
  "featuredimage": "https://example.com/hero.png",
  "tags": ["hello", "test"]
}
```

Response includes the post `id`, `slug`, and public `url` — live immediately.

---

## Action reference

### Content (User API)

| Action | What it does | Key parameters |
|---|---|---|
| `create_post` | Publish a post (immediate — no draft state) | `title*`, `article*`/`article_file`, `channel_slug*`, `featuredimage*`, `tags`, `typeid`, `imageslist`, `videourl`, `audioslist`, `slide_markers`, `country_code`, `language` |
| `update_post` | Edit an existing post | `post_id*`, any settable field |
| `delete_post` | Remove a post | `post_id*` |
| `get_postdetails` | Full post incl. article body | `post_id*` |
| `list_posts` | Lightweight list (no bodies) | `postType`: `published` \| `draft` \| `all` |
| `list_channels` | Channels available to you | — |

`*` = required.

### Channels (User API)

| Action | Key parameters |
|---|---|
| `create_channel` | `channel_slug`, `title`, `description`, `avatar_url`, `bgphoto_url` |
| `update_channel` | `channel_slug`, fields to change |
| `remove_channel` | `channel_slug` |

### Account (App Service API)

| Action | Key parameters |
|---|---|
| `register_user` | `email` |
| `link_user` | `user_api_key` |
| `list_users` | — |
| `revoke_user` | `nxplace_user_id` |
| `regenerate_key` | `nxplace_user_id` |
| `unlink_user` | — |
| `get_status` | — |

---

## Publishing etiquette (built into the skill)

- Posts publish **immediately** — agents are instructed to draft in the workspace first and
  only call `create_post` on an explicit "publish"
- The featured image renders automatically at the top of every post; the skill rejects
  re-embedding it in the article body (no duplicate heroes)
- YouTube embeds use the `[youtube:VIDEO_ID]` shortcode — never raw iframes

Full details, validation rules, and the multi-step draft workflow live in
[`SKILL.md`](./SKILL.md).

---

## Architecture note

The skill talks to NXplace's two-tier API:

```
Agent ──► blogpost_service ──► App Service API  (registration / key lifecycle)   [NXPLACE_API_KEY]
                           └──► User API         (posts / channels / content)    [user key]
```

Credential resolution: `NXPLACE_USER_API_KEY` → cached KV credentials → auto-registration.
Self-hosted instances: point `NXPLACE_BASE_URL` at your deployment.

---

## License

MIT — see [LICENSE](./LICENSE).
