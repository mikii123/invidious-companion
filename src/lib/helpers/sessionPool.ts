import { Innertube } from "youtubei.js";
import { poTokenGenerate, type TokenMinter } from "../jobs/potoken.ts";
import type { Config } from "./config.ts";
import { Metrics } from "./metrics.ts";
import { CookieJar } from "./cookieJar.ts";

export type PooledSession = {
    innertubeClient: Innertube;
    tokenMinter: TokenMinter;
    /** Current cookies of this session: YouTube rotates them, and the caller stores them. */
    jar: CookieJar;
};

type PoolEntry = {
    createdAt: number;
    session: Promise<PooledSession>;
};

const MAX_SESSIONS = 8;
const SESSION_TTL = 6 * 60 * 60 * 1000;

const sessions = new Map<string, PoolEntry>();

const poolKey = async (cookies: string, pageId: string): Promise<string> => {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`${cookies}\n${pageId}`),
    );
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
};

const evictExpired = () => {
    const now = Date.now();
    for (const [key, entry] of sessions) {
        if (now - entry.createdAt >= SESSION_TTL) {
            sessions.delete(key);
        }
    }
    while (sessions.size > MAX_SESSIONS) {
        const oldest = sessions.keys().next().value;
        if (oldest === undefined) break;
        sessions.delete(oldest);
    }
};

/**
 * A session bound to the given cookies, and optionally acting as one of that account's other
 * pages. The PO token is minted by the same session that issues the requests, so each set of
 * cookies needs its own — and so does each page, since the page is part of who is asking.
 *
 * Cookies identify an ACCOUNT, not a channel: an account's brand channels share them, and without
 * a page id every request is attributed to the account's own channel.
 */
export const getPooledSession = async (
    cookies: string,
    config: Config,
    metrics: Metrics | undefined,
    pageId = "",
): Promise<PooledSession> => {
    const key = await poolKey(cookies, pageId);
    const cached = sessions.get(key);
    if (cached && Date.now() - cached.createdAt < SESSION_TTL) {
        return cached.session;
    }

    const jar = new CookieJar(cookies);
    const session = poTokenGenerate(config, metrics, {
        cookies,
        pageId,
        validate: false,
        poolKey: key,
        jar,
    }).then((result) => ({ ...result, jar }));
    session.catch(() => sessions.delete(key));

    sessions.set(key, { createdAt: Date.now(), session });
    evictExpired();
    return session;
};
