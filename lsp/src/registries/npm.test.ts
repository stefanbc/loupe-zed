import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import {
	cleanupTempDirs,
	createTestCa,
	hasOpenssl,
	packument,
	startServer,
	type TestCa,
	type TestServer,
	withNpmrc,
} from "../test-utils";
import { npmHandler } from "./npm";

describe("npmHandler.fetchLatestVersion", {
	skip: !hasOpenssl() && "openssl not available",
}, () => {
	let ca: TestCa;
	let httpsServer: TestServer;
	let httpServer: TestServer;
	let packumentOnly: TestServer;
	let slow: TestServer;

	before(async () => {
		ca = createTestCa();
		httpsServer = await startServer(packument("1.2.3"), {
			key: ca.serverKey,
			cert: ca.serverCert,
		});
		packumentOnly = await startServer(packument("2.0.0", { distTags: false }));
		// Answers after 200 ms, so tests can act while requests are in flight.
		slow = await startServer((req, res) => {
			setTimeout(() => packument("3.0.0")(req, res), 200);
		});
		// Mirrors a Nexus behind http:// that redirects to its https:// endpoint.
		httpServer = await startServer((req, res) => {
			res.writeHead(301, { location: `${httpsServer.url}${req.url}` });
			res.end();
		});
	});

	beforeEach(() => {
		httpsServer.requests.length = 0;
		httpServer.requests.length = 0;
		packumentOnly.requests.length = 0;
		slow.requests.length = 0;
	});

	after(async () => {
		npmHandler.clearCache?.();
		await httpsServer.close();
		await httpServer.close();
		await packumentOnly.close();
		await slow.close();
		cleanupTempDirs();
	});

	/** Writes the .npmrc and clears the version cache so every test fetches. */
	function npmrc(...lines: string[]): void {
		withNpmrc(`${lines.join("\n")}\n`);
		npmHandler.clearCache?.();
	}

	describe("https registry with a custom CA", () => {
		it("fails verification without cafile", async () => {
			npmrc(`@test:registry=${httpsServer.url}/direct`);
			assert.equal(await npmHandler.fetchLatestVersion("@test/foo"), "?");
		});

		it("trusts the CA from cafile", async () => {
			npmrc(`@test:registry=${httpsServer.url}/direct`, `cafile=${ca.caFile}`);
			assert.equal(await npmHandler.fetchLatestVersion("@test/foo"), "1.2.3");
			assert.equal(
				httpsServer.requests[0].url,
				"/direct/-/package/@test%2ffoo/dist-tags",
			);
		});

		it("trusts an inline ca", async () => {
			const inline = ca.caPem.trim().replaceAll("\n", "\\n");
			npmrc(`@test:registry=${httpsServer.url}/direct`, `ca="${inline}"`);
			assert.equal(await npmHandler.fetchLatestVersion("@test/foo"), "1.2.3");
		});

		it("skips verification with strict-ssl=false", async () => {
			npmrc(`@test:registry=${httpsServer.url}/direct`, "strict-ssl=false");
			assert.equal(await npmHandler.fetchLatestVersion("@test/foo"), "1.2.3");
		});
	});

	describe("http registry redirecting to https (Nexus setup)", () => {
		const registry = () => `registry=${httpServer.url}/repository/npm-all`;

		it("fails on the redirect target without cafile", async () => {
			npmrc(registry());
			assert.equal(await npmHandler.fetchLatestVersion("foo"), "?");
		});

		it("resolves scoped and unscoped packages with cafile", async () => {
			npmrc(registry(), `cafile=${ca.caFile}`);
			assert.equal(await npmHandler.fetchLatestVersion("foo"), "1.2.3");
			assert.equal(await npmHandler.fetchLatestVersion("@test/foo"), "1.2.3");
			assert.deepEqual(httpsServer.requests.map((r) => r.url).sort(), [
				"/repository/npm-all/-/package/@test%2ffoo/dist-tags",
				"/repository/npm-all/-/package/foo/dist-tags",
			]);
		});

		it("sends credentials only to the host they are configured for", async () => {
			const httpsHost = httpsServer.url.replace(/^https:/, "");
			npmrc(
				registry(),
				`cafile=${ca.caFile}`,
				`${httpsHost}/repository/npm-all/:_authToken=right`,
				"//other.example/:_authToken=wrong",
			);
			assert.equal(await npmHandler.fetchLatestVersion("foo"), "1.2.3");
			assert.equal(httpServer.requests[0].authorization, undefined);
			assert.equal(httpsServer.requests[0].authorization, "Bearer right");
		});
	});

	describe("lookup strategy", () => {
		it("falls back to the packument and remembers that for the registry", async () => {
			npmrc(`registry=${packumentOnly.url}/`);
			assert.equal(await npmHandler.fetchLatestVersion("foo"), "2.0.0");
			assert.equal(await npmHandler.fetchLatestVersion("bar"), "2.0.0");
			assert.deepEqual(
				packumentOnly.requests.map((r) => r.url),
				["/-/package/foo/dist-tags", "/foo", "/bar"],
			);
		});

		it("encodes characters that would break the URL", async () => {
			npmrc(`registry=${packumentOnly.url}/`);
			await npmHandler.fetchLatestVersion("@test/a#b?c%d");
			assert.equal(
				packumentOnly.requests[0].url,
				"/-/package/@test%2fa%23b%3Fc%25d/dist-tags",
			);
		});

		it("shares one request between concurrent lookups", async () => {
			npmrc(`registry=${slow.url}/`);
			const results = await Promise.all([
				npmHandler.fetchLatestVersion("foo"),
				npmHandler.fetchLatestVersion("foo"),
				npmHandler.fetchLatestVersion("foo"),
			]);
			assert.deepEqual(results, ["3.0.0", "3.0.0", "3.0.0"]);
			assert.equal(slow.requests.length, 1);
		});

		it("lets in-flight requests finish when the cache is cleared", async () => {
			const slowHttps = await startServer(
				(req, res) => setTimeout(() => packument("4.0.0")(req, res), 200),
				{ key: ca.serverKey, cert: ca.serverCert },
			);
			try {
				npmrc(`registry=${slowHttps.url}/`, `cafile=${ca.caFile}`);
				const lookup = npmHandler.fetchLatestVersion("foo");
				await new Promise((r) => setTimeout(r, 50));
				npmHandler.clearCache?.();
				assert.equal(await lookup, "4.0.0");
			} finally {
				await slowHttps.close();
			}
		});
	});
});
