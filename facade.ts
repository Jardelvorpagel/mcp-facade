import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { fetchToken, refreshOAuth, type UpstreamHttp } from "./refresh.js";

// Generic MCP facade: exposes a configured subset of an upstream server's tools
// with compacted schemas, plus discover/describe/call meta-tools for the rest.
// One process per upstream server: bun run facade.ts --server <name>
// Config: facade.servers.json next to this file. Secrets are NEVER in config —
// HTTP upstreams fetch OAuth tokens via `omp token <credentialId>`; stdio
// upstreams read env from an existing host config ("envFrom": "claude:<name>").
// NOTE: stdio transport owns stdout — all diagnostics go to stderr.

interface UpstreamStdio {
	command: string;
	args?: string[];
	envFrom?: string;
	env?: Record<string, string>;
}
interface ServerConfig {
	upstream: UpstreamHttp | UpstreamStdio;
	used: string[];
}

const serverName = (() => {
	const i = process.argv.indexOf("--server");
	if (i < 0 || !process.argv[i + 1]) {
		console.error("[facade] missing --server <name>");
		process.exit(1);
	}
	return process.argv[i + 1];
})();

const CONFIG_PATH = `${dirname(new URL(import.meta.url).pathname)}/facade.servers.json`;
const configs = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, ServerConfig>;
const config = configs[serverName];
if (!config) {
	console.error(`[facade] no config for server "${serverName}" in ${CONFIG_PATH}`);
	process.exit(1);
}

const CATALOG_DIR = `${process.env.HOME}/.omp/agent/mcp-facade/catalogs`;
const CATALOG_PATH = `${CATALOG_DIR}/${serverName}.json`;
const CATALOG_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

interface RemoteTool {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

let client: Client | null = null;
let catalog: RemoteTool[] | null = null;

function envFromClaude(key: string): Record<string, string> {
	const [, server] = key.split(":");
	try {
		const claude = JSON.parse(readFileSync(`${process.env.HOME}/.claude.json`, "utf-8"));
		return claude?.mcpServers?.[server]?.env ?? {};
	} catch {
		return {};
	}
}

async function connectUpstream(): Promise<Client> {
	const up = config.upstream;
	const c = new Client({ name: `${serverName}-facade`, version: "1.0.0" });
	if ("url" in up) {
		const headers: Record<string, string> = {};
		if (up.credentialId) {
			const token = await fetchToken(up);
			headers.Authorization = `Bearer ${token}`;
		}
		await c.connect(new StreamableHTTPClientTransport(new URL(up.url), { requestInit: { headers } }));
	} else {
		const env = { ...process.env, ...(up.envFrom ? envFromClaude(up.envFrom) : {}), ...(up.env ?? {}) } as Record<string, string>;
		await c.connect(new StdioClientTransport({ command: up.command, args: up.args ?? [], env }));
	}
	client = c;
	return c;
}

async function getClient(refresh = false): Promise<Client> {
	if (client && !refresh) return client;
	return connectUpstream();
}

async function getCatalog(): Promise<RemoteTool[]> {
	if (catalog) return catalog;
	if (existsSync(CATALOG_PATH)) {
		try {
			const cached = JSON.parse(readFileSync(CATALOG_PATH, "utf-8"));
			if (Date.now() - cached.fetchedAt < CATALOG_MAX_AGE_MS) {
				catalog = cached.tools;
				return catalog as RemoteTool[];
			}
		} catch {}
	}
	const c = await getClient();
	const res = await c.listTools();
	catalog = res.tools as RemoteTool[];
	mkdirSync(CATALOG_DIR, { recursive: true });
	writeFileSync(CATALOG_PATH, JSON.stringify({ fetchedAt: Date.now(), tools: catalog }));
	return catalog;
}

function firstSentence(text: string, max = 140): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const cut = flat.search(/(?<=[.!?])\s/);
	const sentence = cut > 0 ? flat.slice(0, cut) : flat;
	return sentence.length > max ? sentence.slice(0, max - 1) + "…" : sentence;
}

function compactSchema(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(compactSchema);
	if (node && typeof node === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(node)) {
			if (k === "description" && typeof v === "string") out[k] = firstSentence(v);
			else if (k === "$comment" || k === "examples" || k === "default") continue;
			else out[k] = compactSchema(v);
		}
		return out;
	}
	return node;
}
/**
 * Structural prune: recurse only through required fields; optional subtrees
 * collapse to `{ type, description }`. Full shape stays reachable via describe.
 */
function pruneSchema(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(pruneSchema);
	if (!node || typeof node !== "object") return node;
	const obj = node as Record<string, unknown>;
	const required = new Set((obj.required as string[] | undefined) ?? []);
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (k === "$comment" || k === "examples" || k === "default" || k === "additionalProperties") continue;
		if (k === "description" && typeof v === "string") {
			out[k] = firstSentence(v, 100);
			continue;
		}
		if (k === "properties" && v && typeof v === "object") {
			const props: Record<string, unknown> = {};
			for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
				const p = pv as Record<string, unknown> | undefined;
				if (required.has(pk)) props[pk] = pruneSchema(pv);
				else
					props[pk] = {
						type: (p?.type as string) ?? "unknown",
						description: firstSentence((p?.description as string) ?? "optional", 60),
					};
			}
			out.properties = props;
			continue;
		}
		if ((k === "anyOf" || k === "oneOf" || k === "allOf") && Array.isArray(v)) {
			out[k] = v.map(pruneSchema);
			continue;
		}
		out[k] = pruneSchema(v);
	}
	return out;
}

function compactTool(tool: RemoteTool): RemoteTool {
	return {
		name: tool.name.toLowerCase(),
		description: firstSentence(tool.description ?? ""),
		inputSchema: pruneSchema(compactSchema(tool.inputSchema ?? { type: "object" })),
	};
}

function findRemote(name: string, tools: RemoteTool[]): RemoteTool | undefined {
	const lower = name.toLowerCase();
	return tools.find((t) => t.name.toLowerCase() === lower);
}

const META_TOOLS = [
	{
		name: "discover",
		description: `Search the full ${serverName} tool catalog (including tools not directly exposed). Returns matching tool names with one-line descriptions. Call any of them via the call tool.`,
		inputSchema: {
			type: "object",
			properties: { query: { type: "string", description: "keywords, e.g. 'worklog' or 'comment'" } },
			required: ["query"],
			additionalProperties: false,
		},
	},
	{
		name: "describe",
		description: `Get the FULL original schema and documentation for one ${serverName} tool (by lowercase name, e.g. from discover). Use before calling an unfamiliar tool.`,
		inputSchema: {
			type: "object",
			properties: { tool: { type: "string" } },
			required: ["tool"],
			additionalProperties: false,
		},
	},
	{
		name: "call",
		description: `Call any ${serverName} tool by name (including ones not directly exposed). Params: tool (lowercase name, e.g. from discover), args (object per its schema — use describe first if unsure).`,
		inputSchema: {
			type: "object",
			properties: {
				tool: { type: "string" },
				args: { type: "object", additionalProperties: true },
			},
			required: ["tool"],
			additionalProperties: false,
		},
	},
];

async function proxyCall(remoteName: string, args: unknown, allowRetry = true): Promise<unknown> {
	try {
		const c = await getClient();
		return await c.callTool({ name: remoteName, arguments: args as Record<string, unknown> });
	} catch (err) {
		if (allowRetry && "url" in config.upstream && config.upstream.credentialId && /401|unauthorized|invalid.*token|expired/i.test(String(err))) {
			console.error(`[facade:${serverName}] auth refresh + retry`);
			client = null;
			const up = config.upstream as UpstreamHttp;
			if (up.oauth) {
				// 401 means the cached access token is dead — refresh directly, don't call omp token
				await refreshOAuth(up);
			}
			const c = await getClient(true);
			return await c.callTool({ name: remoteName, arguments: args as Record<string, unknown> });
		}
		throw err;
	}
}

const server = new Server({ name: serverName, version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
	try {
		const tools = await getCatalog();
		const exposed = config.used.map((name) => findRemote(name, tools)).filter((t): t is RemoteTool => Boolean(t));
		return { tools: [...exposed.map(compactTool), ...META_TOOLS] };
	} catch (err) {
		console.error(`[facade:${serverName}] catalog unavailable, serving meta-tools only: ${String(err).slice(0, 200)}`);
		return { tools: META_TOOLS };
	}
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
	const name = req.params.name;
	const args = (req.params.arguments ?? {}) as Record<string, unknown>;
	const tools = await getCatalog();

	if (name === "discover") {
		const q = String(args.query ?? "").toLowerCase();
		const hits = tools
			.filter((t) => !q || t.name.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q))
			.slice(0, 10)
			.map((t) => `${t.name.toLowerCase()} — ${firstSentence(t.description ?? "", 100)}`);
		return { content: [{ type: "text", text: hits.length ? hits.join("\n") : "no tools match" }] };
	}
	if (name === "describe") {
		const tool = findRemote(String(args.tool ?? ""), tools);
		if (!tool) return { content: [{ type: "text", text: `unknown tool: ${String(args.tool)} — run discover first` }], isError: true };
		return { content: [{ type: "text", text: JSON.stringify(tool, null, 2) }] };
	}
	if (name === "call") {
		const tool = findRemote(String(args.tool ?? ""), tools);
		if (!tool) return { content: [{ type: "text", text: `unknown tool: ${String(args.tool)} — run discover first` }], isError: true };
		const result = await proxyCall(tool.name, args.args ?? {});
		return result as never;
	}

	const tool = findRemote(name, tools);
	if (!tool) return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
	const result = await proxyCall(tool.name, args);
	return result as never;
});

await server.connect(new StdioServerTransport());
console.error(`[facade] ${serverName} facade up (${config.used.length} used tools + 3 meta)`);
