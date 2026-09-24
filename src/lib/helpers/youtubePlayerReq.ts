import { ApiResponse, Innertube } from "youtubei.js";
import NavigationEndpoint from "youtubei.js/NavigationEndpoint";
import type { TokenMinter } from "../jobs/potoken.ts";

import type { Config } from "./config.ts";

function callWatchEndpoint(
    videoId: string,
    innertubeClient: Innertube,
    innertubeClientType: string,
    contentPoToken: string,
) {
    const watch_endpoint = new NavigationEndpoint({
        watchEndpoint: {
            videoId: videoId,
            // Allow companion to gather sensitive content videos like
            // `VuSU7PcEKpU`
            racyCheckOk: true,
            contentCheckOk: true,
        },
    });

    return watch_endpoint.call(
        innertubeClient.actions,
        {
            playbackContext: {
                contentPlaybackContext: {
                    vis: 0,
                    splay: false,
                    lactMilliseconds: "-1",
                    signatureTimestamp: innertubeClient.session.player
                        ?.signature_timestamp,
                },
            },
            serviceIntegrityDimensions: {
                poToken: contentPoToken,
            },
            client: innertubeClientType,
        },
    );
}

export const youtubePlayerReq = async (
    innertubeClient: Innertube,
    videoId: string,
    config: Config,
    tokenMinter: TokenMinter,
): Promise<ApiResponse> => {
    const innertubeClientOauthEnabled = config.youtube_session.oauth_enabled;

    let innertubeClientUsed = "WEB";
    if (innertubeClientOauthEnabled) {
        innertubeClientUsed = "TV";
    }

    const contentPoToken = await tokenMinter(videoId);

    const youtubePlayerResponse = await callWatchEndpoint(
        videoId,
        innertubeClient,
        innertubeClientUsed,
        contentPoToken,
    );

    // Fall back to other clients only when this response carries nothing playable at all.
    //
    // A ciphered format is playable: youtubePlayerParsing deciphers it, and the fallback loop below
    // accepts `signatureCipher` from the clients it tries. Triggering on a missing `url` alone made
    // that inconsistent — a signed-in WEB response, which is ciphered as a matter of course, was
    // thrown away for an MWEB one whose URLs googlevideo then answered 403.
    const firstAdaptiveFormat = youtubePlayerResponse.data.streamingData
        ?.adaptiveFormats?.[0];

    if (
        !innertubeClientOauthEnabled &&
        youtubePlayerResponse.data.streamingData &&
        firstAdaptiveFormat?.url === undefined &&
        firstAdaptiveFormat?.signatureCipher === undefined
    ) {
        console.log(
            "[WARNING] No URLs found for adaptive formats. Falling back to other YT clients.",
        );
        // A signed-in session goes to the web client that still hands out URLs to cookies first.
        // The TV and Android fallbacks are signed-out requests, and a URL they issue to a signed-in
        // session's visitor serves one byte range and then 403s (measured).
        const innertubeClientsTypeFallback = innertubeClient.session.logged_in
            ? ["WEB_CREATOR", "MWEB", "TV_SIMPLY", "ANDROID_VR"]
            : ["TV_SIMPLY", "ANDROID_VR", "MWEB"];

        for await (const innertubeClientType of innertubeClientsTypeFallback) {
            console.log(
                `[WARNING] Trying fallback YT client ${innertubeClientType}`,
            );
            const youtubePlayerResponseFallback = await callWatchEndpoint(
                videoId,
                innertubeClient,
                innertubeClientType,
                contentPoToken,
            );
            if (
                youtubePlayerResponseFallback.data.streamingData && (
                    youtubePlayerResponseFallback.data.streamingData
                        .adaptiveFormats[0].url ||
                    youtubePlayerResponseFallback.data.streamingData
                        .adaptiveFormats[0].signatureCipher
                )
            ) {
                const fallbackFormats =
                    youtubePlayerResponseFallback.data.streamingData.formats;
                if (fallbackFormats?.length) {
                    youtubePlayerResponse.data.streamingData.formats =
                        fallbackFormats;
                }
                youtubePlayerResponse.data.streamingData.adaptiveFormats =
                    youtubePlayerResponseFallback.data.streamingData
                        .adaptiveFormats;
                break;
            }
        }
    }

    return youtubePlayerResponse;
};
