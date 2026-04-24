// NAME: symphona
// AUTHOR: Pandador
// DESCRIPTION: Compare two playlists on a routed page with shared and unique track views.
// VERSION: 5.0.0-local

/// <reference path="../globals.d.ts" />

const SymphonaCore = (() => {
    const CACHE_MAX = 32;
    const CACHE_TTL = 180_000;
    const ROUTE_PREFIX = "/symphona";
    const VALID_VIEWS = new Set(["shared", "left", "right"]);

    function cacheGet(cache, key) {
        const entry = cache.get(key);
        if (!entry) return undefined;
        if (Date.now() - entry.ts > CACHE_TTL) {
            cache.delete(key);
            return undefined;
        }
        cache.delete(key);
        cache.set(key, entry);
        return entry.value;
    }

    function cacheSet(cache, key, value) {
        if (cache.size >= CACHE_MAX) {
            const oldest = cache.keys().next().value;
            cache.delete(oldest);
        }
        cache.set(key, { ts: Date.now(), value });
    }

    function chunkArray(values, size) {
        const chunks = [];
        for (let index = 0; index < values.length; index += size) {
            chunks.push(values.slice(index, index + size));
        }
        return chunks;
    }

    function formatDuration(milliseconds) {
        const totalSeconds = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${String(seconds).padStart(2, "0")}`;
    }

    function stripHtml(value) {
        if (!value) return "";
        return String(value)
            .replace(/<[^>]+>/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, "\"")
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, " ")
            .trim();
    }

    function spotifyImageUriToUrl(value) {
        if (!value || typeof value !== "string") return "";
        return value.startsWith("spotify:image:")
            ? `https://i.scdn.co/image/${value.split(":").pop()}`
            : value;
    }

    function pickFirstImage(candidates) {
        for (const candidate of candidates) {
            if (!candidate) continue;
            if (typeof candidate === "string") {
                const direct = spotifyImageUriToUrl(candidate);
                if (direct) return direct;
                continue;
            }
            const nested = spotifyImageUriToUrl(
                candidate.url ||
                candidate.uri ||
                candidate.imageUrl ||
                candidate.src ||
                ""
            );
            if (nested) return nested;
        }
        return "";
    }

    function getUriId(uri) {
        if (!uri || typeof uri !== "string") return "";
        try {
            if (typeof Spicetify !== "undefined" && Spicetify.URI?.fromString) {
                const parsed = Spicetify.URI.fromString(uri);
                return parsed?.id || parsed?.getBase62Id?.() || uri.split(":").pop() || "";
            }
        } catch (error) {
            console.warn("Symphona: failed to parse URI", uri, error);
        }
        return uri.split(":").pop() || "";
    }

    function buildPlaylistUri(id) {
        return id ? `spotify:playlist:${id}` : "";
    }

    function isPlaylistUri(uri) {
        if (!uri || typeof uri !== "string") return false;
        try {
            if (typeof Spicetify !== "undefined" && Spicetify.URI?.isPlaylistV1OrV2) {
                return Spicetify.URI.isPlaylistV1OrV2(uri);
            }
        } catch (error) {
            console.warn("Symphona: playlist URI detection failed", uri, error);
        }
        return /^spotify:playlist:/.test(uri);
    }

    function normalizeView(view) {
        return VALID_VIEWS.has(view) ? view : "shared";
    }

    function buildSymphonaRoute(leftUri, rightUri, view = "shared") {
        const leftId = getUriId(leftUri);
        const rightId = getUriId(rightUri);
        return `${ROUTE_PREFIX}/${leftId}/${rightId}?view=${normalizeView(view)}`;
    }

    function parseSymphonaRoute(input) {
        const fallback = {
            isSymphonaRoute: false,
            leftId: "",
            leftUri: "",
            rightId: "",
            rightUri: "",
            view: "shared",
        };

        const pathname = typeof input === "string"
            ? input.split("?")[0] || ""
            : input?.pathname || "";
        const rawSearch = typeof input === "string"
            ? input.includes("?") ? `?${input.split("?").slice(1).join("?")}` : ""
            : input?.search || "";

        const match = pathname.match(/^\/symphona\/([^/]+)\/([^/]+)$/);
        if (!match) return fallback;

        const params = new URLSearchParams(rawSearch.startsWith("?") ? rawSearch.slice(1) : rawSearch);
        const leftId = decodeURIComponent(match[1]);
        const rightId = decodeURIComponent(match[2]);

        return {
            isSymphonaRoute: true,
            leftId,
            leftUri: buildPlaylistUri(leftId),
            rightId,
            rightUri: buildPlaylistUri(rightId),
            view: normalizeView(params.get("view") || "shared"),
        };
    }

    function normalizeTrackArtists(source) {
        const artists = Array.isArray(source?.artists)
            ? source.artists
            : Array.isArray(source?.artist)
                ? source.artist
                : [];

        return artists
            .map((artist) => artist?.profile?.name || artist?.name || artist?.label || "")
            .filter(Boolean);
    }

    function normalizeTrackItem(item, position) {
        const source = item?.item || item?.track || item;
        const uri = source?.uri || item?.uri || "";
        if (!uri || !/^spotify:(track|local):/.test(uri)) return null;

        const album = source?.album || item?.album || {};
        const image = pickFirstImage([
            source?.imageUrl,
            source?.imageUri,
            ...(Array.isArray(album?.images) ? album.images : []),
            ...(Array.isArray(album?.coverArt?.sources) ? album.coverArt.sources : []),
            ...(Array.isArray(source?.coverArt?.sources) ? source.coverArt.sources : []),
        ]);

        return {
            albumName: album?.name || "Unknown album",
            albumUri: album?.uri || "",
            artists: normalizeTrackArtists(source),
            durationMs: Number(
                source?.duration_ms ||
                source?.durationMs ||
                source?.duration?.milliseconds ||
                source?.duration?.totalMilliseconds ||
                item?.duration_ms ||
                0
            ),
            explicit: Boolean(
                source?.isExplicit ||
                source?.explicit ||
                source?.contentRating?.label === "EXPLICIT"
            ),
            image,
            name: source?.name || source?.metadata?.title || item?.name || "Unknown track",
            order: position + 1,
            uri,
        };
    }

    function normalizePlaylistMetadata(meta, fallbackUri) {
        return {
            description: stripHtml(meta?.description || ""),
            image: pickFirstImage([
                ...(Array.isArray(meta?.images) ? meta.images : []),
                ...(Array.isArray(meta?.image?.sources) ? meta.image.sources : []),
                ...(Array.isArray(meta?.coverArt?.sources) ? meta.coverArt.sources : []),
            ]),
            isCollaborative: Boolean(meta?.isCollaborative || meta?.canAdd),
            name: meta?.name || "Untitled playlist",
            ownerName:
                meta?.owner?.displayName ||
                meta?.owner?.name ||
                meta?.ownerName ||
                "Spotify",
            totalLength: Number(meta?.totalLength || meta?.length || meta?.trackCount || 0),
            uri: meta?.uri || fallbackUri || "",
        };
    }

    function mergeTrackDetails(primary, secondary) {
        return {
            albumName:
                primary.albumName && primary.albumName !== "Unknown album"
                    ? primary.albumName
                    : secondary.albumName || "Unknown album",
            albumUri: primary.albumUri || secondary.albumUri || "",
            artists: primary.artists?.length ? primary.artists : secondary.artists || [],
            durationMs: primary.durationMs || secondary.durationMs || 0,
            explicit: Boolean(primary.explicit || secondary.explicit),
            image: primary.image || secondary.image || "",
            name: primary.name || secondary.name || "Unknown track",
            order: primary.order,
            uri: primary.uri,
        };
    }

    function toUniqueTrackCollection(tracks) {
        const ordered = [];
        const byUri = new Map();

        for (const track of tracks || []) {
            if (!track?.uri || byUri.has(track.uri)) continue;

            const normalized = {
                albumName: track.albumName || "Unknown album",
                albumUri: track.albumUri || "",
                artists: Array.isArray(track.artists) ? track.artists : [],
                durationMs: Number(track.durationMs || 0),
                explicit: Boolean(track.explicit),
                image: track.image || "",
                name: track.name || "Unknown track",
                order: Number(track.order || ordered.length + 1),
                uri: track.uri,
            };

            byUri.set(normalized.uri, normalized);
            ordered.push(normalized);
        }

        return { byUri, ordered };
    }

    function compareTrackCollections(leftTracks, rightTracks) {
        const left = toUniqueTrackCollection(leftTracks);
        const right = toUniqueTrackCollection(rightTracks);
        const intersection = [];
        const leftOnly = [];
        const rightOnly = [];

        for (const leftTrack of left.ordered) {
            const rightTrack = right.byUri.get(leftTrack.uri);
            if (rightTrack) {
                intersection.push({
                    ...mergeTrackDetails(leftTrack, rightTrack),
                    leftIndex: leftTrack.order,
                    rightIndex: rightTrack.order,
                });
                continue;
            }

            leftOnly.push({
                ...leftTrack,
                leftIndex: leftTrack.order,
                rightIndex: null,
            });
        }

        for (const rightTrack of right.ordered) {
            if (left.byUri.has(rightTrack.uri)) continue;
            rightOnly.push({
                ...rightTrack,
                leftIndex: null,
                rightIndex: rightTrack.order,
            });
        }

        return {
            intersection,
            leftOnly,
            rightOnly,
            uniqueLeftCount: left.ordered.length,
            uniqueRightCount: right.ordered.length,
        };
    }

    return {
        buildPlaylistUri,
        buildSymphonaRoute,
        cacheGet,
        cacheSet,
        chunkArray,
        compareTrackCollections,
        formatDuration,
        getUriId,
        isPlaylistUri,
        normalizePlaylistMetadata,
        normalizeTrackItem,
        parseSymphonaRoute,
        spotifyImageUriToUrl,
        stripHtml,
    };
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = SymphonaCore;
}

(async function Symphona() {
    if (typeof Spicetify === "undefined") return;

    const {
        ContextMenu,
        LocalStorage,
        Platform,
        React: react,
        ReactDOM: reactDOM,
    } = Spicetify;

    if (!(ContextMenu && LocalStorage && Platform && react && reactDOM)) {
        setTimeout(Symphona, 300);
        return;
    }

    if (globalThis.__symphonaRegistered) return;
    globalThis.__symphonaRegistered = true;

    const {
        buildSymphonaRoute,
        cacheGet,
        cacheSet,
        chunkArray,
        compareTrackCollections,
        formatDuration,
        getUriId,
        isPlaylistUri,
        normalizePlaylistMetadata,
        normalizeTrackItem,
        parseSymphonaRoute,
    } = SymphonaCore;

    const META_CACHE = new Map();
    const TRACK_CACHE = new Map();
    const TRACK_LOADS = new Map();
    const STORAGE_KEYS = {
        name: "symphona:selected-name",
        uri: "symphona:selected-uri",
    };
    const STYLE_ID = "symphona-route-styles";
    const ROOT_ID = "symphona-route-root";
    const STICKY_TOP = 64;

    let selectedPlaylistUri = LocalStorage.get(STORAGE_KEYS.uri) || "";
    let selectedPlaylistName = LocalStorage.get(STORAGE_KEYS.name) || "";
    let mountNode = null;
    let mountParent = null;
    let reactRoot = null;
    let routeObserver = null;
    let renderToken = 0;
    let compareContextMenu = { name: "Symphona: Compare with selected playlist" };

    const startTransition = typeof react.startTransition === "function"
        ? react.startTransition
        : (callback) => callback();
    const useDeferredValue = typeof react.useDeferredValue === "function"
        ? react.useDeferredValue
        : (value) => value;

    function getSelectionLabel() {
        if (!selectedPlaylistName) return "selected playlist";
        return selectedPlaylistName.length > 32
            ? `${selectedPlaylistName.slice(0, 29)}…`
            : selectedPlaylistName;
    }

    function resolveErrorMessage(error) {
        if (error?.message) return error.message;
        return typeof error === "string" ? error : "Something went wrong while comparing these playlists.";
    }

    function pluralize(count, singular, plural = `${singular}s`) {
        return `${count} ${count === 1 ? singular : plural}`;
    }

    function playlistHref(uri) {
        const id = getUriId(uri);
        return id ? `/playlist/${id}` : "/";
    }

    function trackHref(uri) {
        const id = getUriId(uri);
        return id ? `/track/${id}` : "/";
    }

    function openPlaylist(uri) {
        const href = playlistHref(uri);
        if (href) Platform.History.push(href);
    }

    function playTrack(uri) {
        if (!uri) return;
        Spicetify.Player?.playUri?.(uri);
    }

    function syncSelectionState(uri, name) {
        selectedPlaylistUri = uri || "";
        selectedPlaylistName = name || "";

        if (selectedPlaylistUri) {
            LocalStorage.set(STORAGE_KEYS.uri, selectedPlaylistUri);
            LocalStorage.set(STORAGE_KEYS.name, selectedPlaylistName);
        } else {
            LocalStorage.remove(STORAGE_KEYS.uri);
            LocalStorage.remove(STORAGE_KEYS.name);
        }

        compareContextMenu.name = selectedPlaylistUri
            ? `Symphona: Compare with ${getSelectionLabel()}`
            : "Symphona: Compare with selected playlist";
    }

    async function fetchPlaylistMetadata(uri) {
        const cached = cacheGet(META_CACHE, uri);
        if (cached) return cached;

        const raw = await Platform.PlaylistAPI.getMetadata(uri);
        const normalized = normalizePlaylistMetadata(raw, uri);
        cacheSet(META_CACHE, uri, normalized);
        return normalized;
    }

    async function fetchAllPlaylistTracks(uri, totalHint, onProgress) {
        const cached = cacheGet(TRACK_CACHE, uri);
        if (cached) {
            onProgress?.({
                cached: true,
                processed: cached.length,
                total: Math.max(Number(totalHint || 0), cached.length),
            });
            return cached;
        }

        if (TRACK_LOADS.has(uri)) {
            return TRACK_LOADS.get(uri);
        }

        const loadPromise = (async () => {
            const limit = 100;
            let offset = 0;
            let total = Number(totalHint || 0);
            const tracks = [];

            while (true) {
                const response = await Platform.PlaylistAPI.getContents(uri, { limit, offset });
                const items = Array.isArray(response?.items) ? response.items : [];
                total = Number(response?.totalLength || response?.total || total || items.length);

                items.forEach((item, index) => {
                    const track = normalizeTrackItem(item, offset + index);
                    if (track) tracks.push(track);
                });

                const processed = offset + items.length;
                onProgress?.({
                    cached: false,
                    processed,
                    total: Math.max(total, processed),
                });

                if (!items.length || items.length < limit) break;
                offset += items.length;
            }

            cacheSet(TRACK_CACHE, uri, tracks);
            return tracks;
        })().finally(() => {
            TRACK_LOADS.delete(uri);
        });

        TRACK_LOADS.set(uri, loadPromise);
        return loadPromise;
    }

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
            /* ── Scrollbar: invisible everywhere ── */
            #${ROOT_ID},
            .symphona-page,
            .symphona-resultsCard {
                scrollbar-width: none;
                -ms-overflow-style: none;
            }
            #${ROOT_ID}::-webkit-scrollbar,
            .symphona-page::-webkit-scrollbar,
            .symphona-resultsCard::-webkit-scrollbar { display: none; }

            /* ── Root ── */
            #${ROOT_ID} { min-height: 100%; }

            .symphona-page {
                background: var(--spice-main);
                box-sizing: border-box;
                color: var(--spice-text);
                min-height: 100%;
                padding: 40px 28px 96px;
            }

            .symphona-pageInner {
                display: flex;
                flex-direction: column;
                gap: 20px;
                margin: 0 auto;
                max-width: 1440px;
            }

            /* ── Hero: two playlists side by side, no outer card box ── */
            .symphona-hero {
                display: grid;
                gap: 2px;
                grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
            }

            .symphona-divider { display: none; }

            /* No card box on hero — just slight inner surface */
            .symphona-heroCard {
                align-items: flex-start;
                background: rgba(var(--spice-rgb-main-elevated), 0.45);
                border-radius: 14px;
                display: flex;
                flex-direction: row;
                gap: 18px;
                min-width: 0;
                padding: 20px;
                transition: background 180ms ease;
            }
            .symphona-heroCard:hover { background: rgba(var(--spice-rgb-main-elevated), 0.65); }

            .symphona-cover {
                aspect-ratio: 1;
                background: rgba(var(--spice-rgb-selected-row), 0.3);
                border-radius: 10px;
                display: block;
                flex-shrink: 0;
                height: auto;
                object-fit: cover;
                width: 100px;
            }

            .symphona-coverFallback {
                align-items: center;
                color: var(--spice-subtext);
                display: flex;
                font-size: 11px;
                font-weight: 700;
                justify-content: center;
                letter-spacing: 0.12em;
                text-transform: uppercase;
            }

            .symphona-heroBody {
                display: flex;
                flex-direction: column;
                gap: 6px;
                justify-content: center;
                min-width: 0;
                padding-top: 2px;
            }

            .symphona-label {
                color: var(--spice-subtext);
                font-size: 10px;
                font-weight: 700;
                letter-spacing: 0.18em;
                margin: 0;
                text-transform: uppercase;
            }

            /* Title is now a link */
            .symphona-titleLink {
                color: inherit;
                text-decoration: none;
            }
            .symphona-titleLink:hover .symphona-title {
                text-decoration: underline;
                text-underline-offset: 4px;
            }

            .symphona-title {
                font-size: clamp(20px, 2.8vw, 38px);
                font-weight: 900;
                letter-spacing: -0.04em;
                line-height: 1;
                margin: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .symphona-description {
                color: var(--spice-subtext);
                font-size: 13px;
                line-height: 1.5;
                margin: 0;
                max-width: 40ch;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .symphona-meta {
                color: var(--spice-subtext);
                font-size: 13px;
                line-height: 1.5;
                margin: 0;
            }

            .symphona-meta strong {
                color: var(--spice-text);
                font-weight: 600;
            }

            /* ── Actions / buttons / tabs ── */
            .symphona-actions,
            .symphona-toolbarLeft,
            .symphona-toolbarRight,
            .symphona-tabs,
            .symphona-mobileMeta {
                align-items: center;
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
            }

            .symphona-tab,
            .symphona-button,
            .symphona-chip {
                align-items: center;
                border-radius: 999px;
                box-sizing: border-box;
                display: inline-flex;
                font-size: 11px;
                font-weight: 700;
                gap: 6px;
                letter-spacing: 0.07em;
                min-height: 34px;
                padding: 0 13px;
                text-decoration: none;
                text-transform: uppercase;
            }

            .symphona-tab,
            .symphona-chip {
                background: transparent;
                border: 1px solid rgba(var(--spice-rgb-text), 0.1);
                color: var(--spice-subtext);
            }

            .symphona-tab {
                cursor: pointer;
                touch-action: manipulation;
                transition: background 150ms ease, border-color 150ms ease, color 150ms ease;
                -webkit-tap-highlight-color: transparent;
            }

            .symphona-tab:hover {
                background: rgba(var(--spice-rgb-card), 0.5);
                border-color: rgba(var(--spice-rgb-text), 0.2);
                color: var(--spice-text);
            }

            .symphona-tab.is-active {
                background: rgba(var(--spice-rgb-text), 0.1);
                border-color: rgba(var(--spice-rgb-text), 0.22);
                color: var(--spice-text);
                font-weight: 800;
            }

            .symphona-button {
                border: 1px solid transparent;
                cursor: pointer;
                touch-action: manipulation;
                transition: background 150ms ease, filter 150ms ease, transform 150ms ease;
                -webkit-tap-highlight-color: transparent;
            }

            .symphona-button--ghost {
                background: rgba(var(--spice-rgb-card), 0.45);
                border-color: rgba(var(--spice-rgb-text), 0.1);
                color: var(--spice-text);
            }
            .symphona-button--ghost:hover:not(:disabled) {
                background: rgba(var(--spice-rgb-card), 0.75);
            }

            .symphona-button--primary {
                background: var(--spice-button);
                color: var(--spice-button-text);
                font-size: 12px;
                font-weight: 800;
                min-height: 36px;
                padding: 0 18px;
            }
            .symphona-button--primary:hover:not(:disabled) {
                filter: brightness(1.06);
                transform: translateY(-1px);
            }

            .symphona-button:focus-visible,
            .symphona-tab:focus-visible {
                outline: 2px solid rgba(var(--spice-rgb-button), 0.8);
                outline-offset: 3px;
            }

            .symphona-button:disabled {
                cursor: not-allowed;
                opacity: 0.45;
                transform: none !important;
            }

            /* ── Toolbar: sticky, minimal, no heavy card ── */
            .symphona-toolbar {
                align-items: center;
                background: rgba(var(--spice-rgb-main), 0.88);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
                border-bottom: 1px solid rgba(var(--spice-rgb-text), 0.06);
                border-radius: 0;
                box-shadow: none;
                display: flex;
                flex-wrap: wrap;
                gap: 12px;
                justify-content: space-between;
                padding: 10px 4px;
                position: sticky;
                top: ${STICKY_TOP}px;
                z-index: 5;
            }

            .symphona-toolbarLeft,
            .symphona-toolbarRight { gap: 8px; }

            /* Removed: .symphona-toolbarText — no hint paragraph */

            /* ── Summary: open text, no card box ── */
            .symphona-summary {
                display: flex;
                flex-direction: column;
                gap: 6px;
                padding: 8px 0 4px;
            }

            .symphona-summaryEyebrow {
                color: var(--spice-subtext);
                font-size: 10px;
                font-weight: 700;
                letter-spacing: 0.18em;
                margin: 0;
                text-transform: uppercase;
            }

            .symphona-summaryTitle {
                font-size: clamp(24px, 2.6vw, 44px);
                font-weight: 900;
                letter-spacing: -0.04em;
                line-height: 1;
                margin: 0;
                text-wrap: balance;
            }

            .symphona-summaryBody {
                color: var(--spice-subtext);
                font-size: 14px;
                line-height: 1.6;
                margin: 0;
                max-width: 60ch;
            }

            .symphona-inlineChips {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                margin-top: 2px;
            }

            .symphona-chip {
                font-size: 10px;
                min-height: 26px;
                padding: 0 10px;
            }

            /* ── GitHub icon link ── */
            .symphona-githubLink {
                align-items: center;
                border-radius: 999px;
                color: var(--spice-subtext);
                display: inline-flex;
                height: 32px;
                justify-content: center;
                text-decoration: none;
                transition: color 150ms ease, background 150ms ease;
                width: 32px;
            }
            .symphona-githubLink:hover {
                background: rgba(var(--spice-rgb-text), 0.08);
                color: var(--spice-text);
            }

            /* ── Track results: card with no border ── */
            .symphona-card {
                background: rgba(var(--spice-rgb-main-elevated), 0.55);
                border: 1px solid rgba(var(--spice-rgb-text), 0.06);
                border-radius: 14px;
                box-shadow: none;
            }

            .symphona-resultsCard { overflow: hidden; }

            .symphona-resultsHeader,
            .symphona-trackRow {
                align-items: center;
                column-gap: 16px;
                display: grid;
                grid-template-columns: 56px minmax(0, 2.6fr) minmax(0, 1.4fr) 80px 56px;
            }

            .symphona-resultsHeader {
                border-bottom: 1px solid rgba(var(--spice-rgb-text), 0.06);
                color: var(--spice-subtext);
                font-size: 10px;
                font-weight: 700;
                letter-spacing: 0.14em;
                padding: 12px 18px 10px;
                text-transform: uppercase;
            }

            .symphona-trackRow {
                border-top: 1px solid rgba(var(--spice-rgb-text), 0.05);
                min-height: 68px;
                padding: 10px 18px;
                transition: background 120ms ease;
            }
            .symphona-trackRow:first-of-type { border-top: 0; }
            .symphona-trackRow:hover { background: rgba(var(--spice-rgb-card), 0.28); }
            .symphona-trackRow:focus-visible {
                outline: 2px solid rgba(var(--spice-rgb-button), 0.8);
                outline-offset: -2px;
            }

            .symphona-trackCell { min-width: 0; }

            .symphona-trackIndex,
            .symphona-trackDuration {
                color: var(--spice-subtext);
                font-feature-settings: "tnum";
                font-size: 13px;
                font-variant-numeric: tabular-nums;
                text-align: right;
            }

            .symphona-trackCell--track {
                align-items: center;
                display: flex;
                gap: 12px;
            }

            .symphona-trackArt {
                background: rgba(var(--spice-rgb-selected-row), 0.3);
                border-radius: 8px;
                flex-shrink: 0;
                height: 44px;
                object-fit: cover;
                width: 44px;
            }

            .symphona-trackArtFallback {
                align-items: center;
                color: var(--spice-subtext);
                display: flex;
                font-size: 10px;
                font-weight: 700;
                justify-content: center;
                letter-spacing: 0.1em;
                text-transform: uppercase;
            }

            .symphona-trackCopy {
                display: flex;
                flex: 1 1 auto;
                flex-direction: column;
                gap: 3px;
                min-width: 0;
            }

            .symphona-trackTitleLine {
                align-items: center;
                display: flex;
                gap: 8px;
                min-width: 0;
            }

            .symphona-trackTitleLink {
                color: inherit;
                min-width: 0;
                text-decoration: none;
            }
            .symphona-trackTitleLink:hover { text-decoration: underline; }

            .symphona-trackTitle {
                display: block;
                font-size: 15px;
                font-weight: 600;
                line-height: 1.3;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .symphona-trackArtists,
            .symphona-trackAlbum {
                color: var(--spice-subtext);
                font-size: 13px;
                line-height: 1.4;
                margin: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .symphona-trackAlbum strong {
                color: var(--spice-text);
                font-weight: 500;
            }

            .symphona-mobileMeta {
                display: none;
                gap: 6px;
                margin-top: 4px;
            }

            /* ── State panels (loading / empty / error) ── */
            .symphona-state {
                display: grid;
                gap: 14px;
                padding: 28px 24px;
            }

            .symphona-stateTitle {
                font-size: 22px;
                font-weight: 800;
                letter-spacing: -0.03em;
                line-height: 1.1;
                margin: 0;
            }

            .symphona-stateText {
                color: var(--spice-subtext);
                font-size: 14px;
                line-height: 1.65;
                margin: 0;
                max-width: 56ch;
            }

            .symphona-progressStack { display: grid; gap: 14px; }

            .symphona-progressLabel {
                align-items: center;
                color: var(--spice-subtext);
                display: flex;
                font-size: 12px;
                font-weight: 600;
                justify-content: space-between;
                line-height: 1.5;
                margin-bottom: 6px;
            }

            .symphona-progressRail {
                background: rgba(var(--spice-rgb-text), 0.07);
                border-radius: 999px;
                height: 4px;
                overflow: hidden;
            }

            .symphona-progressBar {
                background: var(--spice-button);
                border-radius: inherit;
                height: 100%;
                transition: width 200ms ease;
            }

            .symphona-stateActions {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
            }

            /* ── Responsive ── */
            @media (max-width: 1100px) {
                .symphona-page { padding-inline: 20px; }

                .symphona-hero {
                    gap: 2px;
                    grid-template-columns: 1fr;
                }

                .symphona-cover { width: 80px; }
            }

            @media (max-width: 860px) {
                .symphona-page { padding: 20px 14px 80px; }
                .symphona-pageInner { gap: 16px; }

                .symphona-cover { width: 70px; }

                .symphona-title { font-size: clamp(18px, 7vw, 30px); }

                .symphona-toolbar {
                    padding: 8px 0;
                    position: static;
                }

                .symphona-resultsHeader { display: none; }

                .symphona-trackRow {
                    gap: 10px;
                    grid-template-columns: 1fr;
                    padding: 12px 16px;
                }

                .symphona-trackCell--leftIndex,
                .symphona-trackCell--album,
                .symphona-trackCell--duration,
                .symphona-trackCell--rightIndex { display: none; }

                .symphona-mobileMeta { display: flex; }

                .symphona-trackTitle,
                .symphona-trackArtists { white-space: normal; }
            }

            @media (prefers-reduced-motion: reduce) {
                .symphona-button,
                .symphona-tab,
                .symphona-trackRow,
                .symphona-progressBar { transition: none; }

                .symphona-button--primary:hover:not(:disabled) { transform: none; }
            }
        `;

        document.head.appendChild(style);
    }

    function getMainMountParent() {
        return document.querySelector("main")
            || document.querySelector("[role='main']")
            || document.querySelector(".Root__main-view");
    }

    function disconnectRouteObserver() {
        if (routeObserver) {
            routeObserver.disconnect();
            routeObserver = null;
        }
    }

    function ensureRouteObserver() {
        disconnectRouteObserver();
        routeObserver = new MutationObserver(() => {
            const parsed = parseSymphonaRoute(Platform.History.location);
            if (!parsed.isSymphonaRoute) return;
            if (mountNode && mountNode.isConnected) return;
            scheduleRouteRender(Platform.History.location);
        });
        routeObserver.observe(document.body, { childList: true, subtree: true });
    }

    function unmountRoute() {
        disconnectRouteObserver();

        if (reactRoot && mountNode) {
            if (typeof reactRoot.unmount === "function") {
                reactRoot.unmount();
            } else {
                reactDOM.unmountComponentAtNode(mountNode);
            }
        }

        reactRoot = null;

        if (mountParent) {
            toggleNativePageVisibility(mountParent, false);
        }

        if (mountNode?.isConnected) {
            mountNode.remove();
        }

        mountNode = null;
        mountParent = null;
    }

    function toggleNativePageVisibility(parent, hidden) {
        for (const child of Array.from(parent.children)) {
            if (child === mountNode) continue;

            if (hidden) {
                if (child.dataset.symphonaHidden === "true") continue;
                child.dataset.symphonaHidden = "true";
                child.dataset.symphonaPrevDisplay = child.style.display || "";
                child.style.display = "none";
                continue;
            }

            if (child.dataset.symphonaHidden !== "true") continue;
            const previousDisplay = child.dataset.symphonaPrevDisplay || "";
            if (previousDisplay) {
                child.style.display = previousDisplay;
            } else {
                child.style.removeProperty("display");
            }
            delete child.dataset.symphonaHidden;
            delete child.dataset.symphonaPrevDisplay;
        }
    }

    function PageLink({ className, href, title, children }) {
        return react.createElement(
            "a",
            {
                className,
                href,
                onClick: (event) => {
                    event.preventDefault();
                    Platform.History.push(href);
                },
                title,
            },
            children
        );
    }

    function HeroCard({ label, playlist }) {
        return react.createElement(
            "section",
            { className: "symphona-heroCard" },
            playlist.image
                ? react.createElement("img", {
                    alt: `${playlist.name} artwork`,
                    className: "symphona-cover",
                    height: "200",
                    src: playlist.image,
                    width: "200",
                })
                : react.createElement("div", { className: "symphona-cover symphona-coverFallback" }, "No Cover"),
            react.createElement(
                "div",
                { className: "symphona-heroBody" },
                react.createElement("p", { className: "symphona-label" }, label),
                react.createElement(
                    PageLink,
                    {
                        className: "symphona-titleLink",
                        href: playlistHref(playlist.uri),
                        title: `Open ${playlist.name}`,
                    },
                    react.createElement("h1", { className: "symphona-title" }, playlist.name)
                ),
                playlist.description
                    ? react.createElement("p", { className: "symphona-description" }, playlist.description)
                    : null,
                react.createElement(
                    "p",
                    { className: "symphona-meta" },
                    react.createElement("strong", null, playlist.ownerName),
                    ` ${String.fromCharCode(8226)} ${pluralize(playlist.totalLength, "song")}`
                )
            )
        );
    }

    function StatCard({ label, value }) {
        return react.createElement(
            "div",
            { className: "symphona-stat" },
            react.createElement("span", { className: "symphona-statValue" }, value),
            react.createElement("span", { className: "symphona-statLabel" }, label)
        );
    }

    function TrackRow({ track }) {
        return react.createElement(
            "div",
            {
                className: "symphona-trackRow",
                onDoubleClick: () => playTrack(track.uri),
                onKeyDown: (event) => {
                    if (event.key !== "Enter") return;
                    if (event.target?.closest?.("a,button")) return;
                    event.preventDefault();
                    playTrack(track.uri);
                },
                tabIndex: 0,
            },
            react.createElement(
                "div",
                { className: "symphona-trackCell symphona-trackCell--leftIndex symphona-trackIndex" },
                track.leftIndex ?? "-"
            ),
            react.createElement(
                "div",
                { className: "symphona-trackCell symphona-trackCell--track" },
                track.image
                    ? react.createElement("img", {
                        alt: "",
                        className: "symphona-trackArt",
                        height: "52",
                        src: track.image,
                        width: "52",
                    })
                    : react.createElement("div", { className: "symphona-trackArt symphona-trackArtFallback" }, "Track"),
                react.createElement(
                    "div",
                    { className: "symphona-trackCopy" },
                    react.createElement(
                        "div",
                        { className: "symphona-trackTitleLine" },
                        react.createElement(
                            PageLink,
                            {
                                className: "symphona-trackTitleLink",
                                href: trackHref(track.uri),
                                title: `Open ${track.name}`,
                            },
                            react.createElement("span", { className: "symphona-trackTitle" }, track.name)
                        ),
                        track.explicit
                            ? react.createElement("span", { className: "symphona-chip" }, "Explicit")
                            : null
                    ),
                    react.createElement(
                        "p",
                        { className: "symphona-trackArtists" },
                        track.artists?.length ? track.artists.join(", ") : "Unknown artist"
                    ),
                    react.createElement(
                        "div",
                        { className: "symphona-mobileMeta" },
                        track.leftIndex != null
                            ? react.createElement("span", { className: "symphona-chip" }, `First #${track.leftIndex}`)
                            : null,
                        track.rightIndex != null
                            ? react.createElement("span", { className: "symphona-chip" }, `Second #${track.rightIndex}`)
                            : null,
                        react.createElement("span", { className: "symphona-chip" }, formatDuration(track.durationMs))
                    )
                )
            ),
            react.createElement(
                "div",
                { className: "symphona-trackCell symphona-trackCell--album" },
                react.createElement("p", { className: "symphona-trackAlbum", title: track.albumName }, track.albumName || "Unknown album")
            ),
            react.createElement(
                "div",
                { className: "symphona-trackCell symphona-trackCell--duration symphona-trackDuration" },
                formatDuration(track.durationMs)
            ),
            react.createElement(
                "div",
                { className: "symphona-trackCell symphona-trackCell--rightIndex symphona-trackIndex" },
                track.rightIndex ?? "-"
            )
        );
    }

    function LoadingPanel({ leftMeta, rightMeta, progress }) {
        const leftTotal = Math.max(progress.leftTotal || 0, progress.leftProcessed || 0, leftMeta?.totalLength || 0);
        const rightTotal = Math.max(progress.rightTotal || 0, progress.rightProcessed || 0, rightMeta?.totalLength || 0);
        const leftRatio = leftTotal ? Math.min(100, Math.round((progress.leftProcessed / leftTotal) * 100)) : 0;
        const rightRatio = rightTotal ? Math.min(100, Math.round((progress.rightProcessed / rightTotal) * 100)) : 0;

        return react.createElement(
            "section",
            { className: "symphona-card symphona-state", "aria-live": "polite" },
            react.createElement("p", { className: "symphona-summaryEyebrow" }, "Loading comparison"),
            react.createElement("h2", { className: "symphona-stateTitle" }, "Pulling both playlists into the workspace."),
            react.createElement(
                "p",
                { className: "symphona-stateText" },
                "Symphona is paging through each playlist once, then it will reuse the cached result when you switch views or revisit the same pair."
            ),
            react.createElement(
                "div",
                { className: "symphona-progressStack" },
                react.createElement(
                    "div",
                    null,
                    react.createElement(
                        "div",
                        { className: "symphona-progressLabel" },
                        react.createElement("span", null, leftMeta?.name || "First playlist"),
                        react.createElement("span", null, `${progress.leftProcessed || 0}/${leftTotal || 0}`)
                    ),
                    react.createElement(
                        "div",
                        { className: "symphona-progressRail" },
                        react.createElement("div", {
                            className: "symphona-progressBar",
                            style: { width: `${leftRatio}%` },
                        })
                    )
                ),
                react.createElement(
                    "div",
                    null,
                    react.createElement(
                        "div",
                        { className: "symphona-progressLabel" },
                        react.createElement("span", null, rightMeta?.name || "Second playlist"),
                        react.createElement("span", null, `${progress.rightProcessed || 0}/${rightTotal || 0}`)
                    ),
                    react.createElement(
                        "div",
                        { className: "symphona-progressRail" },
                        react.createElement("div", {
                            className: "symphona-progressBar",
                            style: { width: `${rightRatio}%` },
                        })
                    )
                )
            )
        );
    }

    function EmptyPanel({ title, text, leftUri, rightUri }) {
        return react.createElement(
            "section",
            { className: "symphona-card symphona-state" },
            react.createElement("p", { className: "symphona-summaryEyebrow" }, "No tracks in this view"),
            react.createElement("h2", { className: "symphona-stateTitle" }, title),
            react.createElement("p", { className: "symphona-stateText" }, text),
            react.createElement(
                "div",
                { className: "symphona-stateActions" },
                leftUri
                    ? react.createElement(PageLink, {
                        className: "symphona-link",
                        href: playlistHref(leftUri),
                        title: "Open first playlist",
                    }, "Open First Playlist")
                    : null,
                rightUri
                    ? react.createElement(PageLink, {
                        className: "symphona-link",
                        href: playlistHref(rightUri),
                        title: "Open second playlist",
                    }, "Open Second Playlist")
                    : null
            )
        );
    }

    function ErrorPanel({ message, leftUri, rightUri }) {
        return react.createElement(
            "section",
            { className: "symphona-card symphona-state", "aria-live": "polite" },
            react.createElement("p", { className: "symphona-summaryEyebrow" }, "Something went wrong"),
            react.createElement("h2", { className: "symphona-stateTitle" }, "Symphona could not finish this comparison."),
            react.createElement("p", { className: "symphona-stateText" }, message),
            react.createElement(
                "div",
                { className: "symphona-stateActions" },
                leftUri
                    ? react.createElement(PageLink, {
                        className: "symphona-link",
                        href: playlistHref(leftUri),
                        title: "Open first playlist",
                    }, "Open First Playlist")
                    : null,
                rightUri
                    ? react.createElement(PageLink, {
                        className: "symphona-link",
                        href: playlistHref(rightUri),
                        title: "Open second playlist",
                    }, "Open Second Playlist")
                    : null
            )
        );
    }

    function getViewModel(activeView, leftMeta, rightMeta, comparison) {
        const sharedCount = comparison?.intersection?.length || 0;
        const leftCount = comparison?.leftOnly?.length || 0;
        const rightCount = comparison?.rightOnly?.length || 0;
        const leftName = leftMeta?.name || "the first playlist";
        const rightName = rightMeta?.name || "the second playlist";

        if (activeView === "left") {
            return {
                emptyText: `Everything in ${leftName} already appears in ${rightName}.`,
                emptyTitle: `No tracks are unique to ${leftName}.`,
                summaryEyebrow: "Only in First",
                summaryText: `${pluralize(leftCount, "track")} stay unique to ${leftName}. Double-click any row to play it instantly or keep switching views without leaving the comparison.`,
                summaryTitle: `${pluralize(leftCount, "song")} only live in ${leftName}.`,
                tracks: comparison?.leftOnly || [],
            };
        }

        if (activeView === "right") {
            return {
                emptyText: `Everything in ${rightName} already appears in ${leftName}.`,
                emptyTitle: `No tracks are unique to ${rightName}.`,
                summaryEyebrow: "Only in Second",
                summaryText: `${pluralize(rightCount, "track")} stay unique to ${rightName}. Double-click any row to play it instantly or keep switching views without leaving the comparison.`,
                summaryTitle: `${pluralize(rightCount, "song")} only live in ${rightName}.`,
                tracks: comparison?.rightOnly || [],
            };
        }

        return {
            emptyText: `${leftName} and ${rightName} do not share any tracks yet.`,
            emptyTitle: "Nothing overlaps between these playlists.",
            summaryEyebrow: "Shared",
            summaryText: `${pluralize(sharedCount, "track")} appear in both playlists. Keep this page open while you compare, switch views, and jump back to the original playlists when you need more context.`,
            summaryTitle: `${pluralize(sharedCount, "song")} appear in both playlists.`,
            tracks: comparison?.intersection || [],
        };
    }

    function replaceRoute(href) {
        if (typeof Platform.History.replace === "function") {
            Platform.History.replace(href);
            return;
        }
        Platform.History.push(href);
    }

    function scrollMainViewToTop() {
        const viewport = document.querySelector(".Root__main-view [data-overlayscrollbars-viewport]")
            || document.querySelector(".Root__main-view .os-viewport")
            || document.querySelector("main");
        viewport?.scrollTo?.({ top: 0, behavior: "auto" });
    }

    function SymphonaPage({ routeInfo }) {
        const [state, setState] = react.useState({
            comparison: null,
            error: "",
            leftMeta: null,
            progress: {
                leftProcessed: 0,
                leftTotal: 0,
                rightProcessed: 0,
                rightTotal: 0,
            },
            rightMeta: null,
            status: "loading",
        });

        const deferredView = useDeferredValue(routeInfo.view);

        react.useEffect(() => {
            let cancelled = false;

            if (!routeInfo.leftUri || !routeInfo.rightUri) {
                setState({
                    comparison: null,
                    error: "This comparison link is missing one of its playlist ids.",
                    leftMeta: null,
                    progress: {
                        leftProcessed: 0,
                        leftTotal: 0,
                        rightProcessed: 0,
                        rightTotal: 0,
                    },
                    rightMeta: null,
                    status: "error",
                });
                return () => {
                    cancelled = true;
                };
            }

            if (routeInfo.leftUri === routeInfo.rightUri) {
                setState({
                    comparison: null,
                    error: "Choose two different playlists to compare. Symphona keeps shared and unique views for pairs, not a playlist against itself.",
                    leftMeta: null,
                    progress: {
                        leftProcessed: 0,
                        leftTotal: 0,
                        rightProcessed: 0,
                        rightTotal: 0,
                    },
                    rightMeta: null,
                    status: "error",
                });
                return () => {
                    cancelled = true;
                };
            }

            setState({
                comparison: null,
                error: "",
                leftMeta: null,
                progress: {
                    leftProcessed: 0,
                    leftTotal: 0,
                    rightProcessed: 0,
                    rightTotal: 0,
                },
                rightMeta: null,
                status: "loading",
            });

            (async () => {
                try {
                    const [leftMeta, rightMeta] = await Promise.all([
                        fetchPlaylistMetadata(routeInfo.leftUri),
                        fetchPlaylistMetadata(routeInfo.rightUri),
                    ]);
                    if (cancelled) return;

                    setState((current) => ({
                        ...current,
                        leftMeta,
                        progress: {
                            leftProcessed: 0,
                            leftTotal: leftMeta.totalLength,
                            rightProcessed: 0,
                            rightTotal: rightMeta.totalLength,
                        },
                        rightMeta,
                    }));

                    const updateProgress = (side) => (next) => {
                        if (cancelled) return;
                        setState((current) => ({
                            ...current,
                            progress: {
                                ...current.progress,
                                [`${side}Processed`]: next.processed,
                                [`${side}Total`]: next.total || current.progress[`${side}Total`],
                            },
                        }));
                    };

                    const [leftTracks, rightTracks] = await Promise.all([
                        fetchAllPlaylistTracks(routeInfo.leftUri, leftMeta.totalLength, updateProgress("left")),
                        fetchAllPlaylistTracks(routeInfo.rightUri, rightMeta.totalLength, updateProgress("right")),
                    ]);
                    if (cancelled) return;

                    setState({
                        comparison: compareTrackCollections(leftTracks, rightTracks),
                        error: "",
                        leftMeta,
                        progress: {
                            leftProcessed: leftTracks.length,
                            leftTotal: Math.max(leftMeta.totalLength, leftTracks.length),
                            rightProcessed: rightTracks.length,
                            rightTotal: Math.max(rightMeta.totalLength, rightTracks.length),
                        },
                        rightMeta,
                        status: "ready",
                    });
                } catch (error) {
                    if (cancelled) return;
                    setState({
                        comparison: null,
                        error: resolveErrorMessage(error),
                        leftMeta: null,
                        progress: {
                            leftProcessed: 0,
                            leftTotal: 0,
                            rightProcessed: 0,
                            rightTotal: 0,
                        },
                        rightMeta: null,
                        status: "error",
                    });
                }
            })();

            return () => {
                cancelled = true;
            };
        }, [routeInfo.leftUri, routeInfo.rightUri]);

        const viewModel = getViewModel(deferredView, state.leftMeta, state.rightMeta, state.comparison);
        const tabCounts = {
            left: state.comparison?.leftOnly?.length || 0,
            right: state.comparison?.rightOnly?.length || 0,
            shared: state.comparison?.intersection?.length || 0,
        };
        const resultTracks = viewModel.tracks;

        const handleViewChange = (nextView) => {
            if (nextView === routeInfo.view) return;
            startTransition(() => {
                replaceRoute(buildSymphonaRoute(routeInfo.leftUri, routeInfo.rightUri, nextView));
            });
        };

        return react.createElement(
            "div",
            { className: "symphona-page" },
            react.createElement(
                "div",
                { className: "symphona-pageInner" },
                state.leftMeta && state.rightMeta
                    ? react.createElement(
                        "section",
                        { className: "symphona-hero" },
                        react.createElement(HeroCard, {
                            label: "First playlist",
                            playlist: state.leftMeta,
                        }),
                        react.createElement("div", { className: "symphona-divider", "aria-hidden": "true" }),
                        react.createElement(HeroCard, {
                            label: "Second playlist",
                            playlist: state.rightMeta,
                        })
                    )
                    : null,
                state.comparison
                    ? react.createElement(
                        "section",
                        { className: "symphona-stats", "aria-label": "Comparison summary" },
                        null
                    )
                    : null,
                react.createElement(
                    "section",
                    { className: "symphona-toolbar" },
                    react.createElement(
                        "div",
                        { className: "symphona-toolbarLeft" },
                        react.createElement(
                            "div",
                            { className: "symphona-tabs", role: "tablist", "aria-label": "Comparison views" },
                            [
                                ["shared", "Shared"],
                                ["left", "Only in First"],
                                ["right", "Only in Second"],
                            ].map(([value, label]) => react.createElement(
                                "button",
                                {
                                    "aria-selected": deferredView === value,
                                    className: `symphona-tab${deferredView === value ? " is-active" : ""}`,
                                    key: value,
                                    onClick: () => handleViewChange(value),
                                    role: "tab",
                                    type: "button",
                                },
                                `${label} ${tabCounts[value]}`
                            ))
                        )
                    ),
                    react.createElement(
                        "div",
                        { className: "symphona-toolbarRight" },
                        react.createElement(
                            "a",
                            {
                                className: "symphona-githubLink",
                                href: "https://github.com/pandadoor",
                                rel: "noopener noreferrer",
                                target: "_blank",
                                title: "View on GitHub",
                            },
                            react.createElement(
                                "svg",
                                {
                                    "aria-hidden": "true",
                                    fill: "currentColor",
                                    height: "18",
                                    viewBox: "0 0 24 24",
                                    width: "18",
                                    xmlns: "http://www.w3.org/2000/svg",
                                },
                                react.createElement("path", {
                                    d: "M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z",
                                })
                            )
                        )
                    )
                ),
                state.status === "loading"
                    ? react.createElement(LoadingPanel, {
                        leftMeta: state.leftMeta,
                        progress: state.progress,
                        rightMeta: state.rightMeta,
                    })
                    : null,
                state.status === "error"
                    ? react.createElement(ErrorPanel, {
                        leftUri: routeInfo.leftUri,
                        message: state.error,
                        rightUri: routeInfo.rightUri,
                    })
                    : null,
                state.status === "ready"
                    ? react.createElement(
                        react.Fragment,
                        null,
                        react.createElement(
                            "section",
                            { className: "symphona-summary" },
                            react.createElement("p", { className: "symphona-summaryEyebrow" }, viewModel.summaryEyebrow),
                            react.createElement("h2", { className: "symphona-summaryTitle" }, viewModel.summaryTitle),
                            react.createElement("p", { className: "symphona-summaryBody" }, viewModel.summaryText),
                            react.createElement(
                                "div",
                                { className: "symphona-inlineChips" },
                                react.createElement("span", { className: "symphona-chip" }, pluralize(resultTracks.length, "result"))
                            )
                        ),
                        resultTracks.length
                            ? react.createElement(
                                "section",
                                { className: "symphona-card symphona-resultsCard" },
                                react.createElement(
                                    "div",
                                    { className: "symphona-resultsHeader" },
                                    react.createElement("div", { className: "symphona-trackIndex" }, "#"),
                                    react.createElement("div", null, "Track"),
                                    react.createElement("div", null, "Album"),
                                    react.createElement("div", { className: "symphona-trackDuration" }, "Time"),
                                    react.createElement("div", { className: "symphona-trackIndex" }, "#")
                                ),
                                resultTracks.map((track) => react.createElement(TrackRow, {
                                    key: `${track.uri}:${track.leftIndex ?? "x"}:${track.rightIndex ?? "x"}`,
                                    track,
                                }))
                            )
                            : react.createElement(EmptyPanel, {
                                leftUri: routeInfo.leftUri,
                                rightUri: routeInfo.rightUri,
                                text: viewModel.emptyText,
                                title: viewModel.emptyTitle,
                            })
                    )
                    : null
            )
        );
    }

    function renderIntoMount(element) {
        if (!mountNode) return;

        if (!reactRoot && typeof reactDOM.createRoot === "function") {
            reactRoot = reactDOM.createRoot(mountNode);
        }

        if (reactRoot?.render) {
            reactRoot.render(element);
            return;
        }

        reactDOM.render(element, mountNode);
    }

    function mountRoute(location) {
        const routeInfo = parseSymphonaRoute(location);
        if (!routeInfo.isSymphonaRoute) {
            unmountRoute();
            return;
        }

        const parent = getMainMountParent();
        if (!parent) {
            ensureRouteObserver();
            return;
        }

        if (mountParent && mountParent !== parent) {
            unmountRoute();
        }

        if (mountNode && !mountNode.isConnected) {
            mountNode = null;
            reactRoot = null;
        }

        mountParent = parent;

        if (!mountNode) {
            mountNode = document.createElement("div");
            mountNode.id = ROOT_ID;
            mountNode.dataset.symphonaRoot = "true";
        }

        if (!mountNode.isConnected) {
            parent.prepend(mountNode);
        }

        toggleNativePageVisibility(parent, true);
        ensureRouteObserver();
        renderIntoMount(react.createElement(SymphonaPage, { routeInfo }));
    }

    function scheduleRouteRender(location) {
        const token = ++renderToken;
        requestAnimationFrame(() => {
            if (token !== renderToken) return;
            mountRoute(location);
        });
    }

    function openComparisonRoute(leftUri, rightUri, view = "shared") {
        Platform.History.push(buildSymphonaRoute(leftUri, rightUri, view));
        requestAnimationFrame(scrollMainViewToTop);
    }

    function getSinglePlaylistUri(uris) {
        if (!Array.isArray(uris) || uris.length !== 1) return "";
        return isPlaylistUri(uris[0]) ? uris[0] : "";
    }

    const setContextMenu = new ContextMenu.Item(
        "Symphona: Set selected playlist",
        async (uris) => {
            const uri = getSinglePlaylistUri(uris);
            if (!uri) return;

            try {
                const meta = await fetchPlaylistMetadata(uri);
                syncSelectionState(uri, meta.name);
                Spicetify.showNotification?.(`Symphona selected ${meta.name}.`);
            } catch (error) {
                syncSelectionState(uri, selectedPlaylistName);
                Spicetify.showNotification?.(`Symphona: ${resolveErrorMessage(error)}`);
            }
        },
        (uris) => Boolean(getSinglePlaylistUri(uris))
    );

    compareContextMenu = new ContextMenu.Item(
        "Symphona: Compare with selected playlist",
        async (uris) => {
            const targetUri = getSinglePlaylistUri(uris);
            if (!targetUri || !selectedPlaylistUri || targetUri === selectedPlaylistUri) return;
            openComparisonRoute(selectedPlaylistUri, targetUri);
        },
        (uris) => {
            const targetUri = getSinglePlaylistUri(uris);
            return Boolean(targetUri && selectedPlaylistUri && targetUri !== selectedPlaylistUri);
        }
    );

    const clearSelectionContextMenu = new ContextMenu.Item(
        "Symphona: Clear selected playlist",
        () => {
            syncSelectionState("", "");
            Spicetify.showNotification?.("Symphona cleared the selected playlist.");
        },
        (uris) => Boolean(selectedPlaylistUri && getSinglePlaylistUri(uris))
    );

    injectStyles();
    setContextMenu.register();
    compareContextMenu.register();
    clearSelectionContextMenu.register();
    syncSelectionState(selectedPlaylistUri, selectedPlaylistName);

    if (selectedPlaylistUri && !selectedPlaylistName) {
        fetchPlaylistMetadata(selectedPlaylistUri)
            .then((meta) => syncSelectionState(selectedPlaylistUri, meta.name))
            .catch(() => syncSelectionState(selectedPlaylistUri, ""));
    }

    Platform.History.listen((location) => {
        scheduleRouteRender(location);
    });
    scheduleRouteRender(Platform.History.location);

    console.log("Symphona: routed comparison page ready.");
})();
