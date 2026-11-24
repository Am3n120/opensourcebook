import { Container } from "@cloudflare/containers";

export class YtdlpContainer extends Container {
	defaultPort = 8080;
	sleepAfter = "10m";

	constructor(ctx, env) {
		super(ctx, env);
		// The container checks the same token itself and does not start without it.
		this.envVars = { YTDLP_SIDECAR_TOKEN: (env.YTDLP_SIDECAR_TOKEN || "").trim() };
	}
}

const encoder = new TextEncoder();

/** Whether two strings are equal, in a time that does not depend on where they differ. */
async function sameSecret(given, expected) {
	const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(given)), crypto.subtle.digest("SHA-256", encoder.encode(expected))]);
	return crypto.subtle.timingSafeEqual(a, b);
}

// The container is only reachable through this Worker. With no token set it opens to no one.
export default {
	async fetch(request, env) {
		const token = (env.YTDLP_SIDECAR_TOKEN || "").trim();
		if (!token) {
			return Response.json({ ok: false, error: "YTDLP_SIDECAR_TOKEN is not set" }, { status: 503 });
		}
		if (!(await sameSecret(request.headers.get("authorization") || "", `Bearer ${token}`))) {
			return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
		}
		const container = env.YTDLP_CONTAINER.getByName("main");
		return container.fetch(request);
	},
};
