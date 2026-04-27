import express from "express";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());

// Serve the built frontend
app.use(express.static(join(__dirname, "dist")));

// ── Proxy: Twitter API ───────────────────────────────────────────────────────

app.post("/api/tweets", async (req, res) => {
  const { cashtag, provider, apiKey } = req.body;

  if (!cashtag || !provider || !apiKey) {
    return res.status(400).json({ error: "Missing cashtag, provider, or apiKey" });
  }

  const query = cashtag.startsWith("$") ? cashtag : `$${cashtag}`;

  try {
    let resp;

    if (provider === "getxapi") {
      resp = await fetch(
        `https://api.getxapi.com/twitter/tweet/advanced_search?q=${encodeURIComponent(query)}&product=Latest`,
        { headers: { Authorization: `Bearer ${apiKey}` } }
      );
    } else {
      resp = await fetch(
        `https://api.twitterapi.io/twitter/tweet/advanced_search?query=${encodeURIComponent(query)}&queryType=Latest&cursor=`,
        { headers: { "X-API-Key": apiKey } }
      );
    }

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(resp.status).json({ error: `${provider} error ${resp.status}: ${errText}` });
    }

    const data = await resp.json();
    res.json(data);
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
        model: "auto",
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

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(join(__dirname, "dist", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Cashtag Analyzatooor running on http://0.0.0.0:${PORT}`);
});
