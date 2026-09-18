import { Hono } from "hono";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { generateRandomString } from "youtubei.js/Utils";
import { validateVideoId } from "../../lib/helpers/validateVideoId.ts";
import { getPooledSession } from "../../lib/helpers/sessionPool.ts";

let getFetchClientLocation = "getFetchClient";
if (Deno.env.get("GET_FETCH_CLIENT_LOCATION")) {
    if (Deno.env.has("DENO_COMPILED")) {
        getFetchClientLocation = Deno.mainModule.replace("src/main.ts", "") +
            Deno.env.get("GET_FETCH_CLIENT_LOCATION");
    } else {
        getFetchClientLocation = Deno.env.get(
            "GET_FETCH_CLIENT_LOCATION",
        ) as string;
    }
}
const { getFetchClient } = await import(getFetchClientLocation);

const STATS_HOSTS = ["s.youtube.com", "www.youtube.com"];

const StatsRequestSchema = z.object({
    videoId: z.string(),
    cookies: z.string().optional(),
    cpn: z.string().min(1).max(64).optional(),
    event: z.enum(["start", "progress", "end"]),
    playbackUrl: z.string().optional(),
    watchtimeUrl: z.string().optional(),
    position: z.number().nonnegative().default(0),
    startPosition: z.number().nonnegative().default(0),
});

// Tracking URLs come from a player response, so they are only accepted when
// they point at YouTube's stats endpoints.
const parseStatsUrl = (value: string): URL => {
    let url: URL;
    try {
        url = new URL(value.replace("https://s.", "https://www."));
    } catch {
        throw new HTTPException(400, {
            res: new Response("Invalid tracking URL."),
        });
    }
    if (
        url.protocol !== "https:" ||
        !STATS_HOSTS.includes(url.hostname) ||
        !url.pathname.startsWith("/api/stats/")
    ) {
        throw new HTTPException(400, {
            res: new Response("Invalid tracking URL."),
        });
    }
    return url;
};

const stats = new Hono();

stats.post("/stats", async (c) => {
    const parsed = StatsRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
        throw new HTTPException(400, {
            res: new Response("Invalid request body."),
        });
    }
    const body = parsed.data;

    if (!validateVideoId(body.videoId)) {
        throw new HTTPException(400, {
            res: new Response("Invalid video ID format."),
        });
    }

    const config = c.get("config");
    const metrics = c.get("metrics");

    let innertubeClient = c.get("innertubeClient");
    if (body.cookies) {
        innertubeClient =
            (await getPooledSession(body.cookies, config, metrics))
                .innertubeClient;
    }

    const client = innertubeClient.session.context.client;
    const cpn = body.cpn ?? generateRandomString(16);

    const target = body.event === "start"
        ? body.playbackUrl
        : body.watchtimeUrl;
    if (!target) {
        throw new HTTPException(400, {
            res: new Response("Missing tracking URL for this event."),
        });
    }

    const url = parseStatsUrl(target);
    url.searchParams.set("ver", "2");
    url.searchParams.set("c", client.clientName.toLowerCase());
    url.searchParams.set("cbrver", client.clientVersion);
    url.searchParams.set("cver", client.clientVersion);
    url.searchParams.set("cpn", cpn);

    if (body.event === "start") {
        url.searchParams.set("fmt", "251");
        url.searchParams.set("rt", "0");
        url.searchParams.set("rtn", "0");
    } else {
        const start = Math.min(body.startPosition, body.position);
        url.searchParams.set("st", start.toFixed(3));
        url.searchParams.set("et", body.position.toFixed(3));
        url.searchParams.set("cmt", body.position.toFixed(3));
        url.searchParams.set(
            "state",
            body.event === "end" ? "paused" : "playing",
        );
        if (body.event === "end") {
            url.searchParams.set("final", "1");
        }
    }

    const fetchClient = await getFetchClient(config);
    const headers: HeadersInit = body.cookies
        ? { cookie: body.cookies, "user-agent": client.userAgent ?? "" }
        : {};

    const response = await fetchClient(url.toString(), { headers });
    await response.body?.cancel();

    return c.json({ cpn, status: response.status });
});

export default stats;
