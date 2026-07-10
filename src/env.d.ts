// Augment the auto-generated Env with secrets and vars that aren't
// picked up by `wrangler types` (secrets are never in wrangler.jsonc).
// We augment __BaseEnv_Env so both `Env` and `Cloudflare.Env` (used by
// `import { env } from "cloudflare:workers"`) pick up these properties.
interface __BaseEnv_Env {
	// Secrets (set via `wrangler secret put`)
	GATEWAY_ID: string;
	CLOUDFLARE_ACCOUNT_ID: string;
	AIG_PROXY_URL: string;
	CF_ACCESS_AUD: string;
	CF_ACCESS_CERTS_URL: string;
	CF_AIG_TOKEN: string;
}
