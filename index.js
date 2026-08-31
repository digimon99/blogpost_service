// blogpost_service — publish and manage blog posts on an NXplace instance.
// Open-source edition: works against https://www.nxplace.com by default, or
// any self-hosted NXplace via NXPLACE_BASE_URL.
//
// Two-Tier Architecture:
// 1. App Service API Key (env NXPLACE_API_KEY) — user management/registration
// 2. User API Key — post operations. Resolved in order:
//    a) env NXPLACE_USER_API_KEY (direct, no registration needed)
//    b) credentials cached in KV storage (from a prior register_user)
//    c) auto-registration with env NXPLACE_USER_EMAIL (or an agent_email
//       mailbox when running inside NXagents)

var BASE_URL = (env && env.NXPLACE_BASE_URL) ? String(env.NXPLACE_BASE_URL).trim().replace(/\/$/, "") : "https://www.nxplace.com";
var envUserApiKey = env && env.NXPLACE_USER_API_KEY ? String(env.NXPLACE_USER_API_KEY).trim() : "";

// ============================================================================
// ENVIRONMENT & CONTEXT
// ============================================================================

// App Service API key from user's vendor service credentials (for user management)
var appServiceKey = env && env.NXPLACE_API_KEY ? String(env.NXPLACE_API_KEY).trim() : "";

// asList: coerce a list-ish param into a real array. Models frequently
// serialize arrays as JSON strings (or pass a single URL string) — the old
// strict Array.isArray checks silently dropped them, making update_post
// report success while changing nothing.
function asList(v) {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.length ? v : null;
  if (typeof v === "string") {
    var s = v.trim();
    if (!s) return null;
    if (s.charAt(0) === "[") {
      try {
        var arr = JSON.parse(s);
        if (Array.isArray(arr) && arr.length) return arr.map(String);
      } catch (e) {}
      return null;
    }
    return [s]; // single URL string
  }
  return null;
}

// User/Agent context for scoped storage
var USER_ID = (env && env.USER_ID) || "";
var AGENT_ID = (env && env.AGENT_ID) || "";

// Debug: Log context on startup
console.log("blogpost_service: Init - USER_ID=" + (USER_ID || "EMPTY") + ", AGENT_ID=" + (AGENT_ID || "EMPTY"));

// ============================================================================
// KV STORAGE KEYS
// ============================================================================

// Key for this agent's nxplace user data (permanent storage)
function getNxplaceUserKey() {
  if (!USER_ID || !AGENT_ID) {
    return null;
  }
  return "nxplace:user:" + USER_ID + ":" + AGENT_ID;
}

// Key for agent_email's mailbox data (READ ONLY - owned by agent_email skill)
function getAgentEmailKey() {
  if (!USER_ID || !AGENT_ID) {
    return null;
  }
  return "agent_email:mailbox:" + USER_ID + ":" + AGENT_ID;
}

// ============================================================================
// KV STORAGE HELPERS
// ============================================================================

// TTL for persistent storage (10 years in seconds) - same approach as agent_email
// Note: TTL=0 doesn't work reliably with badger, use large TTL instead
var KV_TTL_PERSISTENT = 315360000;

/**
 * Store agent's nxplace user data in PostgreSQL (permanent, survives restarts)
 */
function storeNxplaceUser(userInfo) {
  if (!USER_ID || !AGENT_ID) {
    console.log("blogpost_service: Cannot store user - missing USER_ID=" + (USER_ID || "EMPTY") + " or AGENT_ID=" + (AGENT_ID || "EMPTY"));
    return false;
  }
  
  var nxplaceUserId = userInfo.nxplace_user_id || userInfo.user_id || userInfo.id || "";
  var userApiKey = userInfo.user_api_key || userInfo.api_key || "";
  
  console.log("blogpost_service: Storing credential - nxplace_user_id=" + (nxplaceUserId || "EMPTY") + ", has_api_key=" + (userApiKey ? "YES" : "NO"));
  
  var data = {
    nxplace_user_id: nxplaceUserId,
    user_api_key: userApiKey,
    username: userInfo.username || "",
    email: userInfo.email || "",
    external_id: userInfo.external_id || "",
    registered_at: userInfo.registered_at || new Date().toISOString()
  };
  
  try {
    var ok = setAgentCredential("nxplace", data);
    console.log("blogpost_service: setAgentCredential returned: " + ok);
    return ok;
  } catch (e) {
    console.log("blogpost_service: Failed to store user in PG: " + e);
    return false;
  }
}

/**
 * Load agent's nxplace user data from PostgreSQL
 */
function loadNxplaceUser() {
  if (!USER_ID || !AGENT_ID) {
    console.log("blogpost_service: loadNxplaceUser - missing USER_ID or AGENT_ID");
    return null;
  }
  
  // Try PG first
  try {
    var parsed = getAgentCredential("nxplace");
    console.log("blogpost_service: loadNxplaceUser - PG returned: " + (parsed ? "data found" : "null"));
    if (parsed && parsed.user_api_key) {
      return parsed;
    }
  } catch (e) {
    console.log("blogpost_service: PG load failed, trying KV: " + e);
  }

  // Fallback: KV (with PG backfill for auto-migration)
  var key = getNxplaceUserKey();
  if (key) {
    try {
      var data = kvGet(key);
      if (data) {
        var parsed = JSON.parse(data);
        console.log("blogpost_service: loadNxplaceUser - KV fallback found data, backfilling PG");
        try { setAgentCredential("nxplace", parsed); } catch(e2) {}
        return parsed;
      }
    } catch (e) {
      console.log("blogpost_service: KV fallback failed: " + e);
    }
  }
  return null;
}

/**
 * Clear agent's nxplace user data from PostgreSQL
 */
function clearNxplaceUser() {
  if (!USER_ID || !AGENT_ID) {
    return false;
  }
  try {
    clearAgentCredential("nxplace");
    // Also clear KV to prevent fallback from re-populating bad data
    var key = getNxplaceUserKey();
    if (key) {
      kvSet(key, "", 1); // expire immediately
    }
    console.log("blogpost_service: Cleared nxplace user for agent (PG + KV)");
    return true;
  } catch (e) {
    console.log("blogpost_service: Failed to clear user: " + e);
    return false;
  }
}

/**
 * Get agent's email from agent_email skill (cross-skill read)
 */
function getAgentEmail() {
  // Open-source fast path: explicit env email
  if (env && env.NXPLACE_USER_EMAIL) {
    return String(env.NXPLACE_USER_EMAIL).trim();
  }
  if (!USER_ID || !AGENT_ID) {
    return null;
  }

  // Try PG first
  try {
    var mailbox = getAgentCredential("ai2mail");
    if (mailbox && mailbox.full_email) {
      return mailbox.full_email;
    }
  } catch (e) {
    console.log("blogpost_service: PG read for ai2mail failed: " + e);
  }

  // Fallback to KV for backward compat
  try {
    var key = getAgentEmailKey();
    if (key) {
      var data = kvGet(key);
      if (data) {
        var parsed = JSON.parse(data);
        return parsed.full_email || null;
      }
    }
  } catch (e) {
    console.log("blogpost_service: KV fallback for agent email failed: " + e);
  }
  return null;
}

// ============================================================================
// API HELPERS (using Goja runtime's fetchJSON functions)
// ============================================================================

// Available in skill executor:
// - fetchJSON(url, headers) - GET request
// - fetchJSONPost(url, body, headers) - POST request

/**
 * Make App Service API call (uses appServiceKey)
 */
function appServicePost(path, payload) {
  if (!appServiceKey) {
    throw new Error("NXPLACE_API_KEY not configured. Set the env variable NXPLACE_API_KEY (App Service key) — or skip registration entirely with NXPLACE_USER_API_KEY.");
  }
  
  var headers = {
    "Authorization": "Bearer " + appServiceKey,
    "Content-Type": "application/json"
  };
  
  return fetchJSONPost(BASE_URL + path, payload || {}, headers);
}

function appServiceGet(path) {
  if (!appServiceKey) {
    throw new Error("NXPLACE_API_KEY not configured. Set the env variable NXPLACE_API_KEY (App Service key) — or skip registration entirely with NXPLACE_USER_API_KEY.");
  }
  
  var headers = {
    "Authorization": "Bearer " + appServiceKey,
    "Content-Type": "application/json"
  };
  
  return fetchJSON(BASE_URL + path, headers);
}

/**
 * Check if error is a 401 Unauthorized
 */
function is401Error(e) {
  var s = String(e).toLowerCase();
  return s.indexOf("401") !== -1 || s.indexOf("unauthorized") !== -1;
}

var _workflowRetrying = false;

/**
 * 401 auto-recovery: clear bad key, re-register, retry once.
 * Returns the retried result, or { success: false, error: ... }
 */
function workflow401Recovery(retryFn) {
  console.log("blogpost_service: 401 on workflow call — clearing bad credentials and re-registering");
  clearNxplaceUser();
  var reg = ensureRegistered();
  if (!reg.success) {
    return { success: false, error: "Authentication failed and auto-recovery failed: " + reg.error };
  }
  console.log("blogpost_service: Re-registration successful, retrying workflow call");
  _workflowRetrying = true;
  try {
    return retryFn(reg.user.user_api_key);
  } finally {
    _workflowRetrying = false;
  }
}

/**
 * Make Workflow API call (uses per-agent User API Key)
 * Auto-recovers from 401 by clearing bad key and re-registering.
 */
// ── Article image proxying (publish-time) ─────────────────────────────────
// Hotlinked news thumbnails break (signed URLs expire, referer checks,
// truncated template strings). Before create/update, every EXTERNAL image
// URL in the article (<img src>, markdown ![..](..)) is re-hosted via
// builder2 image_proxy → permanent CDN URL. Images already on our CDNs
// (media.builder2.com / cdn.builder2.com / cdn.storage.nxdot.com /
// imgz.builder2.com) and empty refs pass through untouched. featuredimage
// is agent-generated via instant_media — never proxied.
var B2_BASE = "https://api.builder2.com";
var B2_KEY = (env && env.BUILDER2_API_KEY) ? String(env.BUILDER2_API_KEY).trim() : "";
var PROXY_CACHE = {};
// PROXY_CONTEXT: set per-call from the post title (search context for slugs)
var PROXY_CONTEXT = "";

function isOursUrl(u) {
  return /(^|\.)((media|cdn|imgz)\.builder2\.com|cdn\.storage\.nxdot\.com|www\.nxagents\.net)$/i.test(hostOf(u));
}

function hostOf(u) {
  var m = /^https?:\/\/([^\/]+)/i.exec(u || "");
  return m ? m[1].toLowerCase() : "";
}

// contextWords: 3-8 searchable words from the post title/news context, so
// proxied images build a look-up-able reference library over time (slug is
// permanent and appears in the CDN URL). CJK chars pass through builder2's
// slugifier; latin is lowercased and joined with hyphens.
function contextWords(text, max) {
  var out = String(text || "")
    .replace(/[\|\/<>()\[\]{}"'`?!.,;:·—–\-#*&%$@+=~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  // merge CJK runs: each CJK chunk counts as one "word" (keep up to ~18 chars)
  var words = [];
  for (var i = 0; i < out.length && words.length < (max || 6); i++) {
    var w = out[i];
    if (/[\u4e00-\u9fff]/.test(w)) {
      // accumulate CJK runs into one token up to 12 chars
      var cjk = w;
      while (i + 1 < out.length && /[\u4e00-\u9fff]/.test(out[i + 1]) && cjk.length < 12) {
        cjk += out[++i];
      }
      words.push(cjk);
    } else {
      words.push(w.toLowerCase());
    }
  }
  return words.join("-");
}

// cleanSourceFilename: derive meaningful image-identity words from the
// source URL's basename. Strips query strings, extension chains
// (.jpg.large_2x.jpg), and size markers (large_2x/@2x/-scaled/1024x576).
// Returns [] when the filename is junk (img_1234, dsc0001, pure hashes).
function cleanSourceFilename(url) {
  try {
    var m = String(url).match(/[\/?]([^\/?#]+?)(?:[?#]|$)/);
    if (!m) return [];
    var name = m[1];
    for (var i = 0; i < 4; i++) {
      name = name.replace(/\.(jpe?g|png|webp|gif|avif|svg|bmp|tiff?)(?=\.|$)/i, "");
    }
    name = name.replace(/[\._@-](large[_-]?2x|2x|3x|scaled|original|full|thumb(nail)?|small|medium|big-?size)$/i, "");
    name = name.replace(/[-_@.]?(\d{2,4}x\d{2,4})$/i, "");
    var tokens = name.split(/[-_]+/).map(function (t) {
      return t.replace(/([a-z])([A-Z])/g, "$1 $2");
    }).join(" ").split(/\s+/)
      .map(function (t) { return t.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, ""); })
      .filter(function (t) {
        if (!t) return false;
        if (/^(img|image|photo|pic|dsc|dxn|screenshot|shot|untitled|file|download|asset|media|banner|cover|thumb)$/.test(t)) return false;
        return true;
      });
    // junk-filename detection: needs at least one DESCRIPTIVE token —
    // a real word ≥4 letters (apple, review, hands). Hash-stew filenames
    // ("ghows-lk-8f3a2b1c", "k9x2m4p8q7z31", unsplash photo-ids) fail this
    // → fall back to title-context slug. Date-stamped tokens (260825)
    // alone don't count — they're everywhere and mean nothing alone.
    var descriptive = 0;
    for (var j = 0; j < tokens.length; j++) {
      if (/^[a-z]{4,}$/.test(tokens[j]) && !/^(ghows|chorus|master|limit|resizer|filters|focal|uploads|assets|images|content|wp-content|photo)$/i.test(tokens[j])) descriptive++;
    }
    if (descriptive < 1) return [];
    return tokens.slice(0, 8);
  } catch (e) {
    return [];
  }
}

function proxyOneImage(url) {
  url = String(url || "").trim();
  if (!url || !/^https?:\/\//i.test(url)) return url;        // empty/relative untouched
  if (isOursUrl(url)) return url;                              // our CDNs pass through
  if (PROXY_CACHE[url] !== undefined) return PROXY_CACHE[url]; // dedupe within one publish
  try {
    var hash = hashUrl(url);
    // FILENAME-FIRST slug: the source file usually names the image itself
    // (Apple-Mac-mini-hero-260825_big.jpg → apple-mac-mini-hero-260825).
    // Edition/blog-title context only kicks in when the filename is junk
    // (img_1234 etc.) — a generic daily-wrap title must NOT become the
    // stem for every image in the post.
    var fileWords = cleanSourceFilename(url);
    var slug;
    if (fileWords.length >= 2) {
      slug = fileWords.join("-") + "-" + hash;
    } else {
      var ctx = contextWords(PROXY_CONTEXT, 6);
      slug = (ctx ? ctx + "-" : "") + hash;
    }
    var resp = fetchJSONPost(B2_BASE + "/api/v1/build-media", {
      prompt: "proxy", content_type: "image_proxy", media_slug: slug,
      image_url: url, count: 1
    }, { "Authorization": "Bearer " + B2_KEY });
    var proxied = resp && (resp.permanent_url || resp.url || "");
    if (proxied && /^https?:/.test(proxied)) {
      PROXY_CACHE[url] = proxied;
      console.log("blogpost_service: proxied " + url.slice(0, 60) + " → " + proxied.slice(0, 60));
      return proxied;
    }
    PROXY_CACHE[url] = url; // proxy refused (dead ref?) — keep original
  } catch (e) {
    console.log("blogpost_service: image proxy failed (kept original): " + String(e).slice(0, 100));
    PROXY_CACHE[url] = url;
  }
  return url;
}

function hashUrl(u) {
  var h = 0;
  for (var i = 0; i < u.length; i++) {
    h = ((h << 5) - h + u.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36) + "-" + u.length.toString(36);
}

// proxyArticleImages: rewrite all external image refs in article HTML/markdown.
function proxyArticleImages(article) {
  if (!B2_KEY || !article || typeof article !== "string") return article;
  // <img src="...">
  article = article.replace(/(<img[^>]+src=")([^"]+)(")/gi, function (m, a, u, z) {
    return a + proxyOneImage(u) + z;
  });
  // markdown ![alt](url)
  article = article.replace(/(!\[[^\]]*\]\()(https?:\/\/[^\s)]+)(\))/g, function (m, a, u, z) {
    return a + proxyOneImage(u) + z;
  });
  return article;
}

function workflowPost(path, payload, userApiKey) {
  var headers = {
    "Authorization": "Bearer " + userApiKey,
    "Content-Type": "application/json"
  };
  
  try {
    return fetchJSONPost(BASE_URL + path, payload || {}, headers);
  } catch (e) {
    if (is401Error(e) && !_workflowRetrying) {
      return workflow401Recovery(function(newKey) {
        return workflowPost(path, payload, newKey);
      });
    }
    throw e;
  }
}

function workflowGet(path, userApiKey) {
  var headers = {
    "Authorization": "Bearer " + userApiKey,
    "Content-Type": "application/json"
  };
  
  try {
    return fetchJSON(BASE_URL + path, headers);
  } catch (e) {
    if (is401Error(e) && !_workflowRetrying) {
      return workflow401Recovery(function(newKey) {
        return workflowGet(path, newKey);
      });
    }
    throw e;
  }
}

// ============================================================================
// AUTO-REGISTRATION
// ============================================================================

/**
 * Find user by external_id (list_users doesn't return email, so match by external_id)
 * external_id format: "nxagents-{USER_ID}-{AGENT_ID}"
 */
function findUserByExternalId() {
  var expectedExternalId = "nxagents-" + USER_ID + "-" + AGENT_ID;
  
  try {
    console.log("blogpost_service: findUserByExternalId - searching for: " + expectedExternalId);
    var resp = appServiceGet("/app_service/api/list_users");
    console.log("blogpost_service: list_users response - success=" + (resp && resp.success) + ", count=" + (resp && resp.count) + ", users_len=" + (resp && resp.users ? resp.users.length : 0));
    
    if (resp && resp.success && resp.users) {
      for (var i = 0; i < resp.users.length; i++) {
        var u = resp.users[i];
        if (u.external_id && u.external_id === expectedExternalId) {
          // Note: list_users returns user_id, not id
          var userId = u.user_id || u.id;
          console.log("blogpost_service: Found matching user at index " + i + ", user_id=" + userId);
          return {
            id: userId,
            user_id: userId,
            external_id: u.external_id,
            username: u.username || "",
            has_active_apikey: u.has_active_apikey
          };
        }
      }
      console.log("blogpost_service: No match found for external_id: " + expectedExternalId);
    } else {
      console.log("blogpost_service: list_users failed or empty - resp=" + JSON.stringify(resp));
    }
  } catch (e) {
    console.log("blogpost_service: findUserByExternalId error - " + e);
  }
  return null;
}

/**
 * Recover existing user by regenerating their API key
 */
function recoverExistingUser(email) {
  console.log("blogpost_service: Attempting to recover existing user for email: " + email);
  
  // 1. Find user by external_id (list_users doesn't return email)
  var existingUser = findUserByExternalId();
  if (!existingUser || !existingUser.id) {
    console.log("blogpost_service: Could not find user by external_id in list_users");
    return {
      success: false,
      error: "User exists but could not be found via list_users. The user may have been created by a different app service. Contact support."
    };
  }
  
  console.log("blogpost_service: Found existing user ID: " + existingUser.id);
  
  // 2. Regenerate API key
  try {
    var resp = appServicePost("/app_service/api/regenerate_user_api_key", {
      user_id: existingUser.id
    });
    
    if (resp && resp.success && resp.api_key) {
      var userInfo = {
        nxplace_user_id: existingUser.id,
        user_api_key: resp.api_key,
        username: existingUser.username || "",
        email: email,
        external_id: existingUser.external_id || "",
        registered_at: new Date().toISOString()
      };
      
      // Store in KV
      storeNxplaceUser(userInfo);
      
      console.log("blogpost_service: Successfully recovered user with regenerated key");
      return {
        success: true,
        message: "Recovered existing user with new API key",
        user: userInfo
      };
    } else {
      return {
        success: false,
        error: resp && resp.message ? resp.message : "Failed to regenerate API key for existing user"
      };
    }
  } catch (e) {
    console.log("blogpost_service: recoverExistingUser error - " + e);
    return {
      success: false,
      error: "Failed to recover existing user: " + String(e)
    };
  }
}

/**
 * Register agent with NXplace using their email
 */
function registerWithNxplace(email, username, fullName) {
  var payload = {
    email: email,
    external_id: "nxagents-" + USER_ID + "-" + AGENT_ID
  };
  
  if (username) {
    payload.username = username;
  }
  if (fullName) {
    payload.full_name = fullName;
  }
  
  console.log("blogpost_service: Registering with NXplace using email: " + email);
  
  try {
    var resp = appServicePost("/app_service/api/create_user", payload);
    
    console.log("blogpost_service: create_user response - success=" + (resp && resp.success) + ", has_api_key=" + (resp && resp.api_key ? "YES" : "NO") + ", has_user=" + (resp && resp.user ? "YES" : "NO"));
    
    if (resp && resp.success && resp.api_key) {
      var userInfo = {
        nxplace_user_id: resp.user ? resp.user.id : "",
        user_api_key: resp.api_key,
        username: resp.user ? resp.user.username : "",
        email: email,
        external_id: payload.external_id,
        registered_at: new Date().toISOString()
      };
      
      console.log("blogpost_service: Built userInfo - nxplace_user_id=" + (userInfo.nxplace_user_id || "EMPTY"));
      
      // Store in KV
      var storeResult = storeNxplaceUser(userInfo);
      console.log("blogpost_service: storeNxplaceUser returned: " + storeResult);
      
      return {
        success: true,
        message: "Successfully registered with NXplace",
        user: userInfo
      };
    } else {
      return {
        success: false,
        error: resp && resp.message ? resp.message : "Failed to register with NXplace"
      };
    }
  } catch (e) {
    var errStr = String(e);
    console.log("blogpost_service: Registration error - " + errStr);
    
    // Check if it's "already registered" error - attempt recovery
    if (errStr.indexOf("already been registered") !== -1 || 
        errStr.indexOf("already exists") !== -1 ||
        errStr.indexOf("already registered") !== -1) {
      console.log("blogpost_service: User already exists, attempting recovery...");
      return recoverExistingUser(email);
    }
    
    return {
      success: false,
      error: "Failed to register with NXplace: " + errStr
    };
  }
}

/**
 * Ensure agent is registered with NXplace.
 * Auto-registers using agent's email if available.
 * Returns { success: true, user: {...} } or { success: false, error: "..." }
 */
function ensureRegistered() {
  // 0. Direct env key (open-source / self-hosted fast path)
  if (envUserApiKey) {
    return {
      success: true,
      user: {
        user_api_key: envUserApiKey,
        nxplace_user_id: "",
        email: (env && env.NXPLACE_USER_EMAIL) || "env-configured"
      }
    };
  }

  // 1. Check if already registered
  var stored = loadNxplaceUser();
  if (stored && stored.user_api_key) {
    // Validate manually-linked keys (no nxplace_user_id = not from auto-registration)
    if (!stored.nxplace_user_id || stored.nxplace_user_id === "") {
      console.log("blogpost_service: Stored key has no nxplace_user_id — validating before use");
      try {
        workflowGet("/workflow/listchannels", stored.user_api_key);
        console.log("blogpost_service: Linked key validated OK");
        return { success: true, user: stored };
      } catch (e) {
        if (is401Error(e)) {
          console.log("blogpost_service: Linked key is INVALID — clearing and re-registering");
          clearNxplaceUser();
          // Fall through to auto-registration below
        } else {
          // Non-auth error, proceed with stored key
          return { success: true, user: stored };
        }
      }
    } else {
      console.log("blogpost_service: Using stored nxplace credentials for agent");
      return { success: true, user: stored };
    }
  }
   
  // 2. Check for App Service API key
  if (!appServiceKey) {
    return {
      success: false,
      error: "NXPLACE_API_KEY not configured. Set the env variable NXPLACE_API_KEY (App Service key) — or skip registration entirely with NXPLACE_USER_API_KEY."
    };
  }
  
  // 3. Look up agent's email from agent_email skill
  var agentEmail = getAgentEmail();
  if (!agentEmail) {
    return {
      success: false,
      error: "Agent has no email address configured. First use agent_email skill to register a mailbox (e.g., 'register my email'), then try again. Alternatively, use 'register_user' action with explicit email."
    };
  }
  
  // 4. Auto-register with NXplace
  console.log("blogpost_service: Auto-registering agent with email: " + agentEmail);
  return registerWithNxplace(agentEmail);
}

// ============================================================================
// ADMIN ACTIONS (App Service API)
// ============================================================================

/**
 * Manually register agent with NXplace
 */
function actionRegisterUser(params) {
  if (!appServiceKey) {
    return {
      success: false,
      error: "NXPLACE_API_KEY not configured. Set the env variable NXPLACE_API_KEY (App Service key) — or skip registration entirely with NXPLACE_USER_API_KEY."
    };
  }
  
  // Check if already registered
  var stored = loadNxplaceUser();
  if (stored && stored.user_api_key) {
    return {
      success: false,
      error: "Agent is already registered with NXplace. Use 'get_status' to view details or 'unlink_user' to remove."
    };
  }
  
  // Get email - either from params or from agent_email
  var email = params.email;
  if (!email) {
    email = getAgentEmail();
  }
  if (!email) {
    return {
      success: false,
      error: "email is required. Either provide it directly or first register an email via agent_email skill."
    };
  }
  
  return registerWithNxplace(email, params.username, params.full_name);
}

/**
 * List all users created by this app service
 */
function actionListUsers() {
  if (!appServiceKey) {
    return {
      success: false,
      error: "NXPLACE_API_KEY not configured. Set the env variable NXPLACE_API_KEY (App Service key) — or skip registration entirely with NXPLACE_USER_API_KEY."
    };
  }
  
  try {
    var resp = appServiceGet("/app_service/api/list_users");
    
    if (resp && resp.success) {
      return {
        success: true,
        count: resp.count || 0,
        users: resp.users || []
      };
    } else {
      return {
        success: false,
        error: resp && resp.message ? resp.message : "Failed to list users"
      };
    }
  } catch (e) {
    console.log("blogpost_service: listUsers error - " + e);
    return {
      success: false,
      error: "Failed to list users: " + String(e)
    };
  }
}

/**
 * Revoke a user's API key (blocks their access)
 */
function actionRevokeUser(nxplaceUserId) {
  if (!appServiceKey) {
    return {
      success: false,
      error: "NXPLACE_API_KEY not configured."
    };
  }
  
  if (!nxplaceUserId) {
    // Try to get from stored user
    var stored = loadNxplaceUser();
    if (stored && stored.nxplace_user_id) {
      nxplaceUserId = stored.nxplace_user_id;
    } else {
      return {
        success: false,
        error: "nxplace_user_id is required. Use 'get_status' to find the user ID."
      };
    }
  }
  
  try {
    var resp = appServicePost("/app_service/api/revoke_user_api_key", {
      user_id: nxplaceUserId
    });
    
    if (resp && resp.success) {
      // Clear local storage since key is revoked
      clearNxplaceUser();
      
      return {
        success: true,
        message: resp.message || "API key revoked successfully",
        user_id: nxplaceUserId
      };
    } else {
      return {
        success: false,
        error: resp && resp.message ? resp.message : "Failed to revoke user"
      };
    }
  } catch (e) {
    console.log("blogpost_service: revokeUser error - " + e);
    return {
      success: false,
      error: "Failed to revoke user: " + String(e)
    };
  }
}

/**
 * Regenerate user's API key (keeps user & posts intact)
 */
function actionRegenerateKey(nxplaceUserId) {
  if (!appServiceKey) {
    return {
      success: false,
      error: "NXPLACE_API_KEY not configured."
    };
  }
  
  var stored = loadNxplaceUser();
  
  if (!nxplaceUserId) {
    if (stored && stored.nxplace_user_id) {
      nxplaceUserId = stored.nxplace_user_id;
    } else {
      return {
        success: false,
        error: "nxplace_user_id is required. Use 'get_status' to find the user ID."
      };
    }
  }
  
  try {
    var resp = appServicePost("/app_service/api/regenerate_user_api_key", {
      user_id: nxplaceUserId
    });
    
    if (resp && resp.success && resp.api_key) {
      // Update stored credentials with new key
      var updatedUser = stored || {};
      updatedUser.nxplace_user_id = nxplaceUserId;
      updatedUser.user_api_key = resp.api_key;
      updatedUser.registered_at = updatedUser.registered_at || new Date().toISOString();
      
      storeNxplaceUser(updatedUser);
      
      return {
        success: true,
        message: resp.message || "API key regenerated successfully",
        user_id: nxplaceUserId
      };
    } else {
      return {
        success: false,
        error: resp && resp.message ? resp.message : "Failed to regenerate key"
      };
    }
  } catch (e) {
    console.log("blogpost_service: regenerateKey error - " + e);
    return {
      success: false,
      error: "Failed to regenerate key: " + String(e)
    };
  }
}

/**
 * Get registration status for this agent
 */
function actionGetStatus() {
  var stored = loadNxplaceUser();
  var agentEmail = getAgentEmail();
  
  if (stored && stored.user_api_key) {
    return {
      success: true,
      registered: true,
      nxplace_user_id: stored.nxplace_user_id || null,
      username: stored.username || null,
      email: stored.email || null,
      external_id: stored.external_id || null,
      registered_at: stored.registered_at || null,
      agent_email_available: !!agentEmail,
      agent_email: agentEmail || null,
      has_app_service_key: !!appServiceKey
    };
  } else {
    return {
      success: true,
      registered: false,
      message: agentEmail 
        ? "Agent not registered with NXplace. Will auto-register on first post action using email: " + agentEmail
        : "Agent not registered. No email available - first use agent_email skill to register a mailbox.",
      agent_email_available: !!agentEmail,
      agent_email: agentEmail || null,
      has_app_service_key: !!appServiceKey
    };
  }
}

/**
 * Unlink agent from NXplace (removes stored credentials, doesn't delete nxplace user)
 */
function actionUnlinkUser() {
  var stored = loadNxplaceUser();
  
  if (!stored || !stored.user_api_key) {
    return {
      success: false,
      error: "Agent is not linked to NXplace."
    };
  }
  
  clearNxplaceUser();
  
  return {
    success: true,
    message: "Agent unlinked from NXplace. Stored credentials removed. The NXplace user account still exists.",
    previous_user_id: stored.nxplace_user_id || null
  };
}

/**
 * Manually link agent with existing NXplace credentials
 * Use when auto-registration fails or user already has API key
 */
function actionLinkUser(params) {
  if (!params.user_api_key) {
    return {
      success: false,
      error: "user_api_key is required. Get it from your NXplace account settings or ask admin to regenerate."
    };
  }
  
  // Check if already registered
  var stored = loadNxplaceUser();
  if (stored && stored.user_api_key) {
    return {
      success: false,
      error: "Agent is already linked to NXplace. Use 'unlink_user' first to remove existing link."
    };
  }
  
  var userInfo = {
    nxplace_user_id: params.nxplace_user_id || "",
    user_api_key: params.user_api_key,
    username: params.username || "",
    email: params.email || getAgentEmail() || "",
    external_id: "nxagents-" + USER_ID + "-" + AGENT_ID,
    registered_at: new Date().toISOString()
  };
  
  console.log("blogpost_service: Manually linking user with provided API key");
  
  var storeResult = storeNxplaceUser(userInfo);
  console.log("blogpost_service: link_user storeNxplaceUser returned: " + storeResult);
  
  if (storeResult) {
    return {
      success: true,
      message: "Successfully linked agent to NXplace with provided API key",
      user: {
        nxplace_user_id: userInfo.nxplace_user_id,
        email: userInfo.email,
        external_id: userInfo.external_id
      }
    };
  } else {
    return {
      success: false,
      error: "Failed to store credentials in KV. Check server logs."
    };
  }
}

// ============================================================================
// CONTENT ACTIONS (Workflow API - auto-registers if needed)
// ============================================================================

/**
 * resolveArticleFile — load article content from a workspace file so agents
 * never have to re-emit huge articles (30KB+) as tool-call arguments.
 * Usage: pass article_file instead of article. Returns {ok, content?, error?}.
 */
function resolveArticleFile(filePath) {
  if (!filePath) {
    return { ok: false, error: "article_file path is empty" };
  }
  var r = readFile(String(filePath));
  if (!r || !r.ok) {
    return { ok: false, error: "Cannot read article_file '" + filePath + "': " + (r && r.error ? r.error : "unknown error") };
  }
  var content = String(r.content || "");
  if (content.trim().length < 100) {
    return { ok: false, error: "article_file '" + filePath + "' is too short (" + content.trim().length + " chars, minimum 100)" };
  }
  return { ok: true, content: content };
}

/**
 * stripDuplicateFeaturedImage — nxplace renders the featured image at the top
 * of every post automatically. If the article body ALSO embeds the same image
 * (markdown or <img>), the post shows it twice. This removes every embed whose
 * URL equals the featuredimage URL. Returns {article, stripped}.
 */
function stripDuplicateFeaturedImage(article, featuredimage) {
  if (!article || !featuredimage) {
    return { article: article, stripped: false };
  }
  var art = String(article);
  var feat = String(featuredimage).trim();
  var stripped = false;

  // Remove markdown image embeds whose URL matches the featured image
  var out = art.replace(/!\[[^\]]*\]\(\s*(https?:\/\/[^\s)]+)[^\)]*\)/g, function(full, url) {
    if (String(url).trim() === feat) {
      stripped = true;
      return "";
    }
    return full;
  });

  // Remove HTML <img> tags whose src matches the featured image
  out = out.replace(/<img[^>]+src=["']?(https?:\/\/[^"'\s>]+)["']?[^>]*>/gi, function(full, url) {
    if (String(url).trim() === feat) {
      stripped = true;
      return "";
    }
    return full;
  });

  // Tidy leading blank lines left by a removal at the very start
  out = out.replace(/^\n+/, "");

  return { article: out, stripped: stripped };
}

// Defaults for create_post
var DEFAULTS = {
  channel_slug: "techminute",
  // status removed - always "publish", no drafts in nxplace (use agent_workspace for local drafts)
  language: "en",
  country_code: "us"
};

/**
 * Create a new post
 */
function actionCreatePost(params) {
  // Ensure registered
  var reg = ensureRegistered();
  if (!reg.success) {
    return reg;
  }
  
  if (!params.title) {
    return {
      success: false,
      error: "title is required for create_post action. If user provided a topic/idea, please craft an appropriate title."
    };
  }
  // article_file: load article from workspace file (preferred for long content)
  if (!params.article && params.article_file) {
    var af = resolveArticleFile(params.article_file);
    if (!af.ok) {
      return { success: false, error: af.error };
    }
    params.article = af.content;
    console.log("blogpost_service: article loaded from file '" + params.article_file + "' (" + af.content.length + " chars)");
  }
  if (!params.article) {
    return {
      success: false,
      error: "article is required for create_post action. Provide article directly, or article_file (workspace path, e.g. 'blogs/myblog/content.md') to publish long content without re-typing it."
    };
  }
  if (String(params.article).trim().length < 100) {
    return {
      success: false,
      error: "article must be at least 100 characters. Current length: " + String(params.article).trim().length + ". Please provide more substantive content."
    };
  }
  if (!params.channel_slug) {
    return {
      success: false,
      error: "channel_slug is required for create_post action. Specify which channel to post to (e.g., 'techminute', 'technology', 'business', etc.). Use list_channels action to see all available channels."
    };
  }
  if (!params.featuredimage) {
    return {
      success: false,
      error: "featuredimage is required for create_post action. Provide a URL for the featured image. Use generate_image skill first if needed."
    };
  }
  
  // Anti-duplicate: nxplace renders the featured image automatically — strip
  // it from the article body if the agent embedded the same URL.
  var dedup = stripDuplicateFeaturedImage(params.article, params.featuredimage);
  if (dedup.stripped) {
    console.log("blogpost_service: stripped duplicate featured image from article body (" + (String(params.article).length - dedup.article.length) + " chars removed)");
    params.article = dedup.article;
  }
  
   PROXY_CONTEXT = String(params.title || "");
   var proxiedArticle = proxyArticleImages(String(params.article));
   var payload = {
     title: String(params.title),
     article: proxiedArticle,
     channel_slug: String(params.channel_slug),
     featuredimage: String(params.featuredimage),
     status: "publish", // Always publish - no drafts in nxplace, use agent_workspace for drafts
     language: params.language ? String(params.language) : DEFAULTS.language,
     country_code: params.country_code ? String(params.country_code) : DEFAULTS.country_code
   };
   
   if (params.tags !== undefined && params.tags !== null) {
     payload.tags = params.tags;
   }
   {
    var imgL = asList(params.imageslist);
    if (imgL) payload.imageslist = imgL.map(function (u) { return proxyOneImage(u); });
    var vidL = asList(params.videoslist);
    if (vidL) {
      // Direct MP4 URLs (video_workflow output) — NO Cloudflare Stream
      // generation, ever. The video plays progressively at the given URL.
      payload.videoslist = vidL;
    }
  }
  if (params.videourl !== undefined && params.videourl !== null) {
    payload.videourl = String(params.videourl);
  }
   {
     var audL = asList(params.audioslist);
     if (audL) payload.audioslist = audL;
   }
   if (params.typeid) {
      payload.typeid = String(params.typeid);
    }
   if (params.slide_markers !== undefined && Array.isArray(params.slide_markers)) {
     payload.slide_markers = params.slide_markers;
   }
  
   try {
    var resp = workflowPost("/workflow/createpost", payload, reg.user.user_api_key);
    
    if (resp && resp.success) {
      var createResult = {
        success: true,
        message: resp.message || "Post created successfully",
        post: resp.post || {}
      };
      if (dedup && dedup.stripped) {
        createResult.note = "The featured image was embedded at the top of the article body — removed it to avoid duplication (nxplace renders the featured image automatically).";
      }
      return createResult;
    } else {
      return {
        success: false,
        error: resp && resp.message ? resp.message : "Failed to create post"
      };
    }
  } catch (e) {
    console.log("blogpost_service: createPost error - " + e);
    return {
      success: false,
      error: "Failed to create post: " + String(e)
    };
  }
}

/**
 * List posts with optional status filter
 */
function actionListPosts(postType) {
  var reg = ensureRegistered();
  if (!reg.success) {
    return reg;
  }
  
  var payload = {
    postType: postType || "published"
  };
  
  try {
    var resp = workflowPost("/workflow/listposts", payload, reg.user.user_api_key);
    
    if (resp && resp.success) {
      return {
        success: true,
        count: resp.count || 0,
        posts: resp.posts || []
      };
    } else {
      return {
        success: false,
        error: resp && resp.message ? resp.message : "Failed to list posts"
      };
    }
  } catch (e) {
    console.log("blogpost_service: listPosts error - " + e);
    return {
      success: false,
      error: "Failed to fetch posts: " + String(e)
    };
  }
}

/**
 * Get full details of a single post
 */
function actionGetPostDetails(postId) {
  var reg = ensureRegistered();
  if (!reg.success) {
    return reg;
  }
  
  if (!postId) {
    return {
      success: false,
      error: "post_id is required for get_postdetails action"
    };
  }
  
  try {
    var resp = workflowGet("/workflow/postdetails/" + postId, reg.user.user_api_key);
    
    if (resp && resp.success) {
      return {
        success: true,
        post: resp.post || {}
      };
    } else {
      return {
        success: false,
        error: resp && resp.message ? resp.message : "Failed to get post details"
      };
    }
  } catch (e) {
    console.log("blogpost_service: getPostDetails error - " + e);
    return {
      success: false,
      error: "Failed to get post details: " + String(e)
    };
  }
}

/**
 * Delete a post by ID
 */
function actionDeletePost(postId) {
  var reg = ensureRegistered();
  if (!reg.success) {
    return reg;
  }
  
  if (!postId) {
    return {
      success: false,
      error: "post_id is required for delete_post action"
    };
  }
  
  var payload = {
    post_id: postId
  };
  
  try {
    var resp = workflowPost("/workflow/deletepost", payload, reg.user.user_api_key);
    
    if (resp && resp.success) {
      return {
        success: true,
        message: resp.message || "Post deleted successfully",
        post_id: resp.post_id || postId
      };
    } else {
      return {
        success: false,
        error: resp && resp.message ? resp.message : "Failed to delete post"
      };
    }
  } catch (e) {
    console.log("blogpost_service: deletePost error - " + e);
    return {
      success: false,
      error: "Failed to delete post: " + String(e)
    };
  }
}

/**
 * Update an existing post
 */
function actionUpdatePost(postId, updates) {
  var reg = ensureRegistered();
  if (!reg.success) {
    return reg;
  }
  
  if (!postId) {
    return {
      success: false,
      error: "post_id is required for update_post action"
    };
  }
  
  // article_file: load replacement article from workspace file (preferred for long content)
  if (updates.article === undefined || updates.article === null) {
    if (updates.article_file) {
      var af = resolveArticleFile(updates.article_file);
      if (!af.ok) {
        return { success: false, error: af.error };
      }
      updates.article = af.content;
      console.log("blogpost_service: update article loaded from file '" + updates.article_file + "' (" + af.content.length + " chars)");
    }
  }
  
  var payload = {
    post_id: postId
  };
  
  if (updates.message !== undefined && updates.message !== null) {
    payload.message = String(updates.message);
  }
  if (updates.article !== undefined && updates.article !== null) {
    if (updates.title !== undefined && updates.title !== null) PROXY_CONTEXT = String(updates.title);
    payload.article = proxyArticleImages(String(updates.article));
  }
  if (updates.public !== undefined && updates.public !== null) {
    payload.public = Number(updates.public);
  }
  if (updates.channel_slug !== undefined && updates.channel_slug !== null) {
    payload.channel_slug = String(updates.channel_slug);
  }
  {
    var uImgL = asList(updates.imageslist);
    if (uImgL) payload.imageslist = uImgL;
    var uVidL = asList(updates.videoslist);
    if (uVidL) payload.videoslist = uVidL;
    if (updates.videourl !== undefined && updates.videourl !== null) {
      payload.videourl = String(updates.videourl);
    }
    var uAudL = asList(updates.audioslist);
    if (uAudL) payload.audioslist = uAudL;
  }
   if (updates.featuredimage !== undefined && updates.featuredimage !== null) {
     payload.featuredimage = String(updates.featuredimage);
   }
   if (updates.tags !== undefined && updates.tags !== null) {
     payload.tags = updates.tags;
   }
   if (updates.country_code !== undefined && updates.country_code !== null) {
    payload.country_code = String(updates.country_code);
  }
   if (updates.language !== undefined && updates.language !== null) {
     payload.language = String(updates.language);
   }
    if (updates.typeid !== undefined && updates.typeid !== null) {
      payload.typeid = String(updates.typeid);
    }
   if (updates.slide_markers !== undefined && Array.isArray(updates.slide_markers)) {
     payload.slide_markers = updates.slide_markers;
   }
  
  // Anti-duplicate: if this call sets both article and featuredimage, strip the
  // featured image from the new article body (nxplace renders it automatically).
  var updDedupNote = null;
  if (payload.article && payload.featuredimage) {
    var updDedup = stripDuplicateFeaturedImage(payload.article, payload.featuredimage);
    if (updDedup.stripped) {
      console.log("blogpost_service: update_post — stripped duplicate featured image from article body");
      payload.article = updDedup.article;
      updDedupNote = "duplicate_featured_image_stripped";
    }
  }
  
  // Debug: Log payload being sent
  console.log("blogpost_service: update_post payload: " + JSON.stringify(payload));
  
  try {
    var resp = workflowPost("/workflow/updatepost", payload, reg.user.user_api_key);
    
    console.log("blogpost_service: update_post response: " + JSON.stringify(resp));
    
    if (resp && resp.success) {
      var updResult = {
        success: true,
        message: resp.message || "Post updated successfully",
        post_id: resp.post_id || postId,
        updated_fields: resp.updated_fields || []
      };
      if (updDedupNote) {
        updResult.note = "The featured image was embedded at the top of the article body — removed it to avoid duplication (nxplace renders the featured image automatically).";
      }
      return updResult;
    } else {
      return {
        success: false,
        error: resp && resp.message ? resp.message : "Failed to update post"
      };
    }
  } catch (e) {
    console.log("blogpost_service: updatePost error - " + e);
    return {
      success: false,
      error: "Failed to update post: " + String(e)
    };
  }
}

// ============================================================================
// CHANNEL DISCOVERY
// ============================================================================

/**
 * List all available channels for posting
 */
function actionListChannels() {
  var reg = ensureRegistered();
  if (!reg.success) {
    return reg;
  }
  
  try {
    var resp = workflowGet("/workflow/listchannels", reg.user.user_api_key);
    
    if (resp && resp.success) {
      return {
        success: true,
        count: resp.count || 0,
        channels: resp.channels || []
      };
    } else {
      return {
        success: false,
        error: resp && resp.message ? resp.message : "Failed to list channels"
      };
    }
  } catch (e) {
    console.log("blogpost_service: listChannels error - " + e);
    return {
      success: false,
      error: "Failed to list channels: " + String(e)
    };
  }
}

// ============================================================================
// CHANNEL MANAGEMENT
// ============================================================================

function actionCreateChannel(params) {
  var reg = ensureRegistered();
  if (!reg.success) return reg;

  if (!params.channel_slug) {
    return { success: false, error: "channel_slug is required for create_channel" };
  }
  if (!params.title) {
    return { success: false, error: "title is required for create_channel" };
  }
  if (!params.avatar_url) {
    return { success: false, error: "avatar_url is REQUIRED for create_channel. Use instant_media to generate a square image first (aspect_ratio='square')." };
  }
  if (!params.bgphoto_url) {
    return { success: false, error: "bgphoto_url is REQUIRED for create_channel. Use instant_media to generate a landscape image first (aspect_ratio='landscape_16_9')." };
  }

  var payload = {
    channel_slug: String(params.channel_slug).toLowerCase().trim(),
    title: String(params.title).trim(),
    description: params.description ? String(params.description) : "",
    avatar_url: params.avatar_url ? String(params.avatar_url) : "",
    bgphoto_url: params.bgphoto_url ? String(params.bgphoto_url) : "",
    lang: params.lang ? String(params.lang).toLowerCase().trim() : "en",
    cc: params.cc ? String(params.cc).toLowerCase().trim() : ""
  };

  try {
    var resp = workflowPost("/workflow/createchannel", payload, reg.user.user_api_key);
    if (resp && resp.success) {
      return {
        success: true,
        message: resp.message || "Channel created successfully",
        channel: resp.channel || {}
      };
    }
    return { success: false, error: resp && resp.message ? resp.message : "Failed to create channel" };
  } catch (e) {
    return { success: false, error: "Failed to create channel: " + String(e) };
  }
}

function actionUpdateChannel(params) {
  var reg = ensureRegistered();
  if (!reg.success) return reg;

  if (!params.channel_slug) {
    return { success: false, error: "channel_slug is required for update_channel (identifies which channel to update)" };
  }

  var payload = {
    channel_slug: String(params.channel_slug).toLowerCase().trim()
  };
  if (params.title) payload.title = String(params.title).trim();
  if (params.description !== undefined && params.description !== null) payload.description = String(params.description);
  if (params.avatar_url !== undefined && params.avatar_url !== null) payload.avatar_url = String(params.avatar_url);
  if (params.bgphoto_url !== undefined && params.bgphoto_url !== null) payload.bgphoto_url = String(params.bgphoto_url);
  if (params.lang) payload.lang = String(params.lang).toLowerCase().trim();
  if (params.cc !== undefined && params.cc !== null) payload.cc = String(params.cc).toLowerCase().trim();

  try {
    var resp = workflowPost("/workflow/updatechannel", payload, reg.user.user_api_key);
    if (resp && resp.success) {
      return {
        success: true,
        message: resp.message || "Channel updated successfully",
        channel: resp.channel || {}
      };
    }
    return { success: false, error: resp && resp.message ? resp.message : "Failed to update channel" };
  } catch (e) {
    return { success: false, error: "Failed to update channel: " + String(e) };
  }
}

function actionRemoveChannel(params) {
  var reg = ensureRegistered();
  if (!reg.success) return reg;

  if (!params.channel_slug) {
    return { success: false, error: "channel_slug is required for remove_channel" };
  }

  var slug = String(params.channel_slug).toLowerCase().trim();
  var payload = { channel_slug: slug };

  try {
    var resp = workflowPost("/workflow/deletechannel", payload, reg.user.user_api_key);
    if (resp && resp.success) {
      return {
        success: true,
        message: resp.message || "Channel deleted successfully",
        channel_slug: slug
      };
    }
    // 409 Conflict = posts still linked
    var errStr = resp && resp.message ? resp.message : "Failed to delete channel";
    if (resp && resp.error) errStr = resp.error;
    return { success: false, error: errStr };
  } catch (e) {
    var eStr = String(e);
    if (eStr.indexOf("409") !== -1 || eStr.indexOf("Conflict") !== -1 || eStr.indexOf("posts") !== -1) {
      return {
        success: false,
        error: "Cannot delete channel '" + slug + "': posts are still linked to it. Delete or move all posts first."
      };
    }
    return { success: false, error: "Failed to delete channel: " + eStr };
  }
}

// ============================================================================
// MAIN ROUTING
// ============================================================================

// Debug: Log raw input
console.log("blogpost_service: Raw input type: " + typeof input);
console.log("blogpost_service: Raw input: " + JSON.stringify(input).substring(0, 500));

// Parse input
var action = input && input.action ? String(input.action) : "";

console.log("blogpost_service: Parsed action: '" + action + "'");

if (!action) {
  // Additional debug info
  var inputKeys = input ? Object.keys(input) : [];
  console.log("blogpost_service: Input keys: " + inputKeys.join(", "));
  return JSON.stringify({
    success: false,
    error: "action is required. Valid actions: register_user, link_user, list_users, revoke_user, regenerate_key, get_status, unlink_user, create_post, list_posts, list_channels, create_channel, update_channel, remove_channel, get_postdetails, update_post, delete_post",
    debug: {
      input_type: typeof input,
      input_keys: inputKeys,
      raw_input_preview: JSON.stringify(input).substring(0, 200)
    }
  });
}

// Normalize field names: LLMs sometimes send featured_image instead of featuredimage
if (input.featured_image !== undefined && input.featuredimage === undefined) {
  input.featuredimage = input.featured_image;
}
if (input.images_list !== undefined && input.imageslist === undefined) {
  input.imageslist = input.images_list;
}
if (input.videos_list !== undefined && input.videoslist === undefined) {
  input.videoslist = input.videos_list;
}
if (input.videos !== undefined && input.videoslist === undefined) {
  input.videoslist = input.videos;
}
if (input.audios_list !== undefined && input.audioslist === undefined) {
  input.audioslist = input.audios_list;
}
if (input.audios !== undefined && input.audioslist === undefined) {
  input.audioslist = input.audios;
}
if (input.audio_urls !== undefined && input.audioslist === undefined) {
  input.audioslist = input.audio_urls;
}
if (input.audio_url !== undefined && input.audioslist === undefined) {
  // Single audio URL → wrap in array
  input.audioslist = [input.audio_url];
}
if (input.video_url !== undefined && input.videourl === undefined && input.videoslist === undefined) {
  input.videourl = input.video_url;
}

// Normalize tags: accept array, comma-separated string, or JSON string array
if (input.tags !== undefined && input.tags !== null) {
  if (typeof input.tags === "string") {
    var trimmedTags = input.tags.trim();
    if (trimmedTags.startsWith("[") && trimmedTags.endsWith("]")) {
      try {
        var parsedTags = JSON.parse(trimmedTags);
        if (Array.isArray(parsedTags)) {
          input.tags = parsedTags;
        }
      } catch (e) {
        input.tags = trimmedTags.split(",").map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; });
      }
    } else if (trimmedTags.length > 0) {
      input.tags = trimmedTags.split(",").map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; });
    }
  } else if (Array.isArray(input.tags)) {
    // already an array, keep as-is
  } else {
    input.tags = undefined;
  }
}

// Parse stringified JSON arrays (LLMs sometimes send "[\"url\"]" instead of ["url"])
function parseArrayField(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    // Check if it looks like a JSON array
    var trimmed = value.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        var parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      } catch (e) {
        // Not valid JSON, return as single-item array
        return [value];
      }
    }
    // Single URL string → wrap in array
    if (trimmed.startsWith("http")) {
      return [trimmed];
    }
  }
  return value;
}

if (input.audioslist !== undefined) {
  input.audioslist = parseArrayField(input.audioslist);
}
if (input.imageslist !== undefined) {
  input.imageslist = parseArrayField(input.imageslist);
}

// ============================================================================
// PUBLISH APP — publish a mini-app to nxplace's /apps discovery page
// ============================================================================
function actionPublishApp(params) {
  if (!params.url) {
    return { success: false, error: "url is required (the deployed app URL, e.g. https://my-app.nxagents.app)" };
  }
  if (!params.name) {
    return { success: false, error: "name is required" };
  }

  var payload = {
    name: String(params.name),
    url: String(params.url),
    description: params.description ? String(params.description) : "",
    thumbnail_url: params.thumbnail_url ? String(params.thumbnail_url) : "",
    category: params.category ? String(params.category) : "",
    tags: Array.isArray(params.tags) ? params.tags : [],
    auth_required: params.auth_required ? Boolean(params.auth_required) : false,
    screenshots: Array.isArray(params.screenshots) ? params.screenshots : []
  };

  var reg = ensureRegistered();
  if (!reg.success) {
    return { success: false, error: reg.error || "Failed to register with nxplace" };
  }

  try {
    var resp = workflowPost("/workflow/createapp", payload, reg.user.user_api_key);
    if (resp && resp.success) {
      return {
        success: true,
        message: resp.message || "App published to nxplace",
        app: resp.app || {}
      };
    }
    return {
      success: false,
      error: (resp && (resp.error || resp.message)) ? (resp.error || resp.message) : "Failed to publish app"
    };
  } catch (e) {
    return { success: false, error: "API error: " + String(e) };
  }
}

var result;

switch (action) {
  // Admin actions
  case "register_user":
    result = actionRegisterUser({
      email: input.email,
      username: input.username,
      full_name: input.full_name
    });
    break;
    
  case "list_users":
    result = actionListUsers();
    break;
    
  case "revoke_user":
    result = actionRevokeUser(input.nxplace_user_id);
    break;
    
  case "regenerate_key":
    result = actionRegenerateKey(input.nxplace_user_id);
    break;
    
  case "get_status":
    result = actionGetStatus();
    break;
    
  case "unlink_user":
    result = actionUnlinkUser();
    break;
    
  case "link_user":
    result = actionLinkUser({
      user_api_key: input.user_api_key,
      nxplace_user_id: input.nxplace_user_id,
      username: input.username,
      email: input.email
    });
    break;
  
  // Post actions
   case "create_post":
     result = actionCreatePost({
       title: input.title,
       article: input.article,
       article_file: input.article_file,
       channel_slug: input.channel_slug,
       featuredimage: input.featuredimage,
       status: input.status,
       tags: input.tags,
       imageslist: input.imageslist,
       videourl: input.videourl,
       videoslist: input.videoslist,
       audioslist: input.audioslist,
       typeid: input.typeid,
       country_code: input.country_code,
       language: input.language
     });
    break;
    
  case "list_posts":
    result = actionListPosts(input.postType);
    break;
    
   case "list_channels":
     result = actionListChannels();
     break;
     
   case "create_channel":
     result = actionCreateChannel({
       channel_slug: input.channel_slug,
       title: input.title,
       description: input.description,
       avatar_url: input.avatar_url,
       bgphoto_url: input.bgphoto_url,
       lang: input.lang,
       cc: input.cc
     });
     break;
     
   case "update_channel":
     result = actionUpdateChannel({
       channel_slug: input.channel_slug,
       title: input.title,
       description: input.description,
       avatar_url: input.avatar_url,
       bgphoto_url: input.bgphoto_url,
       lang: input.lang,
       cc: input.cc
     });
     break;
     
   case "remove_channel":
     result = actionRemoveChannel({
       channel_slug: input.channel_slug
     });
     break;
    
  case "get_postdetails":
    result = actionGetPostDetails(input.post_id);
    break;
    
  case "delete_post":
    result = actionDeletePost(input.post_id);
    break;
    
  case "update_post":
    result = actionUpdatePost(input.post_id, {
      message: input.message,
      article: input.article,
      article_file: input.article_file,
      public: input.public,
      channel_slug: input.channel_slug,
      imageslist: input.imageslist,
      videoslist: input.videoslist,
      videourl: input.videourl,
      audioslist: input.audioslist,
      slide_markers: input.slide_markers,
      tags: input.tags,
      featuredimage: input.featuredimage,
      country_code: input.country_code,
      language: input.language,
      typeid: input.typeid
    });
    break;

  case "publish_app":
    result = actionPublishApp({
      url: input.url,
      name: input.name || input.title || "",
      description: input.description,
      thumbnail_url: input.thumbnail_url,
      category: input.category,
      tags: input.tags,
      auth_required: input.auth_required,
      screenshots: input.screenshots
    });
    break;

  case "update_app":
    // Same as publish_app — backend upserts by URL (no duplicates)
    result = actionPublishApp({
      url: input.url,
      name: input.name || input.title || "",
      description: input.description,
      thumbnail_url: input.thumbnail_url,
      category: input.category,
      tags: input.tags,
      auth_required: input.auth_required,
      screenshots: input.screenshots
    });
    break;

  case "delete_app":
    var delReg = ensureRegistered();
    if (!delReg.success) {
      result = { success: false, error: delReg.error || "Failed to register" };
    } else {
      try {
        var delResp = workflowPost("/workflow/deleteapp", { url: input.url, app_id: input.app_id }, delReg.user.user_api_key);
        result = { success: true, message: (delResp && delResp.message) || "App removed" };
      } catch (e) {
        result = { success: false, error: "API error: " + String(e) };
      }
    }
    break;
    
  default:
    result = {
      success: false,
      error: "Unknown action: " + action + ". Valid actions: register_user, link_user, list_users, revoke_user, regenerate_key, get_status, unlink_user, create_post, list_posts, list_channels, get_postdetails, update_post, delete_post, publish_app, update_app, delete_app"
    };
}

return JSON.stringify(result);
