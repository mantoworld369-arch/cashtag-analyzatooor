import { useState, useEffect, useRef, useCallback } from "react";

// ── Constants ────────────────────────────────────────────────────────────────

const DEGEN_LOADING_MSGS = [
  "scanning CT for alpha...",
  "reading the timeline...",
  "filtering bot tweets...",
  "extracting the signal...",
  "gauging degen sentiment...",
  "counting rocket emojis...",
  "separating alpha from cope...",
  "analyzing bag holders...",
  "checking who's fading...",
  "measuring conviction levels...",
  "paginating through CT...",
  "fetching page 2... 3... 4...",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  try { return JSON.parse(text.trim()); } catch {}
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch {}
  }
  return null;
}

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  const now = new Date();
  const diffMs = now - d;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

function formatNum(n) {
  if (!n || n === 0) return "0";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return n.toString();
}

function computeStats(tweets) {
  const now = new Date();
  const oneHourAgo = new Date(now - 60 * 60 * 1000);
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
  const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

  let mentions1h = 0, mentions24h = 0, mentions7d = 0;
  let totalViews = 0, viewCount = 0;
  let totalLikes = 0, totalRetweets = 0;

  tweets.forEach((t) => {
    const d = new Date(t.created_at);
    if (!isNaN(d)) {
      if (d >= oneHourAgo) mentions1h++;
      if (d >= oneDayAgo) mentions24h++;
      if (d >= oneWeekAgo) mentions7d++;
    }
    if (t.views > 0) {
      totalViews += t.views;
      viewCount++;
    }
    totalLikes += t.likes || 0;
    totalRetweets += t.retweets || 0;
  });

  return {
    mentions1h,
    mentions24h,
    mentions7d,
    totalTweets: tweets.length,
    avgViews: viewCount > 0 ? Math.round(totalViews / viewCount) : 0,
    totalViews,
    totalLikes,
    totalRetweets,
  };
}

// ── Twitter API (via proxy) ──────────────────────────────────────────────────

async function fetchTweets(cashtag, provider, apiKey) {
  const resp = await fetch("/api/tweets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cashtag, provider, apiKey }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
    throw new Error(err.error || `Twitter API error ${resp.status}`);
  }
  const data = await resp.json();
  return data.tweets || [];
}

// ── LLM Analysis (via proxy) ─────────────────────────────────────────────────

async function analyzeTweets(tweets, cashtag, openrouterKey) {
  // Sort by engagement, pick top 10 for fast analysis
  const topTweets = [...tweets]
    .sort((a, b) => (b.likes + b.retweets * 2 + b.views * 0.01) - (a.likes + a.retweets * 2 + a.views * 0.01))
    .slice(0, 10);

  const tweetBlock = topTweets
    .map((t, i) => `[${i + 1}] @${t.user} (${formatNum(t.followers)} followers, ${t.likes}❤ ${t.retweets}🔁 ${formatNum(t.views)} views): ${t.text}`)
    .join("\n");

  // Also extract all cashtags from ALL tweets for accurate related cashtags
  const allCashtagsRaw = tweets.flatMap((t) => (t.text.match(/\$[A-Za-z]{1,10}/g) || []));
  const searchedTag = cashtag.toUpperCase();
  const cashtagCounts = {};
  allCashtagsRaw.forEach((tag) => {
    const upper = tag.toUpperCase();
    if (upper !== searchedTag) {
      cashtagCounts[upper] = (cashtagCounts[upper] || 0) + 1;
    }
  });
  const relatedTagsSummary = Object.entries(cashtagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([tag, count]) => `${tag}: ${count}`)
    .join(", ");

  const systemPrompt = `You are a crypto twitter analyst. Analyze tweets and return ONLY valid JSON (no markdown, no backticks). Schema:
{
  "summary": "2-3 sentences: sentiment, key narratives, hype level",
  "sentiment": 0-100,
  "sentiment_label": "Extreme Fear|Bearish|Slightly Bearish|Neutral|Slightly Bullish|Bullish|Extreme Greed",
  "key_narratives": ["2-4 short strings"],
  "related_cashtags": [{"tag": "$XXX", "count": N, "context": "why"}],
  "notable_tweets": [{"user": "@handle", "text": "short summary", "why": "why notable", "index": N}],
  "hype_level": "Dead|Low|Moderate|High|Ape-in Territory|Full Degen Mode"
}
Use the related cashtag counts provided. For notable_tweets use index numbers from the tweet list.`;

  const resp = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: openrouterKey,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Analyze top tweets about ${cashtag}:\n\n${tweetBlock}\n\nRelated cashtag counts from all ${tweets.length} tweets: ${relatedTagsSummary || "none found"}` },
      ],
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
    throw new Error(err.error || `OpenRouter error ${resp.status}`);
  }

  const data = await resp.json();
  const raw = data.choices?.[0]?.message?.content || "";
  const parsed = extractJSON(raw);
  if (!parsed) throw new Error("Failed to parse LLM response. Raw output:\n" + raw.slice(0, 500));

  // Map notable tweet indices back to topTweets (which have URLs, etc.)
  if (parsed.notable_tweets) {
    parsed.notable_tweets = parsed.notable_tweets.map((nt) => {
      const idx = (nt.index || 0) - 1;
      const real = topTweets[idx];
      return {
        ...nt,
        url: real?.url || "",
        followers: real?.followers || 0,
        created_at: real?.created_at || "",
      };
    });
  }

  return { ...parsed, _model: data.model || "openrouter/free", _topTweets: topTweets };
}

// ── Components ───────────────────────────────────────────────────────────────

function StatBox({ label, value, sub }) {
  return (
    <div style={{
      flex: "1 1 0", minWidth: 80, padding: "14px 10px", textAlign: "center",
      background: "#0c0c14", border: "1px solid #1a1a2e", borderRadius: 10,
    }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 22, fontWeight: 700, color: "var(--accent)", textShadow: "0 0 10px rgba(0,255,136,0.2)" }}>
        {value}
      </div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "#555", marginTop: 4, letterSpacing: "0.08em", textTransform: "uppercase" }}>
        {label}
      </div>
      {sub && <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "#333", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function StatsBar({ stats }) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <StatBox label="Past 1h" value={stats.mentions1h} />
      <StatBox label="Past 24h" value={stats.mentions24h} />
      <StatBox label="Past 7d" value={stats.mentions7d} />
      <StatBox label="Avg Views" value={formatNum(stats.avgViews)} sub={`${formatNum(stats.totalViews)} total`} />
    </div>
  );
}

function SentimentGauge({ value = 50, label = "Neutral" }) {
  const clamp = Math.max(0, Math.min(100, value));
  const hue = (clamp / 100) * 120;
  const col = `hsl(${hue}, 85%, 55%)`;

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#555", marginBottom: 6, fontFamily: "var(--mono)" }}>
        <span>BEARISH</span><span>BULLISH</span>
      </div>
      <div style={{
        height: 10, borderRadius: 5, position: "relative",
        background: "linear-gradient(90deg, #ff3b3b, #ff8c00, #555, #4ade80, #00ff88)",
      }}>
        <div style={{
          position: "absolute", top: -4, left: `${clamp}%`, transform: "translateX(-50%)",
          width: 18, height: 18, borderRadius: "50%", background: col,
          boxShadow: `0 0 14px ${col}, 0 0 4px ${col}`, border: "2px solid #0a0a0f",
          transition: "left 1s cubic-bezier(0.34, 1.56, 0.64, 1)",
        }} />
      </div>
      <div style={{
        textAlign: "center", marginTop: 12, fontSize: 14, fontWeight: 700,
        color: col, fontFamily: "var(--mono)", textShadow: `0 0 12px ${col}44`,
      }}>
        {label} · {clamp}/100
      </div>
    </div>
  );
}

function Card({ title, children, style: extra = {} }) {
  return (
    <div style={{ ...cardStyle, ...extra }}>
      {title && <h3 style={cardTitleStyle}>{title}</h3>}
      {children}
    </div>
  );
}

function SettingsPanel({ config, setConfig, onClose }) {
  const [local, setLocal] = useState({ ...config });

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", backdropFilter: "blur(10px)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999,
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: "#0c0c14", border: "1px solid #1e1e30", borderRadius: 14,
        padding: 28, width: "92%", maxWidth: 480,
        boxShadow: "0 0 80px rgba(0,255,136,0.04), 0 20px 60px rgba(0,0,0,0.6)",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <h2 style={{ fontFamily: "var(--mono)", fontSize: 15, color: "var(--accent)", margin: 0, letterSpacing: "0.1em" }}>
            ⚙ SETTINGS
          </h2>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#555", fontSize: 20, cursor: "pointer" }}>✕</button>
        </div>

        <label style={labelStyle}>Twitter API Provider</label>
        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          {[
            { key: "getxapi", label: "GetXAPI" },
            { key: "twitterapi", label: "TwitterAPI.io" },
          ].map(({ key, label }) => (
            <button key={key} onClick={() => setLocal((s) => ({ ...s, twitterProvider: key }))}
              style={{
                flex: 1, padding: "10px 16px", fontSize: 13, fontWeight: 600,
                fontFamily: "var(--mono)", borderRadius: 8, cursor: "pointer",
                border: `1px solid ${local.twitterProvider === key ? "var(--accent)" : "#222"}`,
                background: local.twitterProvider === key ? "rgba(0,255,136,0.08)" : "transparent",
                color: local.twitterProvider === key ? "var(--accent)" : "#666",
                transition: "all 0.2s",
              }}>
              {label}
            </button>
          ))}
        </div>

        <label style={labelStyle}>Twitter API Key</label>
        <input value={local.twitterKey}
          onChange={(e) => setLocal((s) => ({ ...s, twitterKey: e.target.value }))}
          type="password" placeholder="paste your key here" style={{ ...inputStyle, marginBottom: 20 }} />

        <label style={labelStyle}>OpenRouter API Key</label>
        <input value={local.openrouterKey}
          onChange={(e) => setLocal((s) => ({ ...s, openrouterKey: e.target.value }))}
          type="password" placeholder="sk-or-..." style={inputStyle} />

        <p style={{ fontFamily: "var(--mono)", fontSize: 10, color: "#333", margin: "8px 0 0" }}>
          Keys saved in browser localStorage — set once, use forever.
        </p>

        <div style={{ display: "flex", gap: 10, marginTop: 24 }}>
          <button onClick={() => { setConfig(local); onClose(); }}
            style={{ ...btnPrimary, flex: 1 }}>
            Save
          </button>
          <button onClick={onClose}
            style={{ flex: 1, padding: "10px 20px", fontSize: 13, fontFamily: "var(--mono)", background: "transparent", border: "1px solid #333", borderRadius: 8, color: "#888", cursor: "pointer" }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function ResultsView({ result }) {
  if (!result) return null;

  const notableTweets = result.notable_tweets || [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 16 }}>
      {/* Sentiment Gauge */}
      <Card title="MOOD METER">
        <SentimentGauge value={result.sentiment} label={result.sentiment_label} />
        {result.hype_level && (
          <div style={{ textAlign: "center", marginTop: 14, fontSize: 12, color: "#666", fontFamily: "var(--mono)" }}>
            Hype: <span style={{ color: "var(--accent)", textShadow: "0 0 8px rgba(0,255,136,0.3)" }}>{result.hype_level}</span>
          </div>
        )}
      </Card>

      {/* Summary */}
      <Card title="VIBE SUMMARY">
        <p style={{ color: "#c8c8c8", fontSize: 14, lineHeight: 1.75, margin: 0, fontFamily: "var(--body)" }}>
          {result.summary}
        </p>
      </Card>

      {/* Key Narratives */}
      {result.key_narratives?.length > 0 && (
        <Card title="KEY NARRATIVES">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {result.key_narratives.map((n, i) => (
              <span key={i} style={{
                fontSize: 12, padding: "6px 14px",
                background: "rgba(0,255,136,0.05)", border: "1px solid rgba(0,255,136,0.12)",
                borderRadius: 20, color: "#bbb", fontFamily: "var(--mono)",
              }}>{n}</span>
            ))}
          </div>
        </Card>
      )}

      {/* Related Cashtags */}
      {result.related_cashtags?.length > 0 && (
        <Card title="RELATED CASHTAGS">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {result.related_cashtags.map((ct, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <span style={{
                  fontFamily: "var(--mono)", fontWeight: 700, fontSize: 15,
                  color: "var(--accent)", minWidth: 72,
                  textShadow: "0 0 8px rgba(0,255,136,0.25)",
                }}>
                  {ct.tag}
                </span>
                <span style={{
                  fontSize: 11, background: "#111", border: "1px solid #1e1e2e",
                  borderRadius: 4, padding: "2px 8px", color: "#777", fontFamily: "var(--mono)",
                }}>
                  ×{ct.count}
                </span>
                <span style={{ fontSize: 12, color: "#666", fontFamily: "var(--body)", flex: 1, minWidth: 120 }}>
                  {ct.context}
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Notable Tweets — with links, dates, followers */}
      {notableTweets.length > 0 && (
        <Card title="NOTABLE TWEETS">
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {notableTweets.map((tw, i) => (
              <div key={i} style={{ borderLeft: "2px solid var(--accent)", paddingLeft: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--accent)", fontWeight: 600 }}>
                    {tw.user}
                  </span>
                  {tw.followers > 0 && (
                    <span style={{ fontSize: 10, color: "#555", fontFamily: "var(--mono)" }}>
                      {formatNum(tw.followers)} followers
                    </span>
                  )}
                  {tw.created_at && (
                    <span style={{ fontSize: 10, color: "#444", fontFamily: "var(--mono)" }}>
                      · {timeAgo(tw.created_at)}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: "#bbb", lineHeight: 1.6, fontFamily: "var(--body)" }}>
                  {tw.text}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6 }}>
                  <span style={{ fontSize: 11, color: "#555", fontStyle: "italic", fontFamily: "var(--body)", flex: 1 }}>
                    {tw.why}
                  </span>
                  {tw.url && (
                    <a href={tw.url} target="_blank" rel="noopener noreferrer"
                      style={{
                        fontSize: 10, color: "#0af", fontFamily: "var(--mono)",
                        textDecoration: "none", border: "1px solid #0af3", borderRadius: 4,
                        padding: "2px 8px", whiteSpace: "nowrap",
                        transition: "all 0.2s",
                      }}
                      onMouseOver={(e) => { e.target.style.background = "rgba(0,170,255,0.1)"; }}
                      onMouseOut={(e) => { e.target.style.background = "transparent"; }}
                    >
                      view tweet ↗
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Model footer */}
      {result._model && (
        <div style={{ textAlign: "center", fontFamily: "var(--mono)", fontSize: 10, color: "#2a2a2a", marginTop: 4 }}>
          analyzed via {result._model}
        </div>
      )}
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const labelStyle = {
  display: "block", fontSize: 10, color: "#555", marginBottom: 6,
  fontFamily: "var(--mono)", letterSpacing: "0.1em", textTransform: "uppercase",
};

const inputStyle = {
  width: "100%", padding: "11px 14px", fontSize: 14,
  background: "#0a0a10", border: "1px solid #1e1e2e", borderRadius: 8,
  color: "#eee", fontFamily: "var(--mono)", outline: "none",
  boxSizing: "border-box", transition: "border-color 0.2s",
};

const btnPrimary = {
  padding: "11px 22px", fontSize: 14, fontWeight: 700,
  background: "var(--accent)", color: "#000", border: "none", borderRadius: 8,
  cursor: "pointer", fontFamily: "var(--mono)", letterSpacing: "0.06em",
  transition: "all 0.2s",
};

const cardStyle = {
  background: "#0a0a10", border: "1px solid #151520",
  borderRadius: 12, padding: 22,
  boxShadow: "0 2px 20px rgba(0,0,0,0.3)",
};

const cardTitleStyle = {
  fontFamily: "var(--mono)", fontSize: 10, color: "#444",
  letterSpacing: "0.14em", margin: "0 0 16px", textTransform: "uppercase",
};

// ── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [config, setConfig] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("cashtag_config"));
      if (saved) return { twitterProvider: saved.twitterProvider || "twitterapi", twitterKey: saved.twitterKey || "", openrouterKey: saved.openrouterKey || "" };
    } catch {}
    return { twitterProvider: "twitterapi", twitterKey: "", openrouterKey: "" };
  });
  const [showSettings, setShowSettings] = useState(false);
  const [cashtag, setCashtag] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [tweets, setTweets] = useState([]);
  const [stats, setStats] = useState(null);
  const [history, setHistory] = useState([]);
  const loadingInterval = useRef(null);

  useEffect(() => {
    try { localStorage.setItem("cashtag_config", JSON.stringify(config)); } catch {}
  }, [config]);

  const startLoadingMsgs = useCallback(() => {
    let idx = 0;
    setLoadingMsg(DEGEN_LOADING_MSGS[0]);
    loadingInterval.current = setInterval(() => {
      idx = (idx + 1) % DEGEN_LOADING_MSGS.length;
      setLoadingMsg(DEGEN_LOADING_MSGS[idx]);
    }, 1800);
  }, []);

  const stopLoadingMsgs = useCallback(() => {
    clearInterval(loadingInterval.current);
  }, []);

  const handleAnalyze = async () => {
    const raw = cashtag.trim();
    if (!raw) return;
    if (!config.twitterKey || !config.openrouterKey) {
      setError("Add your API keys in Settings first ⚙");
      return;
    }

    const tag = raw.startsWith("$") ? raw : `$${raw}`;
    setLoading(true);
    setError("");
    setResult(null);
    setTweets([]);
    setStats(null);
    startLoadingMsgs();

    try {
      const fetchedTweets = await fetchTweets(tag, config.twitterProvider, config.twitterKey);

      if (!fetchedTweets || fetchedTweets.length === 0) {
        throw new Error("No tweets found for this cashtag. Try another one or check your API key.");
      }

      setTweets(fetchedTweets);
      const tweetStats = computeStats(fetchedTweets);
      setStats(tweetStats);
      setLoadingMsg("running AI analysis...");

      const analysis = await analyzeTweets(fetchedTweets, tag, config.openrouterKey);
      setResult(analysis);
      setHistory((h) => [tag, ...h.filter((t) => t !== tag)].slice(0, 10));
    } catch (err) {
      setError(err.message || "Something went wrong");
    } finally {
      setLoading(false);
      stopLoadingMsgs();
    }
  };

  const keysConfigured = config.twitterKey && config.openrouterKey;

  return (
    <div style={{
      "--accent": "#00ff88",
      "--accent2": "#00e5ff",
      "--mono": "'Fira Code', 'JetBrains Mono', 'SF Mono', monospace",
      "--body": "'IBM Plex Sans', system-ui, sans-serif",
      minHeight: "100vh",
      background: "#050508",
      color: "#eee",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #050508; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        input::placeholder { color: #333; }
        input:focus { border-color: var(--accent) !important; box-shadow: 0 0 16px rgba(0,255,136,0.06); }
        button:hover:not(:disabled) { filter: brightness(1.15); }
        button:active:not(:disabled) { transform: scale(0.98); }
        a:hover { filter: brightness(1.3); }

        .scanline {
          position: fixed; top: 0; left: 0; right: 0; bottom: 0;
          pointer-events: none; z-index: 0;
          background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,136,0.008) 2px, rgba(0,255,136,0.008) 4px);
        }
      `}</style>

      <div className="scanline" />

      <div style={{ position: "relative", zIndex: 1, maxWidth: 580, margin: "0 auto", padding: "32px 20px 60px" }}>

        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 36 }}>
          <div>
            <h1 style={{
              fontFamily: "var(--mono)", fontSize: 26, fontWeight: 700,
              lineHeight: 1.15, letterSpacing: "-0.02em",
              background: "linear-gradient(135deg, var(--accent) 0%, var(--accent2) 100%)",
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
              filter: "drop-shadow(0 0 24px rgba(0,255,136,0.12))",
            }}>
              CASHTAG<br />ANALYZATOOOR
            </h1>
            <p style={{
              fontFamily: "var(--mono)", fontSize: 11, color: "#333",
              marginTop: 8, letterSpacing: "0.08em",
            }}>
              sentiment · narratives · related tickers · stats
            </p>
          </div>
          <button onClick={() => setShowSettings(true)}
            style={{
              background: "none", border: `1px solid ${keysConfigured ? "#1e1e2e" : "var(--accent)"}`,
              borderRadius: 8, padding: "8px 10px", cursor: "pointer",
              color: keysConfigured ? "#555" : "var(--accent)", fontSize: 18,
              position: "relative", transition: "all 0.2s",
            }}
            title="Settings">
            ⚙
            {!keysConfigured && (
              <span style={{
                position: "absolute", top: -4, right: -4,
                width: 9, height: 9, borderRadius: "50%",
                background: "#ff3b3b", boxShadow: "0 0 8px #ff3b3b",
                animation: "pulse 2s ease-in-out infinite",
              }} />
            )}
          </button>
        </div>

        {/* Search Bar */}
        <div style={{ display: "flex", gap: 10, marginBottom: 6 }}>
          <div style={{ flex: 1, position: "relative" }}>
            <span style={{
              position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)",
              color: "#333", fontFamily: "var(--mono)", fontSize: 16, pointerEvents: "none",
            }}>$</span>
            <input
              value={cashtag}
              onChange={(e) => setCashtag(e.target.value.replace(/^\$/, ""))}
              onKeyDown={(e) => e.key === "Enter" && handleAnalyze()}
              placeholder="BTC, SOL, PEPE ..."
              style={{ ...inputStyle, flex: 1, fontSize: 16, paddingLeft: 30, width: "100%" }}
            />
          </div>
          <button onClick={handleAnalyze} disabled={loading || !cashtag.trim()}
            style={{
              ...btnPrimary, opacity: loading || !cashtag.trim() ? 0.35 : 1,
              minWidth: 100,
            }}>
            {loading ? "···" : "SCAN"}
          </button>
        </div>

        {/* Recent tags */}
        {history.length > 0 && !loading && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8, marginBottom: 4 }}>
            {history.map((tag) => (
              <button key={tag} onClick={() => { setCashtag(tag.replace("$", "")); }}
                style={{
                  fontSize: 11, padding: "3px 10px", background: "rgba(0,255,136,0.04)",
                  border: "1px solid #1a1a2a", borderRadius: 12, color: "#555",
                  fontFamily: "var(--mono)", cursor: "pointer",
                }}>
                {tag}
              </button>
            ))}
          </div>
        )}

        {/* Keys warning */}
        {!keysConfigured && !error && (
          <p style={{ fontFamily: "var(--mono)", fontSize: 11, color: "#ff8c00", marginTop: 12 }}>
            ▲ Add your API keys in Settings to get started
          </p>
        )}

        {/* Loading */}
        {loading && (
          <Card style={{ marginTop: 20, textAlign: "center", padding: 36, borderColor: "rgba(0,255,136,0.08)", animation: "fadeIn 0.3s ease-out" }}>
            <div style={{
              width: 36, height: 36, margin: "0 auto 18px",
              border: "3px solid #1a1a2e", borderTopColor: "var(--accent)",
              borderRadius: "50%", animation: "spin 0.7s linear infinite",
            }} />
            <p style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--accent)", letterSpacing: "0.04em" }}>
              {loadingMsg}
            </p>
            {tweets.length > 0 && (
              <p style={{ fontFamily: "var(--mono)", fontSize: 11, color: "#333", marginTop: 8 }}>
                fetched {tweets.length} tweets — analyzing...
              </p>
            )}
          </Card>
        )}

        {/* Error */}
        {error && (
          <Card style={{ marginTop: 20, borderColor: "rgba(255,59,59,0.15)", background: "rgba(255,59,59,0.03)", animation: "fadeIn 0.3s ease-out" }}>
            <p style={{ fontFamily: "var(--mono)", fontSize: 13, color: "#ff6b6b" }}>
              ✗ {error}
            </p>
          </Card>
        )}

        {/* Results */}
        {stats && !loading && (
          <div style={{ animation: "fadeIn 0.4s ease-out" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "#333", marginTop: 18, textAlign: "right" }}>
              {tweets.length} tweets fetched
            </div>

            {/* Stats Bar */}
            <Card title="TICKER STATS" style={{ marginTop: 8 }}>
              <StatsBar stats={stats} />
              <div style={{ display: "flex", gap: 16, marginTop: 12, justifyContent: "center" }}>
                <span style={{ fontSize: 11, color: "#555", fontFamily: "var(--mono)" }}>
                  ❤ {formatNum(stats.totalLikes)} likes
                </span>
                <span style={{ fontSize: 11, color: "#555", fontFamily: "var(--mono)" }}>
                  🔁 {formatNum(stats.totalRetweets)} RTs
                </span>
              </div>
            </Card>

            <ResultsView result={result} />
          </div>
        )}

        {/* Settings */}
        {showSettings && (
          <SettingsPanel config={config} setConfig={setConfig} onClose={() => setShowSettings(false)} />
        )}
      </div>
    </div>
  );
}
