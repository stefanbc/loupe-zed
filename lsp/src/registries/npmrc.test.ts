import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { rootCertificates } from "node:tls";
import { cleanupTempDirs, makeTempDir, withNpmrc } from "../test-utils";
import { authHeaderFor, httpsAgent, registryFor, reloadNpmrc } from "./npmrc";

after(() => {
	reloadNpmrc();
	cleanupTempDirs();
});

const basic = (s: string) => `Basic ${Buffer.from(s).toString("base64")}`;

describe("registryFor", () => {
	it("falls back to npmjs.org without ~/.npmrc", () => {
		process.env.HOME = makeTempDir();
		reloadNpmrc();
		assert.equal(registryFor("react"), "https://registry.npmjs.org/");
	});

	it("uses the configured default registry and adds a trailing slash", () => {
		withNpmrc("registry=http://npm.example/repository/npm-all\n");
		assert.equal(
			registryFor("react"),
			"http://npm.example/repository/npm-all/",
		);
	});

	it("uses scope registries only for that scope", () => {
		withNpmrc(
			[
				"# comment",
				"; another comment",
				'@corp:registry="https://npm.corp.example/"',
			].join("\n"),
		);
		assert.equal(registryFor("@corp/ui"), "https://npm.corp.example/");
		assert.equal(registryFor("@other/ui"), "https://registry.npmjs.org/");
		assert.equal(registryFor("react"), "https://registry.npmjs.org/");
	});

	it("strips inline comments like npm, unless escaped or quoted", () => {
		withNpmrc(
			[
				"registry=https://npm.corp.example/ ; internal mirror",
				"@a:registry=https://a.example/#anchor",
				"@b:registry=https://b.example/\\;x",
				'@c:registry="https://c.example/;x"',
			].join("\n"),
		);
		assert.equal(registryFor("react"), "https://npm.corp.example/");
		assert.equal(registryFor("@a/x"), "https://a.example/");
		assert.equal(registryFor("@b/x"), "https://b.example/;x/");
		assert.equal(registryFor("@c/x"), "https://c.example/;x/");
	});

	it("treats a scope without a slash as the whole scope", () => {
		withNpmrc("@corp:registry=https://npm.corp.example/\n");
		assert.equal(registryFor("@corp"), "https://npm.corp.example/");
	});
});

describe("authHeaderFor", () => {
	it("returns a bearer token, expanding env placeholders", () => {
		process.env.LOUPE_TEST_TOKEN = "s3cret";
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal .npmrc syntax under test
		withNpmrc("//npm.example/:_authToken=${LOUPE_TEST_TOKEN}\n");
		assert.equal(authHeaderFor("https://npm.example/react"), "Bearer s3cret");
	});

	it("ignores the protocol, so http and https share credentials", () => {
		withNpmrc("//npm.example/:_authToken=tok\n");
		assert.equal(authHeaderFor("http://npm.example/react"), "Bearer tok");
		assert.equal(authHeaderFor("https://npm.example/react"), "Bearer tok");
	});

	it("supports _auth and username/_password", () => {
		withNpmrc(
			[
				"//a.example/:_auth=YWxpY2U6cHc=",
				"//b.example/:username=bob",
				`//b.example/:_password=${Buffer.from("pw").toString("base64")}`,
			].join("\n"),
		);
		assert.equal(authHeaderFor("https://a.example/x"), "Basic YWxpY2U6cHc=");
		assert.equal(authHeaderFor("https://b.example/x"), basic("bob:pw"));
	});

	it("picks the longest matching prefix and keeps ports intact", () => {
		withNpmrc(
			[
				"//npm.example:4873/:_authToken=host",
				"//npm.example:4873/repo/:_authToken=repo",
			].join("\n"),
		);
		assert.equal(
			authHeaderFor("https://npm.example:4873/repo/@a%2fb"),
			"Bearer repo",
		);
		assert.equal(
			authHeaderFor("https://npm.example:4873/other/x"),
			"Bearer host",
		);
		assert.equal(authHeaderFor("https://npm.example/x"), undefined);
	});

	it("returns nothing for unconfigured hosts", () => {
		withNpmrc("//npm.example/:_authToken=tok\n");
		assert.equal(authHeaderFor("https://registry.npmjs.org/react"), undefined);
	});
});

describe("httpsAgent", () => {
	it("is undefined without TLS settings", () => {
		withNpmrc("registry=https://npm.example/\n");
		assert.equal(httpsAgent(), undefined);
	});

	it("adds cafile certificates to the default roots instead of replacing them", () => {
		const dir = makeTempDir();
		const caFile = join(dir, "ca.pem");
		writeFileSync(
			caFile,
			"-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
		);
		withNpmrc(`cafile=${caFile}\n`);

		const ca = httpsAgent()?.options.ca as string[];
		assert.ok(ca.includes(rootCertificates[0]));
		assert.equal(ca.length, rootCertificates.length + 1);
		assert.match(ca[ca.length - 1], /AAAA/);
	});

	it("unescapes inline ca values and ignores ca=null", () => {
		withNpmrc(
			[
				'ca="-----BEGIN CERTIFICATE-----\\nBBBB\\n-----END CERTIFICATE-----"',
				"ca[]=null",
			].join("\n"),
		);
		const ca = httpsAgent()?.options.ca as string[];
		assert.equal(ca.length, rootCertificates.length + 1);
		assert.equal(
			ca[ca.length - 1],
			"-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----",
		);
	});

	it("expands ~ in cafile paths", () => {
		const home = withNpmrc("cafile=~/certs/ca.pem\n");
		mkdirSync(join(home, "certs"));
		writeFileSync(
			join(home, "certs", "ca.pem"),
			"-----BEGIN CERTIFICATE-----\nCCCC\n-----END CERTIFICATE-----\n",
		);
		reloadNpmrc();
		const ca = httpsAgent()?.options.ca as string[];
		assert.match(ca[ca.length - 1], /CCCC/);
	});

	it("keeps the agent across reloads while the TLS settings stay the same", () => {
		withNpmrc("strict-ssl=false\n");
		const first = httpsAgent();
		reloadNpmrc();
		assert.equal(httpsAgent(), first);
		withNpmrc("strict-ssl=false\nregistry=https://npm.example/\n");
		assert.equal(httpsAgent(), first);
		withNpmrc(`strict-ssl=false\ncafile=${join(makeTempDir(), "none.pem")}\n`);
		assert.equal(httpsAgent(), first);
		withNpmrc(
			'ca="-----BEGIN CERTIFICATE-----\\nDDDD\\n-----END CERTIFICATE-----"\n',
		);
		assert.notEqual(httpsAgent(), first);
	});

	it("disables verification with strict-ssl=false", () => {
		withNpmrc("strict-ssl=false\n");
		assert.equal(httpsAgent()?.options.rejectUnauthorized, false);
	});

	it("survives a missing cafile", () => {
		withNpmrc("cafile=/does/not/exist.pem\nregistry=https://npm.example/\n");
		assert.equal(httpsAgent(), undefined);
		assert.equal(registryFor("react"), "https://npm.example/");
	});
});
