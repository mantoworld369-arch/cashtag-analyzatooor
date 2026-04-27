import express from "express";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json({ limit: "5mb" }));
app.use(express.static(join(__dirname, "dist")));

// ── Paginated Twitter fetch ──────────────────────────────────────────────────

async function fetchGetXAPIPages(query, apiKey, maxPages = 5) {
  let allTweets = [];
  let cursor = "";

  for (let i = 0; i < maxPages; i++) {
    const url = `https://api.getxapi.com/twitter/tweet/advanced_search?q=${encodeURIComponent(query)}&product=Latest${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });

    if (!resp.ok) {
      if (i === 0) {
        const errText = await resp.text();
        throw new Error(`GetXAPI error ${resp.status}: ${errText}`);
      }
      break;
    }

    const data = await resp.json();
    const tweets = data.tweets || [];
    allTweets = allTweets.concat(tweets);

    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }

  return allTweets;
}

async function fetchTwitterAPIPages(query, apiKey, maxPages = 5) {
  let allTweets = [];
  let cursor = "";

  for (let i = 0; i < maxPages; i++) {
    const url = `https://api.twitterapi.io/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}&queryType=Latest&cursor=${encodeURIComponent(cursor)}`;
    const resp = await fetch(url, { headers: { "X-API-Key": apiKey } });

    if (!resp.ok) {
      if (i === 0) {
        const errText = await resp.text();
        throw new Error(`TwitterAPI.io error ${resp.status}: ${errText}`);
      }
      break;
    }

    const data = await resp.json();
    const tweets = data.tweets || [];
    allTweets = allTweets.concat(tweets);

    if (!data.has_next_page && !data.has_more) break;
    if (!data.next_cursor) break;
    cursor = data.next_cursor;
  }

  return allTweets;
}

function normalizeTweets(rawTweets) {
  return rawTweets.map((t) => ({
    text: t.text || t.full_text || "",
    user: t.author?.userName || t.user?.screen_name || t.author?.username || "anon",
    user_display: t.author?.name || t.user?.name || "",
    followers: t.author?.followers || t.author?.followersCount || t.user?.followers_count || 0,
    likes: t.likeCount || t.favorite_count || t.public_metrics?.like_count || 0,
    retweets: t.retweetCount || t.retweet_count || t.public_metrics?.retweet_count || 0,
    views: t.viewCount || t.view_count || t.public_metrics?.impression_count || 0,
    replies: t.replyCount || t.reply_count || t.public_metrics?.reply_count || 0,
    created_at: t.createdAt || t.created_at || "",
    url: t.url || t.twitterUrl || (t.id ? `https://x.com/${t.author?.userName || t.user?.screen_name || "i"}/status/${t.id}` : ""),
  }));
}

app.post("/api/tweets", async (req, res) => {
  const { cashtag, provider, apiKey } = req.body;

  if (!cashtag || !provider || !apiKey) {
    return res.status(400).json({ error: "Missing cashtag, provider, or apiKey" });
  }

  const query = cashtag.startsWith("$") ? cashtag : `$${cashtag}`;

  try {
    let rawTweets;
    if (provider === "getxapi") {
      rawTweets = await fetchGetXAPIPages(query, apiKey, 5);
    } else {
      rawTweets = await fetchTwitterAPIPages(query, apiKey, 5);
    }

    const tweets = normalizeTweets(rawTweets);
    res.json({ tweets, total: tweets.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Proxy: OpenRouter ────────────────────────────────────────────────────────

app.post("/api/analyze", async (req, res) => {
  const { messages, apiKey } = req.body;

  if (!messages || !apiKey) {
    return res.status(400).json({ error: "Missing messages or apiKey" });
  }

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openrouter/free",
        messages,
        temperature: 0.3,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(resp.status).json({ error: `OpenRouter error ${resp.status}: ${errText}` });
    }

    const data = await resp.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(join(__dirname, "dist", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Cashtag Analyzatooor running on http://0.0.0.0:${PORT}`);
});
