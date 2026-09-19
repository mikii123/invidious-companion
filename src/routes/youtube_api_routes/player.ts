import { Hono } from "hono";
import { youtubePlayerParsing } from "../../lib/helpers/youtubePlayerHandling.ts";
import { HTTPException } from "hono/http-exception";
import { validateVideoId } from "../../lib/helpers/validateVideoId.ts";
import { getPooledSession } from "../../lib/helpers/sessionPool.ts";
import type { CookieJar } from "../../lib/helpers/cookieJar.ts";
import { TOKEN_MINTER_NOT_READY_MESSAGE } from "../../constants.ts";

const player = new Hono();

player.post("/player", async (c) => {
    const jsonReq = await c.req.json();
    const config = c.get("config");
    const metrics = c.get("metrics");

    const cookies = typeof jsonReq.cookies === "string" && jsonReq.cookies
        ? jsonReq.cookies
        : undefined;
    // Cookies identify an account; this picks which of its pages (channels) is asking.
    const pageId = typeof jsonReq.pageId === "string" ? jsonReq.pageId : "";

    let innertubeClient = c.get("innertubeClient");
    let tokenMinter = c.get("tokenMinter");
    let jar: CookieJar | undefined;

    if (
        !cookies && config.jobs.youtube_session.po_token_enabled && !tokenMinter
    ) {
        return c.json({
            playabilityStatus: {
                status: "ERROR",
                reason: TOKEN_MINTER_NOT_READY_MESSAGE,
                errorScreen: {
                    playerErrorMessageRenderer: {
                        reason: {
                            simpleText: TOKEN_MINTER_NOT_READY_MESSAGE,
                        },
                        subreason: {
                            simpleText: TOKEN_MINTER_NOT_READY_MESSAGE,
                        },
                    },
                },
            },
        });
    }

    if (jsonReq.videoId) {
        if (!validateVideoId(jsonReq.videoId)) {
            throw new HTTPException(400, {
                res: new Response("Invalid video ID format."),
            });
        }

        if (cookies) {
            const session = await getPooledSession(
                cookies,
                config,
                metrics,
                pageId,
            );
            innertubeClient = session.innertubeClient;
            tokenMinter = session.tokenMinter;
            jar = session.jar;
        }

        const player = await youtubePlayerParsing({
            innertubeClient,
            videoId: jsonReq.videoId,
            config,
            tokenMinter: tokenMinter!,
            metrics,
            // responses are bound to the session that made them
            overrideCache: Boolean(cookies),
        });

        // Handing rotated cookies back is what lets the caller keep its stored copy usable: YouTube
        // replaces the session token roughly hourly and stops accepting the previous one.
        return c.json(
            jar?.rotated ? { ...player, cookies: jar.header } : player,
        );
    }
});

export default player;
