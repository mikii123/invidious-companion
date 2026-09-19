/**
 * The cookies of one session, kept current.
 *
 * A stored cookie export is a snapshot, and YouTube rotates the session token behind it roughly
 * every hour: it hands out a new `__Secure-1PSIDTS` in `Set-Cookie` and stops accepting the old
 * one. A browser follows along silently. Anything holding a frozen copy simply stops being signed
 * in, so the jar applies what comes back and reports whether it changed.
 */
export class CookieJar {
    #cookies = new Map<string, string>();
    #dirty = false;

    constructor(header: string) {
        for (const part of header.split(/;\s*/)) {
            const separator = part.indexOf("=");
            if (separator > 0) {
                this.#cookies.set(
                    part.slice(0, separator).trim(),
                    part.slice(separator + 1).trim(),
                );
            }
        }
    }

    get header(): string {
        return [...this.#cookies]
            .map(([name, value]) => `${name}=${value}`)
            .join("; ");
    }

    /** Whether anything has been rotated since this jar was created. */
    get rotated(): boolean {
        return this.#dirty;
    }

    /** Applies a response's Set-Cookie headers, the way a browser would. */
    apply(headers: Headers): void {
        for (const line of headers.getSetCookie()) {
            const [pair, ...attributes] = line.split(";");
            const separator = pair.indexOf("=");
            if (separator < 1) continue;

            const name = pair.slice(0, separator).trim();
            const value = pair.slice(separator + 1).trim();
            const expired = attributes.some((attribute) => {
                const [key, raw] = attribute.split("=");
                const field = key.trim().toLowerCase();
                if (field === "max-age") return Number(raw) <= 0;
                if (field === "expires") {
                    return new Date(raw ?? "").getTime() < Date.now();
                }
                return false;
            });

            if (expired || value === "") {
                if (this.#cookies.delete(name)) this.#dirty = true;
            } else if (this.#cookies.get(name) !== value) {
                this.#cookies.set(name, value);
                this.#dirty = true;
            }
        }
    }
}
