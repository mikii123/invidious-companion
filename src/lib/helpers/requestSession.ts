import type { Context } from "hono";
import type { Innertube } from "youtubei.js";
import type { TokenMinter } from "../jobs/potoken.ts";
import type { CookieJar } from "./cookieJar.ts";
import { getPooledSession } from "./sessionPool.ts";

export type RequestSession = {
    innertubeClient: Innertube;
    tokenMinter: TokenMinter | undefined;
    /** Present for a signed-in session: the cookies as YouTube last rotated them. */
    jar?: CookieJar;
    signedIn: boolean;
};

/**
 * The session a request is served with: the shared anonymous one, or — when the caller sends
 * cookies on `x-yt-cookies` (and the page to act as on `x-yt-pageid`) — one signed in as their
 * owner. Credentials ride on headers rather than the query string: a URL is the one part of a
 * request that gets logged everywhere.
 */
export const requestSession = async (c: Context): Promise<RequestSession> => {
    const cookies = c.req.header("x-yt-cookies");
    if (!cookies) {
        return {
            innertubeClient: c.get("innertubeClient"),
            tokenMinter: c.get("tokenMinter"),
            signedIn: false,
        };
    }
    const session = await getPooledSession(
        cookies,
        c.get("config"),
        c.get("metrics"),
        c.req.header("x-yt-pageid") ?? "",
    );
    return {
        innertubeClient: session.innertubeClient,
        tokenMinter: session.tokenMinter,
        jar: session.jar,
        signedIn: true,
    };
};

/**
 * Hands rotated cookies back on a header, since these responses are not JSON. Keeping the caller's
 * stored copy current is what keeps it usable: YouTube replaces the session token roughly hourly.
 */
export const returnRotatedCookies = (c: Context, jar?: CookieJar): void => {
    if (jar?.rotated) c.header("x-yt-cookies", jar.header);
};
