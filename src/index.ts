import OAuthProvider, { getOAuthApi, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { handleAuthorize, SCOPE_READ, SCOPE_WRITE } from "./authorize";
import type { Env, GrantProps } from "./env";
import { buildServer } from "./tools";

/**
 * MCP endpoint. The OAuth provider has already validated the bearer token and
 * decrypted the grant's props (EG4 credentials) into ctx.props.
 * Stateless: a fresh server and transport per request.
 */
const mcpHandler: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const props = (ctx as ExecutionContext & { props: GrantProps }).props;
    const server = buildServer(env, props);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/authorize") return handleAuthorize(request, env);
    if (pathname === "/" || pathname === "/health") {
      return Response.json({ name: "eg4-mcp", mcp: "/mcp", ok: true });
    }
    return new Response("Not found", { status: 404 });
  },
};

function makeOptions(env: Env): OAuthProviderOptions<Env> {
  const origin = env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  return {
    apiRoute: "/mcp",
    apiHandler: mcpHandler as OAuthProviderOptions<Env>["apiHandler"],
    defaultHandler: defaultHandler as OAuthProviderOptions<Env>["defaultHandler"],
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    // CIMD is the MCP-preferred registration method; DCR stays on for clients that don't support it yet.
    clientIdMetadataDocumentEnabled: true,
    clientRegistrationEndpoint: "/register",
    scopesSupported: [SCOPE_READ, SCOPE_WRITE],
    accessTokenTTL: 60 * 60,
    refreshTokenTTL: 90 * 24 * 60 * 60,
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      resource_name: "EG4 inverter & battery",
    },
  };
}

// Options depend on env (the public URL), so build the provider on first use.
let provider: OAuthProvider<Env> | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    provider ??= new OAuthProvider<Env>(makeOptions(env));
    return provider.fetch(request, env, ctx);
  },
  async scheduled(_event: ScheduledController, env: Env) {
    const result = await getOAuthApi(makeOptions(env), env).purgeExpiredData({ batchSize: 100 });
    console.log("purgeExpiredData", JSON.stringify(result));
  },
} satisfies ExportedHandler<Env>;
