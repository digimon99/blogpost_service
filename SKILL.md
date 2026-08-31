---
name: blogpost_service
description: Create, list, update, and delete blog posts on nxplace.com. Also manage channels (create, update, delete). The canonical skill for publishing or modifying posts on NXplace. Call directly for any publish/list/update/delete operation. For general blog creation (research → write → image → publish), workflow_blog skill is recommended but NOT required — custom skills may call blogpost_service directly to publish.
intent_keywords:
  - blogpost_service
  - list my posts
  - show my posts
  - get my posts
  - my blog posts
  - delete post
  - remove post
  - update post
  - edit post
  - change featured image
  - update featured image
  - manage posts
  - post to nxplace
  - publish to nxplace
  - nxplace status
  - register nxplace
  - save post
  - post details
  - create channel
  - update channel
  - edit channel
  - delete channel
  - remove channel
permissions:
  - fetch
  - log
  - env
  - kv
is_enabled: true
---

# blogpost_service

Manage blog posts on an NXplace instance (default: nxplace.com; override with `NXPLACE_BASE_URL`) using a two-tier API architecture:

1. **App Service API Key** (env `NXPLACE_API_KEY`) — used for user management/registration. Power users can skip this tier entirely by setting `NXPLACE_USER_API_KEY`.
2. **User API Key** - Per-agent, auto-obtained via registration. Used for post operations.

> **⚠️ ROUTING NOTE:** For full authoring pipelines (research → write → image → publish), orchestrate in your own workflow and call `blogpost_service` directly to publish. Supported actions: `create_post`, `list_posts`, `update_post`, `delete_post`, `get_status`, `create_channel`, `update_channel`, `delete_channel` (+ user-management actions).

## Auto-Registration Flow

When an agent performs any post action (create_post, list_posts, etc.):
1. Skill checks if agent has stored nxplace credentials in KV storage
2. If not, reads the email from env `NXPLACE_USER_EMAIL` (or, inside NXagents, the agent's `agent_email` mailbox)
3. Auto-registers with NXplace using that email
4. Stores credentials permanently (TTL=0) in KV for future use

**Prerequisite:** Set `NXPLACE_USER_EMAIL` (or `NXPLACE_USER_API_KEY` to skip registration), OR call `register_user` with an explicit email.

## Admin Actions (App Service API)

### get_status
Check if agent is registered with NXplace and view connection details.

**Parameters:**
- `action`: "get_status"

**Returns:** Registration status, nxplace_user_id, email, agent_email availability

### register_user
Manually register agent with NXplace. Normally not needed (auto-registration handles this).

**Parameters:**
- `action`: "register_user"
- `email` (optional): Email address. If omitted, uses agent's email from agent_email skill.
- `username` (optional): Preferred username
- `full_name` (optional): Full name

**Returns:** Registration confirmation with user details

### list_users
List all users created by this app service (admin view).

**Parameters:**
- `action`: "list_users"

**Returns:** Array of all registered users with their details

### revoke_user
Revoke a user's API key, blocking their access. Clears local storage.

**Parameters:**
- `action`: "revoke_user"
- `nxplace_user_id` (optional): User ID to revoke. If omitted, uses current agent's user ID.

### regenerate_key
Regenerate a user's API key. User account and posts remain intact.

**Parameters:**
- `action`: "regenerate_key"
- `nxplace_user_id` (optional): User ID. If omitted, uses current agent's user ID.

### unlink_user
Remove stored credentials from this agent without deleting the NXplace user.

**Parameters:**
- `action`: "unlink_user"

## Content Actions (User API - auto-registers if needed)

### create_post
Create a new post (blog, video, or audio).

> **LLM IMPORTANT:** `title`, `article` (or `article_file`), `channel_slug`, and `featuredimage` are REQUIRED fields.
> **⛔ NEVER embed the featured image inside the article body.** nxplace renders the featured image at the top of every post automatically — embedding the same image again in the article (especially as the first `![](url)`) produces a visible duplicate. The `article` must start with text/content, NOT an image tag. Other images (illustrations, cards, screenshots) are fine — just never the featuredimage URL itself.
> If the user provides a topic, idea, or theme, you MUST craft an appropriate title and write engaging article based on it.
> Do not ask the user for these fields separately - generate them from the user's topic/idea.
> Use `instant_media` skill first to create a featured image if user hasn't provided one.
> `instant_media` returns a permanent CDN URL instantly (~50ms) — perfect for featured images.
> Fallback: `workflow_image` (sync, ~15s). ⛔ **NEVER use `generate_image`** — it is async and will NOT return image URLs.

> **📺 YouTube videos in the article body:** use the shortcode `[youtube:VIDEO_ID]` (e.g. `[youtube:7NOSDKb0HlU]`) — the 11-char ID from `youtube.com/watch?v=VIDEO_ID` or `youtu.be/VIDEO_ID`. It renders as a thumbnail card with play button; click opens a fullscreen player modal on nxplace. Place the shortcode at the point of discussion in the body (up to ~5 per article); in Sources/reference lists keep plain URLs. Never use raw iframe or HTML embeds.

**Parameters:**
- `action`: "create_post"
- `title` (**REQUIRED**): Title of the post (max 200 chars). Craft from user's topic/idea if not explicit.
- `article` (**REQUIRED**, min 100 chars): Article body in Markdown format. Write engaging, substantive content.
- `article_file` (**PREFERRED for long content**): Workspace path to a markdown file (e.g. `blogs/lion-rock-daily/2026-08-16-pm/content.md`). **Whenever the article already exists as a workspace file — especially 10KB+ — pass `article_file` INSTEAD of re-typing the whole article into `article`.** The skill reads the file server-side. Ignored if `article` is provided directly.
- `channel_slug` (**REQUIRED**): Channel to post to. See available channels below or use `list_channels` action.
- `featuredimage` (**REQUIRED**): URL for featured image. Generate one using `instant_media` skill (returns permanent CDN URL instantly). Fallback: `workflow_image`. ⛔ Do NOT use `generate_image` (async, no URL returned).
- `imageslist` (optional): Array of image URLs
- `videourl` (optional): Video URL (converts to video post)
- `audioslist` (optional): Array of audio URLs (converts to audio post)
- `tags` (optional): Array of tag strings (e.g., `["AI", "startup"]`) or comma-separated string (e.g., `"AI,startup"`). Boosts SEO and similar post discovery.
- `typeid` (optional): Post content type. Default: `post` (or `video` if videourl provided, `audio` if audioslist provided). Explicit values override media-derived type. Valid types: `blog`, `post`, `video`, `audio`, `music`, `gallery`, `podcast`, `audiobook`, `newsletter`, `tutorial`.
- `slide_markers` (optional): Array of start-time-in-seconds for audiobook slide transitions (e.g., `[0, 10, 28, 44, 52]`). Only used with `typeid: "audiobook"`. Each number marks when a new slide image begins. If omitted, the player auto-advances with equal time per slide.
- `country_code` (optional): Two-letter country code. **Default: "us"**
- `language` (optional): Language code. **Default: "en"**

> **IMPORTANT:** create_post ALWAYS publishes immediately. No draft option.
> Use agent_workspace with key "blog_draft" for local drafts before publishing.
> NEVER call create_post without user explicitly saying "publish" or similar.

**Returns:** Post details including id, dbid, title, slug, url, created_at

### list_posts
Retrieve a lightweight list of posts filtered by status. Does NOT include full article content to save memory.

**Parameters:**
- `action`: "list_posts"
- `postType` (optional): Filter by status - "all", "published", "draft". Default: "published"

**Returns:** List of posts with id, title, slug, status, type, created_at, url (no article content)

### list_channels
List all available channels for posting.

**Parameters:**
- `action`: "list_channels"

**Returns:** Array of channels with `channel_slug`, `title`, `lang`, `post_count`. Some channels may also include `avatar_url` and `bgphoto_url` if set.

#### Available Channels (top 20 by post count)

| channel_slug | title | lang |
|---|---|---|
| `technology` | Technology News | en |
| `business` | Business | en |
| `world` | World News | en |
| `china` | China News | zh |
| `theus` | U.S. | en |
| `money` | Investment News | en |
| `techminute` | Tech Minute | en |
| `covid19` | Covid19 Info | en |
| `home` | Home Page | en |
| `hkinsurance` | HK Insurance | zh |
| `hongkong` | Hong Kong | zh |
| `cwzy` | 财务自由 | zh |
| `Entertainment` | Entertainment | en |
| `经典金曲` | 经典金曲 | zh |
| `LifeWithCandies` | Life with Candies | en |
| `health` | Health | en |
| `sports` | Sports | en |
| `science` | Science | en |
| `contentcreators` | Content Creators | en |
| `nxmusic` | NXmusic | en |

> Use `list_channels` action to discover channels added after this doc was last updated.

## Channel Management Actions (User API - auto-registers if needed)

### create_channel
Create a new channel on nxplace. The agent becomes the owner of the channel.

> **LLM IMPORTANT:** `avatar_url` and `bgphoto_url` are REQUIRED. Before calling create_channel, you MUST generate both images using `instant_media`:
> - **avatar**: `instant_media` with `aspect_ratio: "square"` — channel icon/logo
> - **bgphoto**: `instant_media` with `aspect_ratio: "landscape_16_9"` — channel banner
> Do NOT skip these. A channel without images looks broken.

**Parameters:**
- `action`: "create_channel"
- `channel_slug` (**REQUIRED**): Unique slug for the channel. Lowercase letters, numbers, hyphens, underscores only (e.g., "ai-news", "tech-blog").
- `title` (**REQUIRED**): Display title for the channel (e.g., "AI News").
- `description` (optional): Channel description.
- `avatar_url` (**REQUIRED**): URL for the channel avatar image. Generate using `instant_media` with `aspect_ratio: "square"`.
- `bgphoto_url` (**REQUIRED**): URL for the channel banner/background photo. Generate using `instant_media` with `aspect_ratio: "landscape_16_9"`.
- `lang` (optional): Language code. **Default: "en"**. Common values: `en`, `zh`, `ja`, `ko`, `es`, `fr`, `de`, `pt`, `ru`, `ar`, `hi`, `vi`, `th`.
- `cc` (optional): ISO 3166-1 alpha-2 country code (e.g., `us`, `ca`, `cn`, `gb`, `hk`).

**Returns:** Channel details including id, channel_id (slug), title, description, lang, cc, avatar_url, bgphoto_url

### update_channel
Update an existing channel. Only provide fields you want to change.

> **To update channel images**, generate new ones first using `instant_media`:
> - **avatar**: `instant_media` with `aspect_ratio: "square"`
> - **bgphoto**: `instant_media` with `aspect_ratio: "landscape_16_9"`

**Parameters:**
- `action`: "update_channel"
- `channel_slug` (**REQUIRED**): Slug of the channel to update (identifies which channel).
- `title` (optional): New display title.
- `description` (optional): New description.
- `avatar_url` (optional): New avatar image URL. Generate using `instant_media` with `aspect_ratio: "square"`.
- `bgphoto_url` (optional): New banner/background photo URL. Generate using `instant_media` with `aspect_ratio: "landscape_16_9"`.
- `lang` (optional): New language code.
- `cc` (optional): New country code.

**Returns:** Updated channel details including avatar_url and bgphoto_url

### remove_channel
Delete a channel. **Only works if no posts are linked to the channel.** If posts exist, you must delete or move them first.

**Parameters:**
- `action`: "remove_channel"
- `channel_slug` (**REQUIRED**): Slug of the channel to delete.

**Returns:** Success confirmation, or error with post count if posts are still linked.

### get_postdetails
Get full details of a single post including the complete article content.

**Parameters:**
- `action`: "get_postdetails"
- `post_id` (required): UUID of the post

**Returns:** Full post details including id, title, article, slug, status, type, created_at, url, images, etc.

### update_post
Update an existing post on nxplace.com. Can update title, article, media, and publication status.

**⚠️ This is the ONLY way to update a post on nxplace.** agent_workspace stores local drafts only.

**Parameters:**
- `action`: "update_post"
- `post_id` (required): UUID of the post to update
- `message` (optional): New title
- `article` (optional): New article body (Markdown)
- `article_file` (**PREFERRED for long content**): Workspace path to the new article file (e.g. `blogs/lion-rock-daily/2026-08-16-pm/content.md`). The skill reads the file server-side — **whenever the replacement article already exists as a workspace file, pass `article_file` instead of re-typing the content into `article`**. Ignored if `article` is provided directly.
- `public` (optional): 1 for published, 0 for draft
- `channel_slug` (optional): Move post to different channel
- `imageslist` (optional): Array of image URLs
- `videourl` (optional): Video URL (converts to video post)
- `audioslist` (optional): Array of audio URLs (converts to audio post)
- `featuredimage` (optional): Featured image URL - use this to change the post's cover image
- `tags` (optional): Array of tag strings or comma-separated string. Replaces existing tags when provided.
- `country_code` (optional): Two-letter country code
- `language` (optional): Language code
- `typeid` (optional): Change post content type (e.g., `music`, `gallery`, `audiobook`)
- `slide_markers` (optional): Array of start-times-in-seconds for audiobook slide transitions (e.g., `[0, 10, 28, 44, 52]`). Only used with `typeid: "audiobook"`.

**Example - Update featured image only:**
```json
{"action": "update_post", "post_id": "api_123456", "featuredimage": "https://example.com/new-image.png"}
```

**Example - Replace article from a workspace file (long content):**
```json
{"action": "update_post", "post_id": "1kacjmlwf0dn", "article_file": "blogs/lion-rock-daily/2026-08-16-pm/content.md"}
```

### delete_post
Delete a specific post.

**Parameters:**
- `action`: "delete_post"
- `post_id` (required): UUID of the post to delete

## Multi-Step Blog Workflow (using agent_workspace)

Use `agent_workspace` skill with fixed key `blog_draft` to persist state locally.
**No drafts are stored in nxplace** - only published posts exist there.

### Draft Structure
```json
{
  "status": "drafting|ready|pending_review|published",
  "title": "...",
  "article": "...",
  "channel_slug": "...",
  "featuredimage": "...",
  "images": [],
  "post_id": null,
  "post_url": null
}
```

### Status Flow
```
drafting → ready → pending_review → published
    ↑                    │
    └────────────────────┘  (user requests changes)
```

| Status | Meaning |
|--------|--------|
| `drafting` | Gathering content, fields incomplete |
| `ready` | All 4 required fields complete & valid |
| `pending_review` | Preview shown, waiting for user's "publish" command |
| `published` | Posted to nxplace, has post_id and post_url |

### Validation Rules

Before setting `status="ready"`:
- ✓ title: non-empty, 5+ characters
- ✓ article: non-empty, **100+ characters** (substantive content)
- ✓ article: does **not** contain the featuredimage URL (nxplace renders it automatically — embedding duplicates it)
- ✓ channel_slug: non-empty
- ✓ featuredimage: valid URL (starts with http)

### Workflow Steps

**1. Starting a Blog Post**
```
- Call: read_file(path="blog_draft.json")
- If NOT found: Create new draft with status="drafting"
- If found with status="drafting/ready/pending_review":
    Ask user: "You have a draft titled '{title}'. Continue this or start fresh?"
- If found with status="published":
    Ask user: "You have a published post '{title}'. Revise it or start a new post?"
```

**2. Gathering Content**
```
- Read existing draft, update fields, then write back:
  write_file(path="blog_draft.json", content='{...updated JSON...}')
- When all 4 required fields are valid: set status="ready"
```

**3. Preview Before Publish (REQUIRED)**
```
When status="ready", ALWAYS show preview to user:

## 📝 Draft Ready for Review

**Title:** {title}
**Channel:** {channel_slug}
**Featured Image:** {featuredimage}

**Article:**
{full article in markdown}

---
✅ All required fields complete (article: {length} chars)
📤 Say "publish" when ready, or tell me what to change.

Then: patch status="pending_review"
```

**4. Publishing (user must explicitly request)**
```
Trigger phrases: "publish", "post it", "go live", "publish now", "make it public"
NOT triggers: "looks good", "nice", "ok" (these need confirmation)

- Verify status="pending_review" or "ready"
- Call: blogpost_service.create_post(title, article, channel_slug, featuredimage)
- On success: write_file to update blog_draft.json with:
    status: "published"
    post_id: "<returned_id>"
    post_url: "<returned_url>"
- Tell user: "Published! View at: {post_url}"
```

**5. Revising Published Post**
```
- read_file(path="blog_draft.json") - must have post_id
- Apply user's changes to local draft
- Show preview again, set status="pending_review"
- On user's "publish": call blogpost_service.update_post(post_id=..., ...)
- Keep status="published" with updated content
```

**6. Starting Fresh (replace existing draft)**
```
- User confirms starting new post
- Call: write_file(path="blog_draft.json", content='{"status":"drafting","title":"...","article":null,"channel_slug":null,"featuredimage":null,"images":[],"post_id":null,"post_url":null}')
```

### Decision Tree
```
On blog request → read_file(path="blog_draft.json")
├─ NOT FOUND → Create new draft
├─ status="drafting/ready/pending_review" → Ask: continue or start fresh?
└─ status="published" → Ask: revise or start new?

On "publish" command → verify pending_review → create_post → update draft
```

## Configuration

1. User must configure their nxplace **App Service API key** in Settings > Services with prefix "nxplace".
   The key will be available as `NXPLACE_API_KEY` environment variable.

2. Agent needs an email address configured via `agent_email` skill for auto-registration.
   Alternatively, use `register_user` action with explicit `email` parameter.

## Storage Keys

- `nxplace:user:{USER_ID}:{AGENT_ID}` - Agent's nxplace credentials (permanent storage)
- `agent_email:mailbox:{USER_ID}:{AGENT_ID}` - Agent's email (read-only, owned by agent_email)
- `blog_draft` - Current blog draft via agent_workspace (per user+agent scope)

## Example Usage
```json
// Check registration status
{"action": "get_status"}

// Manually register with explicit email
{"action": "register_user", "email": "agent@example.com", "username": "myagent"}

// Publish a post (only call after user confirms via pending_review)
{"action": "create_post", "title": "Top AI Trends Shaping 2026", "article": "# The AI Revolution Continues\n\nAs we move through 2026, artificial intelligence...", "channel_slug": "techminute", "featuredimage": "https://example.com/ai-trends.jpg", "tags": ["AI", "trends", "2026"]}

// List all posts (lightweight, no article content)
{"action": "list_posts", "postType": "all"}

// List all available channels for posting
{"action": "list_channels"}

// Get full details of a specific post
{"action": "get_postdetails", "post_id": "uuid-here"}

// Update post title
{"action": "update_post", "post_id": "uuid-here", "message": "New Title"}

// Delete a post
{"action": "delete_post", "post_id": "uuid-here"}

// Create a new channel (avatar_url and bgphoto_url are REQUIRED — generate via instant_media first)
{"action": "create_channel", "channel_slug": "ai-news", "title": "AI News", "description": "Latest AI developments", "avatar_url": "https://cdn.../avatar.png", "bgphoto_url": "https://cdn.../banner.jpg", "lang": "en", "cc": "us"}

// Update a channel (avatar_url and bgphoto_url can be updated too — generate via instant_media)
{"action": "update_channel", "channel_slug": "ai-news", "title": "Updated Title", "description": "New description", "avatar_url": "https://cdn.../new-avatar.png", "bgphoto_url": "https://cdn.../new-banner.jpg"}

// Delete a channel (fails if posts are linked)
{"action": "remove_channel", "channel_slug": "ai-news"}

// Regenerate API key if compromised
{"action": "regenerate_key"}

// Unlink this agent from nxplace (keeps nxplace account)
{"action": "unlink_user"}

// Admin: list all users registered via this app service
{"action": "list_users"}
```
