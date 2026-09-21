import { Hono } from "hono";
import { FormatUtils } from "youtubei.js";
import {
    youtubePlayerParsing,
    youtubeVideoInfo,
} from "../../lib/helpers/youtubePlayerHandling.ts";
import { verifyRequest } from "../../lib/helpers/verifyRequest.ts";
import { HTTPException } from "hono/http-exception";
import { encryptQuery } from "../../lib/helpers/encryptQuery.ts";
import { validateVideoId } from "../../lib/helpers/validateVideoId.ts";
import { getPooledSession } from "../../lib/helpers/sessionPool.ts";
import type { CookieJar } from "../../lib/helpers/cookieJar.ts";
import { TOKEN_MINTER_NOT_READY_MESSAGE } from "../../constants.ts";

const PRIVATE_PARAM_NAMES = ["pot", "ip"];

const dashManifest = new Hono();

dashManifest.get("/:videoId", async (c) => {
    const { videoId } = c.req.param();
    const { check, local } = c.req.query();
    c.header("access-control-allow-origin", "*");

    const config = c.get("config");
    const metrics = c.get("metrics");

    // The manifest is built from a player response of its own, so it meets the same wall the player
    // route does when YouTube refuses signed-out sessions. Credentials arrive in a header rather
    // than the query string: a URL is the one part of a request that gets logged everywhere.
    const cookies = c.req.header("x-yt-cookies");
    const pageId = c.req.header("x-yt-pageid") ?? "";

    let innertubeClient = c.get("innertubeClient");
    let tokenMinter = c.get("tokenMinter");
    let jar: CookieJar | undefined;

    if (cookies) {
        const session = await getPooledSession(cookies, config, metrics, pageId);
        innertubeClient = session.innertubeClient;
        tokenMinter = session.tokenMinter;
        jar = session.jar;
    }

    // Check if tokenMinter is ready (only needed when PO token is enabled)
    if (!cookies && config.jobs.youtube_session.po_token_enabled && !tokenMinter) {
        throw new HTTPException(503, {
            res: new Response(TOKEN_MINTER_NOT_READY_MESSAGE),
        });
    }

    if (!validateVideoId(videoId)) {
        throw new HTTPException(400, {
            res: new Response("Invalid video ID format."),
        });
    }

    if (config.server.verify_requests && check == undefined) {
        throw new HTTPException(400, {
            res: new Response("No check ID."),
        });
    } else if (config.server.verify_requests && check) {
        if (verifyRequest(check, videoId, config) === false) {
            throw new HTTPException(400, {
                res: new Response("ID incorrect."),
            });
        }
    }

    const youtubePlayerResponseJson = await youtubePlayerParsing({
        innertubeClient,
        videoId,
        config,
        tokenMinter: tokenMinter!,
        metrics,
        // A signed-in response must never be served from, or written to, the shared cache.
        overrideCache: Boolean(cookies),
    });

    // Handing the rotated cookies back is what keeps the caller's stored copy usable; the body here
    // is XML, so they ride on a header.
    if (jar?.rotated) c.header("x-yt-cookies", jar.header);
    const videoInfo = youtubeVideoInfo(
        innertubeClient,
        youtubePlayerResponseJson,
    );

    if (videoInfo.playability_status?.status !== "OK") {
        throw ("The video can't be played: " + videoId + " due to reason: " +
            videoInfo.playability_status?.reason);
    }

    c.header("content-type", "application/dash+xml");

    if (videoInfo.streaming_data) {
        // video.js only support MP4 not WEBM
        videoInfo.streaming_data.adaptive_formats = videoInfo
            .streaming_data.adaptive_formats
            .filter((i) => i.mime_type.includes("mp4"));

        const player_response = videoInfo.page[0];
        // TODO: fix include storyboards in DASH manifest file
        //const storyboards = player_response.storyboards;
        const captions = player_response.captions?.caption_tracks;

        const dashFile = await FormatUtils.toDash(
            videoInfo.streaming_data,
            videoInfo.page[0].video_details?.is_post_live_dvr,
            (url: URL) => {
                let dashUrl = url;
                const queryParams = new URLSearchParams(dashUrl.search);
                // Can't create URL type without host part
                queryParams.set("host", dashUrl.host);

                if (local) {
                    if (config.networking.videoplayback.ump) {
                        queryParams.set("ump", "yes");
                    }
                    if (
                        config.server.encrypt_query_params
                    ) {
                        const privateParams = [...queryParams].filter(([key]) =>
                            PRIVATE_PARAM_NAMES.includes(key)
                        );
                        const encryptedParams = encryptQuery(
                            JSON.stringify(privateParams),
                            config,
                        );

                        for (const param of PRIVATE_PARAM_NAMES) {
                            queryParams.delete(param);
                        }

                        queryParams.set("enc", "true");
                        queryParams.set("data", encryptedParams);
                    }
                    dashUrl =
                        (config.server.base_path + dashUrl.pathname + "?" +
                            queryParams.toString()) as unknown as URL;
                    return dashUrl;
                } else {
                    return dashUrl;
                }
            },
            undefined,
            videoInfo.cpn,
            undefined,
            innertubeClient.actions,
            undefined,
            captions,
            undefined,
        );
        return c.body(dashFile);
    }
});

export default dashManifest;
