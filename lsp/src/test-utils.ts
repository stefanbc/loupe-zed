import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
	createServer as createHttpServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reloadNpmrc } from "./registries/npmrc";

const tempDirs: string[] = [];

export function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "loupe-test-"));
	tempDirs.push(dir);
	return dir;
}

/** Removes all temp dirs created via makeTempDir(). Call from `after()`. */
export function cleanupTempDirs(): void {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Points HOME at a fresh temp dir containing the given .npmrc and forces
 * the npmrc module to re-read it. os.homedir() honours HOME on every call.
 */
export function withNpmrc(content: string): string {
	const home = makeTempDir();
	writeFileSync(join(home, ".npmrc"), content);
	process.env.HOME = home;
	reloadNpmrc();
	return home;
}

// ── TLS ──────────────────────────────────────────────────────────────────────

export interface TestCa {
	/** Path to the CA certificate (PEM), for use as `cafile`. */
	caFile: string;
	caPem: string;
	serverKey: string;
	serverCert: string;
}

export function hasOpenssl(): boolean {
	try {
		execFileSync("openssl", ["version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Generates a throwaway CA and a server certificate for "localhost" signed
 * by it. Done at runtime so no private keys live in the repo.
 */
export function createTestCa(): TestCa {
	const dir = makeTempDir();
	const p = (name: string) => join(dir, name);
	const openssl = (...args: string[]) =>
		execFileSync("openssl", args, { stdio: "ignore" });

	openssl(
		"req",
		"-x509",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-days",
		"1",
		"-keyout",
		p("ca.key"),
		"-out",
		p("ca.pem"),
		"-subj",
		"/CN=Loupe Test CA",
	);
	openssl(
		"req",
		"-newkey",
		"rsa:2048",
		"-nodes",
		"-keyout",
		p("srv.key"),
		"-out",
		p("srv.csr"),
		"-subj",
		"/CN=localhost",
	);
	writeFileSync(
		p("ext.cnf"),
		"subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\n",
	);
	openssl(
		"x509",
		"-req",
		"-in",
		p("srv.csr"),
		"-CA",
		p("ca.pem"),
		"-CAkey",
		p("ca.key"),
		"-CAcreateserial",
		"-days",
		"1",
		"-out",
		p("srv.pem"),
		"-extfile",
		p("ext.cnf"),
	);

	return {
		caFile: p("ca.pem"),
		caPem: readFileSync(p("ca.pem"), "utf8"),
		serverKey: readFileSync(p("srv.key"), "utf8"),
		serverCert: readFileSync(p("srv.pem"), "utf8"),
	};
}

// ── Servers ──────────────────────────────────────────────────────────────────

export interface RecordedRequest {
	url: string;
	authorization?: string;
}

export interface TestServer {
	/** Base URL without trailing slash, e.g. "http://localhost:51234". */
	url: string;
	requests: RecordedRequest[];
	close(): Promise<void>;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** Starts an HTTP server (or HTTPS when tls is given) on a free port that records all requests. */
export async function startServer(
	handler: Handler,
	tls?: { key: string; cert: string },
): Promise<TestServer> {
	const requests: RecordedRequest[] = [];
	const recording: Handler = (req, res) => {
		requests.push({
			url: req.url ?? "",
			authorization: req.headers.authorization,
		});
		handler(req, res);
	};

	const server: Server = tls
		? createHttpsServer(tls, recording)
		: createHttpServer(recording);

	await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
	const { port } = server.address() as AddressInfo;

	return {
		url: `${tls ? "https" : "http"}://localhost:${port}`,
		requests,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/**
 * Serves a package whose latest dist-tag is the given version, both as the
 * "/-/package/<name>/dist-tags" document and as a packument. With
 * distTags: false the dist-tags endpoint 404s, like on Artifactory.
 */
export function packument(
	version: string,
	{ distTags = true }: { distTags?: boolean } = {},
): Handler {
	return (req, res) => {
		if (/\/-\/package\/.+\/dist-tags$/.test(req.url ?? "")) {
			if (!distTags) {
				res.writeHead(404);
				res.end();
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ latest: version }));
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ "dist-tags": { latest: version } }));
	};
}
