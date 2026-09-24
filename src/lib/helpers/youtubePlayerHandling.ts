import { ApiResponse, Innertube, YT } from "youtubei.js";
import { generateRandomString } from "youtubei.js/Utils";
import { compress, decompress } from "brotli";
import type { TokenMinter } from "../jobs/potoken.ts";
import { Metrics } from "../helpers/metrics.ts";
let youtubePlayerReqLocation = "youtubePlayerReq";
if (Deno.env.get("YT_PLAYER_REQ_LOCATION")) {
    if (Deno.env.has("DENO_COMPILED")) {
        youtubePlayerReqLocation = Deno.mainModule.replace("src/main.ts", "") +
            Deno.env.get("YT_PLAYER_REQ_LOCATION");
    } else {
        youtubePlayerReqLocation = Deno.env.get(
            "YT_PLAYER_REQ_LOCATION",
        ) as string;
    }
}
const { youtubePlayerReq } = await import(youtubePlayerReqLocation);

import type { Config } from "./config.ts";
import { getKv } from "./kv.ts";

// Which token googlevideo checks a stream URL against depends on the client that issued it.
// URLs from the web clients are checked against a token bound to the video: with the session
// token (bound to the visitor) they serve the first minute and answer 403 after it — measured on
// MWEB and WEB_CREATOR, signed in, with every other binding. URLs from the TV and Android clients
// are the other way round and keep the session token that decipher() put on them.
const WEB_URL_CLIENTS = new Set([
    "WEB",
    "MWEB",
    "WEB_CREATOR",
    "WEB_EMBEDDED_PLAYER",
]);

const bindPoToken = (url: string, contentPoToken?: string): string => {
    if (!contentPoToken) return url;
    const parsed = new URL(url);
    if (!WEB_URL_CLIENTS.has(parsed.searchParams.get("c") ?? "")) return url;
    parsed.searchParams.set("pot", contentPoToken);
    return parsed.toString();
};

export const youtubePlayerParsing = async ({
    innertubeClient,
    videoId,
    config,
    tokenMinter,
    metrics,
    overrideCache = false,
}: {
    innertubeClient: Innertube;
    videoId: string;
    config: Config;
    tokenMinter: TokenMinter;
    metrics: Metrics | undefined;
    overrideCache?: boolean;
}): Promise<object> => {
    const cacheEnabled = overrideCache ? false : config.cache.enabled;
    const kv = await getKv(config);

    const videoCached = (await kv.get(["video_cache", videoId]))
        .value as Uint8Array;

    if (videoCached != null && cacheEnabled) {
        return JSON.parse(new TextDecoder().decode(decompress(videoCached)));
    } else {
        const youtubePlayerResponse = await youtubePlayerReq(
            innertubeClient,
            videoId,
            config,
            tokenMinter,
        );
        const videoData = youtubePlayerResponse.data;

        if (videoData.playabilityStatus.status === "ERROR") {
            return videoData;
        }

        const video = new YT.VideoInfo(
            [youtubePlayerResponse],
            innertubeClient.actions,
            generateRandomString(16),
        );

        const streamingData = video.streaming_data;

        // Modify the original YouTube response to include deciphered URLs
        if (streamingData && videoData && videoData.streamingData) {
            const ecatcherServiceTracking = videoData.responseContext
                ?.serviceTrackingParams.find((o: { service: string }) =>
                    o.service === "ECATCHER"
                );
            const clientNameUsed = ecatcherServiceTracking?.params?.find((
                o: { key: string },
            ) => o.key === "client.name");
            // no need to decipher on IOS nor ANDROID
            if (
                !clientNameUsed?.value.includes("IOS") &&
                !clientNameUsed?.value.includes("ANDROID")
            ) {
                const contentPoToken = tokenMinter
                    ? await tokenMinter(videoId)
                    : undefined;
                for (
                    let index = 0;
                    index < streamingData.formats.length;
                    index++
                ) {
                    const format = videoData.streamingData.formats[index];

                    format.url = bindPoToken(
                        await streamingData.formats[index].decipher(
                            innertubeClient.session.player,
                        ),
                        contentPoToken,
                    );
                    if (format.signatureCipher !== undefined) {
                        delete format.signatureCipher;
                    }
                    if (format.url.includes("alr=yes")) {
                        format.url = format.url.replace("alr=yes", "alr=no");
                    } else {
                        format.url += "&alr=no";
                    }
                }
                for (
                    let index = 0;
                    index < streamingData.adaptive_formats.length;
                    index++
                ) {
                    const format =
                        videoData.streamingData.adaptiveFormats[index];

                    format.url = bindPoToken(
                        await streamingData.adaptive_formats[index].decipher(
                            innertubeClient.session.player,
                        ),
                        contentPoToken,
                    );
                    if (format.signatureCipher !== undefined) {
                        delete format.signatureCipher;
                    }
                    if (format.url.includes("alr=yes")) {
                        format.url = format.url.replace("alr=yes", "alr=no");
                    } else {
                        format.url += "&alr=no";
                    }
                }
            }
        }

        const videoOnlyNecessaryInfo = ((
            {
                captions,
                playabilityStatus,
                storyboards,
                streamingData,
                videoDetails,
                microformat,
                playbackTracking,
                responseContext,
            },
        ) => ({
            captions,
            playabilityStatus,
            storyboards,
            streamingData,
            videoDetails,
            microformat,
            playbackTracking,
            // carries `logged_in`, which is the only way to tell an authenticated response from an
            // anonymous one — a player response has playbackTracking either way
            responseContext,
        }))(videoData);

        if (videoData.playabilityStatus?.status == "OK") {
            metrics?.innertubeSuccessfulRequest.inc();
            if (cacheEnabled) {
                (async () => {
                    await kv.set(
                        ["video_cache", videoId],
                        compress(
                            new TextEncoder().encode(
                                JSON.stringify(videoOnlyNecessaryInfo),
                            ),
                        ),
                        {
                            expireIn: 1000 * 60 * 60,
                        },
                    );
                })();
            }
        } else {
            metrics?.checkInnertubeResponse(videoData);
        }

        return videoOnlyNecessaryInfo;
    }
};

export const youtubeVideoInfo = (
    innertubeClient: Innertube,
    youtubePlayerResponseJson: object,
): YT.VideoInfo => {
    const playerResponse = {
        success: true,
        status_code: 200,
        data: youtubePlayerResponseJson,
    } as ApiResponse;
    return new YT.VideoInfo(
        [playerResponse],
        innertubeClient.actions,
        "",
    );
};
