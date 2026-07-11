// api/youtube.js
// Vercel Serverless Function — proxies YouTube Data API v3 requests using a
// server-side API key, so the key never has to be exposed to (or pasted into)
// the browser. Cosmo AI's frontend calls this endpoint at /api/youtube?q=...
//
// Setup (one-time):
//   1. Get a free YouTube Data API v3 key from console.cloud.google.com
//      (Create/select a project → Enable "YouTube Data API v3" →
//      Credentials → Create Credentials → API Key)
//   2. In your Vercel project: Settings → Environment Variables →
//      add YOUTUBE_API_KEY = <your key> → redeploy
//
// Lookup strategy (in order):
//   1. channels.list?forHandle=@name — an exact, direct handle lookup. This is
//      the method Google actually recommends for "find this specific channel"
//      and is far more reliable than search.list.
//   2. search.list?type=video — search.list?type=channel (the obvious-looking
//      option) is a known weak spot in YouTube's API: it does poor relevance
//      matching for channel names. Searching videos instead and reading the
//      channel off the top result works much better in practice.
//   3. search.list?type=channel — kept as a last-resort fallback.

async function fetchJson(url) {
    const resp = await fetch(url);
    let data = {};
    try { data = await resp.json(); } catch (e) { /* ignore parse errors */ }
    return { ok: resp.ok, status: resp.status, data };
}

async function getChannelDetails(channelId, apiKey) {
    let subscribers = null, videos = null, description = null, customUrl = null, title = null;
    const { ok, data } = await fetchJson(
        `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelId}&key=${apiKey}`
    );
    if (ok && data.items && data.items.length) {
        const stats = data.items[0].statistics;
        const snippet = data.items[0].snippet;
        title = snippet.title;
        customUrl = snippet.customUrl || null;
        subscribers = stats.hiddenSubscriberCount ? null : stats.subscriberCount;
        videos = stats.videoCount || null;
        description = (snippet.description || '').split('\n')[0].slice(0, 200);
    }
    return { title, subscribers, videos, description, customUrl };
}

function buildChannelUrl(channelId, customUrl) {
    return customUrl
        ? `https://www.youtube.com/${customUrl.startsWith('@') ? customUrl : '@' + customUrl.replace(/^@/, '')}`
        : `https://www.youtube.com/channel/${channelId}`;
}

export default async function handler(req, res) {
    const apiKey = process.env.YOUTUBE_API_KEY;
    const rawQuery = (req.query.q || '').toString().trim();

    if (!apiKey) {
        return res.status(500).json({
            error: 'Server is missing YOUTUBE_API_KEY. Add it in your Vercel project\'s Environment Variables (Settings → Environment Variables), then redeploy.'
        });
    }
    if (!rawQuery) {
        return res.status(400).json({ error: 'Missing "q" query parameter.' });
    }

    try {
        // ── Strategy 1: exact handle lookup ─────────────────────────────
        const handleGuess = rawQuery.replace(/\s+/g, '');
        const handleResp = await fetchJson(
            `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&forHandle=${encodeURIComponent('@' + handleGuess.replace(/^@/, ''))}&key=${apiKey}`
        );
        if (handleResp.ok && handleResp.data.items && handleResp.data.items.length) {
            const item = handleResp.data.items[0];
            const stats = item.statistics;
            const snippet = item.snippet;
            const customUrl = snippet.customUrl || null;
            return res.status(200).json({
                title: snippet.title,
                channelId: item.id,
                url: buildChannelUrl(item.id, customUrl),
                subscribers: stats.hiddenSubscriberCount ? null : stats.subscriberCount,
                videos: stats.videoCount || null,
                description: (snippet.description || '').split('\n')[0].slice(0, 200)
            });
        }

        // ── Strategy 2: broad video search, then read the channel off the top hit ──
        // (search.list?type=channel underperforms — searching all content and
        // taking the channel from the most relevant video works better)
        const videoSearch = await fetchJson(
            `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(rawQuery)}&key=${apiKey}`
        );
        if (videoSearch.ok && videoSearch.data.items && videoSearch.data.items.length) {
            const channelId = videoSearch.data.items[0].snippet.channelId;
            const details = await getChannelDetails(channelId, apiKey);
            if (details.title) {
                return res.status(200).json({
                    title: details.title,
                    channelId,
                    url: buildChannelUrl(channelId, details.customUrl),
                    subscribers: details.subscribers,
                    videos: details.videos,
                    description: details.description
                });
            }
        } else if (!videoSearch.ok && videoSearch.status === 403) {
            return res.status(403).json({ error: 'YouTube API key rejected the request (invalid, restricted, or quota exceeded).', detail: JSON.stringify(videoSearch.data).slice(0, 300) });
        }

        // ── Strategy 3: last resort — the original channel-type search ──────
        const channelSearch = await fetchJson(
            `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(rawQuery)}&key=${apiKey}`
        );
        if (channelSearch.ok && channelSearch.data.items && channelSearch.data.items.length) {
            const channelId = channelSearch.data.items[0].id.channelId || channelSearch.data.items[0].snippet.channelId;
            const details = await getChannelDetails(channelId, apiKey);
            return res.status(200).json({
                title: details.title || channelSearch.data.items[0].snippet.title,
                channelId,
                url: buildChannelUrl(channelId, details.customUrl),
                subscribers: details.subscribers,
                videos: details.videos,
                description: details.description
            });
        }

        return res.status(404).json({ error: `No channel found for "${rawQuery}".` });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to reach the YouTube API.', detail: String(e) });
    }
}
