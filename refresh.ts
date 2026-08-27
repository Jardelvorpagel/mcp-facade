import { execFileSync, execSync } from "child_process";
import { Database } from "bun:sqlite";

const OMP = `${process.env.HOME}/.bun/bin/omp`;
const AGENT_DB = `${process.env.HOME}/.omp/agent/agent.db`;

export interface OAuthConfig {
	tokenUrl: string;
	clientId: string;
	// Indirect reference to the client secret. NEVER put the secret itself in
	// config. Supported forms:
	//   "keychain:<service>" -> security find-generic-password -s <service> -w
	//   "env:<VAR>"          -> process.env[VAR]
	// Omit entirely for public clients that refresh without a secret (Atlassian).
	clientSecretFrom?: string;
	// How client credentials are presented to the token endpoint:
	//   "body" (default) -> grant_type + client_id + refresh_token in the form
	//                       body; historical facade behaviour (Atlassian).
	//   "basic"          -> Authorization: Basic base64(client_id:client_secret),
	//                       body carries refresh_token only. Required by Figma:
	//                       https://developers.figma.com/docs/rest-api/oauth-apps/
	authStyle?: "body" | "basic";
}

export interface UpstreamHttp {
	url: string;
	credentialId?: string;
	oauth?: OAuthConfig;
}

// Resolve a client secret from an indirect reference. The value is never logged
// and never written back to disk. Errors name only the reference, never bytes.
export function resolveClientSecret(spec: string): string {
	const sep = spec.indexOf(":");
	const scheme = sep === -1 ? "" : spec.slice(0, sep);
	const rest = sep === -1 ? "" : spec.slice(sep + 1);
	if (!rest) {
		throw new Error(`clientSecretFrom is malformed (want "keychain:<service>" or "env:<VAR>")`);
	}
	if (scheme === "env") {
		const v = process.env[rest];
		if (!v) throw new Error(`clientSecretFrom env:${rest} is unset or empty`);
		return v;
	}
	if (scheme === "keychain") {
		let out: string;
		try {
			// execFileSync with an argv array: no shell, so the service name can
			// never be interpolated into a command line.
			out = execFileSync("/usr/bin/security", ["find-generic-password", "-s", rest, "-w"], {
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			throw new Error(`clientSecretFrom keychain:${rest} not found in the login keychain`);
		}
		const v = out.trim();
		if (!v) throw new Error(`clientSecretFrom keychain:${rest} resolved to an empty value`);
		return v;
	}
	throw new Error(`clientSecretFrom scheme "${scheme}" is unsupported (use keychain: or env:)`);
}

// Try `omp token` first; on failure, direct OAuth refresh if oauth config exists.
export async function fetchToken(up: UpstreamHttp): Promise<string> {
	try {
		const token = execSync(`${OMP} token "${up.credentialId}"`, { encoding: "utf-8" }).trim();
		if (token) return token;
	} catch {}
	if (up.oauth) {
		return refreshOAuth(up);
	}
	throw new Error(`no token for ${up.credentialId} and no oauth config`);
}

// Direct OAuth refresh: read row from agent.db, POST refresh_token grant,
// write back new access/refresh/expires. Returns new access token.
export async function refreshOAuth(up: UpstreamHttp): Promise<string> {
	const db = new Database(AGENT_DB);
	let began = false;
	try {
		db.run("BEGIN IMMEDIATE");
		began = true;
		const row = db
			.prepare(
				"SELECT id, data FROM auth_credentials WHERE provider = ? AND disabled_cause IS NULL ORDER BY updated_at DESC LIMIT 1",
			)
			.get(up.credentialId) as { id: number; data: string } | undefined;
		if (!row) {
			throw new Error(`no auth_credentials row for provider ${up.credentialId}`);
		}
		const data = JSON.parse(row.data);
		if (!data.refresh) {
			throw new Error(`no refresh_token in row ${row.id}`);
		}
		const oauth = up.oauth!;
		const headers: Record<string, string> = {
			"Content-Type": "application/x-www-form-urlencoded",
		};
		let body: URLSearchParams;
		if (oauth.authStyle === "basic") {
			if (!oauth.clientSecretFrom) {
				throw new Error(`oauth.authStyle "basic" requires clientSecretFrom`);
			}
			const secret = resolveClientSecret(oauth.clientSecretFrom);
			const basic = Buffer.from(`${oauth.clientId}:${secret}`).toString("base64");
			headers.Authorization = `Basic ${basic}`;
			body = new URLSearchParams({ refresh_token: data.refresh });
		} else {
			body = new URLSearchParams({
				grant_type: "refresh_token",
				client_id: oauth.clientId,
				refresh_token: data.refresh,
			});
			if (oauth.clientSecretFrom) {
				body.set("client_secret", resolveClientSecret(oauth.clientSecretFrom));
			}
		}
		const res = await fetch(oauth.tokenUrl, {
			method: "POST",
			headers,
			body: body.toString(),
		});
		if (!res.ok) {
			throw new Error(`refresh failed: HTTP ${res.status}`);
		}
		const json = (await res.json()) as Record<string, unknown>;
		const newAccess = json.access_token as string;
		const newRefresh = (json.refresh_token as string) ?? data.refresh;
		const expiresIn = (json.expires_in as number) ?? 3600;
		const expires = Date.now() + expiresIn * 1000;
		data.access = newAccess;
		data.refresh = newRefresh;
		data.expires = expires;
		db.prepare("UPDATE auth_credentials SET data = ?, updated_at = strftime('%s','now') WHERE id = ?").run(
			JSON.stringify(data),
			row.id,
		);
		db.run("COMMIT");
		began = false;
		return newAccess;
	} finally {
		if (began) {
			try {
				db.run("ROLLBACK");
			} catch {}
		}
		db.close();
	}
}
