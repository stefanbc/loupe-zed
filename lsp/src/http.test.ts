import assert from "node:assert/strict";
import { Agent } from "node:https";
import { after, before, describe, it } from "node:test";
import { getJson } from "./http";
import {
	cleanupTempDirs,
	createTestCa,
	hasOpenssl,
	startServer,
	type TestServer,
} from "./test-utils";

describe("getJson", () => {
	let server: TestServer;
	let other: TestServer;

	before(async () => {
		other = await startServer((_req, res) => {
			res.writeHead(200);
			res.end('{"from":"other"}');
		});
		server = await startServer((req, res) => {
			const url = req.url ?? "";
			if (url === "/data") {
				res.writeHead(200);
				res.end('{"ok":true}');
			} else if (url === "/moved") {
				res.writeHead(302, { location: "/data" });
				res.end();
			} else if (url === "/elsewhere") {
				res.writeHead(301, { location: `${other.url}/x` });
				res.end();
			} else if (url.startsWith("/loop")) {
				res.writeHead(302, { location: `/loop${url.length}` });
				res.end();
			} else if (url === "/hang") {
				// Never respond.
			} else if (url === "/trickle") {
				// Sends a byte every 20 ms, so the socket never goes idle.
				res.writeHead(200);
				const timer = setInterval(() => res.write(" "), 20);
				res.on("close", () => clearInterval(timer));
			} else if (url === "/big") {
				res.writeHead(200, { "content-length": "1000" });
				res.end(`"${"x".repeat(998)}"`);
			} else if (url === "/big-chunked") {
				res.writeHead(200);
				res.write(`"${"x".repeat(600)}`);
				res.end(`${"x".repeat(398)}"`);
			} else if (url === "/broken") {
				res.writeHead(200);
				res.end("not json");
			} else {
				res.writeHead(404);
				res.end();
			}
		});
	});

	after(async () => {
		await server.close();
		await other.close();
	});

	it("parses a JSON body", async () => {
		const res = await getJson(`${server.url}/data`);
		assert.deepEqual(res, { status: 200, body: { ok: true } });
	});

	it("follows relative redirects", async () => {
		const res = await getJson(`${server.url}/moved`);
		assert.deepEqual(res.body, { ok: true });
	});

	it("returns non-2xx statuses without a body", async () => {
		const res = await getJson(`${server.url}/missing`);
		assert.deepEqual(res, { status: 404, body: undefined });
	});

	it("resolves Authorization per hop", async () => {
		const res = await getJson(`${server.url}/elsewhere`, {
			authFor: (url) =>
				url.startsWith(server.url) ? "Bearer origin-only" : undefined,
		});
		assert.deepEqual(res.body, { from: "other" });
		assert.equal(server.requests.at(-1)?.authorization, "Bearer origin-only");
		assert.equal(other.requests.at(-1)?.authorization, undefined);
	});

	it("drops Authorization after a redirect from https to http", {
		skip: !hasOpenssl() && "openssl not available",
	}, async () => {
		const ca = createTestCa();
		const secure = await startServer(
			(_req, res) => {
				res.writeHead(301, { location: `${server.url}/data` });
				res.end();
			},
			{ key: ca.serverKey, cert: ca.serverCert },
		);
		try {
			const res = await getJson(`${secure.url}/x`, {
				authFor: () => "Bearer secret",
				agent: new Agent({ ca: ca.caPem }),
			});
			assert.deepEqual(res.body, { ok: true });
			assert.equal(secure.requests.at(-1)?.authorization, "Bearer secret");
			assert.equal(server.requests.at(-1)?.authorization, undefined);
		} finally {
			await secure.close();
			cleanupTempDirs();
		}
	});

	it("gives up after too many redirects", async () => {
		await assert.rejects(getJson(`${server.url}/loop`), /too many redirects/);
	});

	it("times out", async () => {
		await assert.rejects(
			getJson(`${server.url}/hang`, { timeoutMs: 100 }),
			/timeout after 100 ms/,
		);
	});

	it("times out on responses that trickle in", async () => {
		await assert.rejects(
			getJson(`${server.url}/trickle`, { timeoutMs: 200 }),
			/timeout after 200 ms/,
		);
	});

	it("rejects bodies over maxBytes, with or without content-length", async () => {
		for (const path of ["/big", "/big-chunked"]) {
			await assert.rejects(
				getJson(`${server.url}${path}`, { maxBytes: 500 }),
				/response larger than 500 bytes/,
			);
		}
		const res = await getJson(`${server.url}/big`, { maxBytes: 1000 });
		assert.equal((res.body as string).length, 998);
	});

	it("rejects invalid JSON", async () => {
		await assert.rejects(getJson(`${server.url}/broken`), SyntaxError);
	});

	it("rejects unsupported protocols", async () => {
		await assert.rejects(getJson("ftp://localhost/x"), /unsupported protocol/);
	});
});
