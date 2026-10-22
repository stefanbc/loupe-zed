import { request as httpRequest } from "node:http";
import { type Agent, request as httpsRequest } from "node:https";

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;
// Room for large abbreviated packuments while bounding memory when a
// registry ignores the Accept header and sends a full one.
const MAX_BYTES = 32 * 1024 * 1024;

export interface GetJsonOptions {
	headers?: Record<string, string>;
	/**
	 * Resolves the Authorization header per URL, so credentials follow redirects
	 * only where configured. It is not consulted after a redirect from https:// to http://.
	 */
	authFor?: (url: string) => string | undefined;
	/** Agent for https:// requests, e.g. carrying custom CAs. */
	agent?: Agent;
	/** Deadline per request including the whole body, defaults to 15 s. */
	timeoutMs?: number;
	/** Larger responses are rejected, defaults to 32 MiB. */
	maxBytes?: number;
}

export interface JsonResponse {
	status: number;
	body: unknown;
}

/**
 * GETs a URL and parses the body as JSON. Unlike the global fetch, this
 * accepts a custom HTTPS agent, which is needed for registries signed by
 * a company CA. Follows redirects, including http:// → https://. After a
 * redirect from https:// to http://, no Authorization header is sent, so
 * tokens never leave an encrypted connection for a plaintext one.
 */
export async function getJson(
	url: string,
	options: GetJsonOptions = {},
): Promise<JsonResponse> {
	let current = url;
	let downgraded = false;

	for (let i = 0; i <= MAX_REDIRECTS; i++) {
		const res = await get(current, downgraded ? withoutAuth(options) : options);

		if (res.status >= 300 && res.status < 400 && res.location) {
			const next = new URL(res.location, current);
			if (new URL(current).protocol === "https:" && next.protocol === "http:") {
				downgraded = true;
			}
			current = next.toString();
			continue;
		}

		if (res.status < 200 || res.status >= 300) {
			return { status: res.status, body: undefined };
		}
		return { status: res.status, body: JSON.parse(res.text) };
	}

	throw new Error(`too many redirects (${MAX_REDIRECTS})`);
}

function withoutAuth(options: GetJsonOptions): GetJsonOptions {
	return { ...options, authFor: undefined };
}

interface RawResponse {
	status: number;
	location?: string;
	text: string;
}

function get(url: string, options: GetJsonOptions): Promise<RawResponse> {
	const target = new URL(url);
	const headers = { ...options.headers };
	const auth = options.authFor?.(url);
	if (auth) headers.Authorization = auth;

	const isHttps = target.protocol === "https:";
	const send = isHttps ? httpsRequest : httpRequest;
	if (!isHttps && target.protocol !== "http:") {
		return Promise.reject(new Error(`unsupported protocol ${target.protocol}`));
	}

	return new Promise((resolve, reject) => {
		const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
		const maxBytes = options.maxBytes ?? MAX_BYTES;
		// Name the host that failed, which differs from the registry after a redirect.
		const fail = (message: string) => {
			reject(new Error(`${target.host}: ${message}`));
			req.destroy();
		};
		const tooLarge = `response larger than ${maxBytes} bytes`;

		const req = send(
			target,
			{ headers, agent: isHttps ? options.agent : undefined },
			(res) => {
				if (Number(res.headers["content-length"]) > maxBytes) {
					fail(tooLarge);
					return;
				}
				const chunks: Buffer[] = [];
				let size = 0;
				res.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > maxBytes) fail(tooLarge);
					else chunks.push(chunk);
				});
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						location: res.headers.location,
						text: Buffer.concat(chunks).toString("utf8"),
					}),
				);
				res.on("error", (e) => fail(e.message));
			},
		);
		// req.setTimeout() only fires while the socket is idle, so a server
		// trickling bytes could hold the request open indefinitely.
		const timer = setTimeout(
			() => fail(`timeout after ${timeoutMs} ms`),
			timeoutMs,
		);
		req.on("close", () => clearTimeout(timer));
		req.on("error", (e) => fail(e.message));
		req.end();
	});
}
