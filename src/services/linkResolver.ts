import { logger } from '../utils/logger';

/**
 * linkResolver
 * ------------
 * Antigravity's own agent will try to "browse" any bare URL a user pastes into
 * the chat by opening it in an embedded webview. Video sites (YouTube, TikTok,
 * Vimeo, Twitch...) are notoriously bad for this: cookie walls, autoplay/DRM
 * checks and heavy async JS mean the embedded webview never reaches a clean
 * "finished loading" state, so Antigravity's UI sits in a "generating" state
 * forever and Remoat's ResponseMonitor (which just watches for the Stop
 * button to disappear) waits out the full 30-minute timeout.
 *
 * Fix: before the prompt is ever injected into Antigravity, detect URLs on
 * known video/heavy-preview domains and resolve them ourselves via a
 * *headless* Playwright browser (bounded by a hard timeout, run in a
 * separate process-level browser instance — never inside Antigravity's own
 * CDP session). We replace the raw URL in the outbound prompt with a short
 * text annotation (title/description) so Antigravity has the information it
 * needs to reason about the link WITHOUT ever trying to open it itself.
 *
 * If resolution fails or times out, we fall back to leaving the URL as-is
 * (best effort — we never block message sending on this).
 */

// Domains known to cause Antigravity's embedded webview to hang indefinitely.
const VIDEO_HEAVY_DOMAINS = [
    'youtube.com',
    'youtu.be',
    'm.youtube.com',
    'vimeo.com',
    'tiktok.com',
    'twitch.tv',
    'dailymotion.com',
    'facebook.com/watch',
    'instagram.com/reel',
    'instagram.com/p',
];

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;

export interface LinkResolverOptions {
    /** Hard cap for the whole headless navigation+extraction per link (default 8000ms). */
    timeoutMs?: number;
    /** Set false to disable link rewriting entirely (passthrough). */
    enabled?: boolean;
}

function isHeavyPreviewUrl(url: string): boolean {
    try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        return VIDEO_HEAVY_DOMAINS.some(d => host === d || host.endsWith(`.${d}`) || url.includes(d));
    } catch {
        return false;
    }
}

interface ResolvedMeta {
    title?: string;
    description?: string;
}

/**
 * Lazily require playwright so environments without it installed
 * (or without browsers downloaded) don't crash Remoat at startup —
 * link resolution degrades gracefully to a no-op passthrough.
 */
let playwrightModule: typeof import('playwright') | null = null;
let playwrightLoaded = false;
function loadPlaywright(): typeof import('playwright') | null {
    if (playwrightLoaded) return playwrightModule;
    playwrightLoaded = true;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        playwrightModule = require('playwright');
    } catch (e) {
        logger.warn('[linkResolver] Playwright not available — video link previews disabled:', (e as Error)?.message);
        playwrightModule = null;
    }
    return playwrightModule;
}

/**
 * Fetch title/description for a single URL using a short-lived headless
 * Chromium instance. Bounded by `timeoutMs` via Promise.race so a hung
 * page NEVER blocks prompt dispatch — worst case we just fall back to the
 * raw URL.
 */
async function resolveMeta(url: string, timeoutMs: number): Promise<ResolvedMeta | null> {
    const pw = loadPlaywright();
    if (!pw) return null;

    let browser: import('playwright').Browser | null = null;
    try {
        const work = (async (): Promise<ResolvedMeta | null> => {
            const launched = await pw.chromium.launch({ headless: true });
            browser = launched;
            const context = await launched.newContext({
                userAgent: 'Mozilla/5.0 (compatible; RemoatLinkPreview/1.0)',
            });
            const page = await context.newPage();
            // domcontentloaded (not 'load'/'networkidle') is deliberate: video
            // pages never settle their network activity, so waiting for full
            // load is exactly the hang we're trying to avoid.
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

            const title = await page.title().catch(() => undefined);
            const description = await page
                .locator('meta[name="description"], meta[property="og:description"]')
                .first()
                .getAttribute('content')
                .catch(() => undefined);

            return { title: title || undefined, description: description || undefined };
        })();

        const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
        return await Promise.race([work, timeout]);
    } catch (e) {
        logger.debug(`[linkResolver] Failed to resolve metadata for ${url}:`, (e as Error)?.message);
        return null;
    } finally {
        // Always tear down, even on timeout race loss (fire-and-forget close
        // so we don't leak headless Chromium processes).
        if (browser) {
            (browser as import('playwright').Browser).close().catch(() => { /* best effort */ });
        }
    }
}

function formatAnnotation(url: string, meta: ResolvedMeta | null): string {
    if (!meta || (!meta.title && !meta.description)) {
        // Resolution failed/timed out — annotate as a plain reference link
        // instead of a bare URL, still steering Antigravity away from
        // trying to open it as a live browsable resource.
        return `[Video link: ${url}] (preview unavailable — treat as a reference URL, do not open in a browser)`;
    }
    const parts = [`[Video: ${meta.title ?? 'Untitled'}]`];
    if (meta.description) parts.push(`— ${meta.description}`);
    parts.push(`(${url})`);
    return parts.join(' ');
}

/**
 * Scan `prompt` for heavy-preview (video) URLs and replace each with a
 * pre-resolved text annotation. Non-video URLs are left untouched — normal
 * web pages don't cause the hang, only video/media platforms with no clean
 * load-complete signal.
 *
 * Never throws; on any internal failure returns the original prompt.
 */
export async function resolveLinksInPrompt(
    prompt: string,
    options: LinkResolverOptions = {},
): Promise<string> {
    const enabled = options.enabled ?? true;
    if (!enabled || !prompt) return prompt;

    const timeoutMs = options.timeoutMs ?? 8000;
    const urls = Array.from(new Set(prompt.match(URL_REGEX) ?? []));
    const heavyUrls = urls.filter(isHeavyPreviewUrl);
    if (heavyUrls.length === 0) return prompt;

    logger.info(`[linkResolver] Detected ${heavyUrls.length} video/heavy-preview link(s), resolving headlessly (timeout=${timeoutMs}ms each)`);

    let result = prompt;
    for (const url of heavyUrls) {
        try {
            const meta = await resolveMeta(url, timeoutMs);
            const annotation = formatAnnotation(url, meta);
            result = result.split(url).join(annotation);
            logger.debug(`[linkResolver] Resolved ${url} -> ${annotation}`);
        } catch (e) {
            logger.debug(`[linkResolver] Unexpected error resolving ${url} (leaving as-is):`, (e as Error)?.message);
        }
    }
    return result;
}

/** Exposed for tests */
export const _internal = { isHeavyPreviewUrl, formatAnnotation, VIDEO_HEAVY_DOMAINS };
