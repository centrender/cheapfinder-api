// src/oauth_etsy.js
import axios from "axios";
import crypto from "crypto";

const AUTH_URL = "https://www.etsy.com/oauth/connect";
const TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function sha256(input) {
  return crypto.createHash("sha256").update(input).digest();
}

export function mountEtsyOAuth(app) {
  const stateStore = new Map(); // ephemeral (ok for one-time setup)

  app.get("/oauth/etsy/start", (req, res) => {
    const client_id = process.env.ETSY_API_KEY;
    if (!client_id) return res.status(400).send("Missing ETSY_API_KEY");

    const redirect_uri =
      process.env.ETSY_REDIRECT_URI || `https://${req.headers.host}/oauth/etsy/callback`;

    const state = b64url(crypto.randomBytes(16));
    const code_verifier = b64url(crypto.randomBytes(32));
    const code_challenge = b64url(sha256(code_verifier));

    // keep verifier for callback (10 min)
    stateStore.set(state, code_verifier);
    setTimeout(() => stateStore.delete(state), 10 * 60 * 1000);

    const scope = "listings_r"; // add more read scopes later if needed

    const url = new URL(AUTH_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", client_id);
    url.searchParams.set("redirect_uri", redirect_uri);
    url.searchParams.set("scope", scope);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", code_challenge);
    url.searchParams.set("code_challenge_method", "S256");

    res.redirect(url.toString());
  });

  app.get("/oauth/etsy/callback", async (req, res) => {
    try {
      const client_id = process.env.ETSY_API_KEY;
      const redirect_uri =
        process.env.ETSY_REDIRECT_URI || `https://${req.headers.host}/oauth/etsy/callback`;

      const { code, state } = req.query;
      const code_verifier = stateStore.get(state);
      if (!code || !code_verifier) return res.status(400).send("Invalid/expired state or code");

      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id,
        redirect_uri,
        code,
        code_verifier,
      });

      const { data } = await axios.post(TOKEN_URL, body.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });

      // Show tokens so you can copy them into Render env vars
      res.send(
        `<pre>
ETSY_ACCESS_TOKEN=${data.access_token}
ETSY_REFRESH_TOKEN=${data.refresh_token || "(none given)"}
expires_in=${data.expires_in}s

→ In Render → Environment:
  - set ETSY_ACCESS_TOKEN to the value above
  - (optionally) store ETSY_REFRESH_TOKEN for future refresh
Then redeploy with MOCK_MODE=false
</pre>`
      );
    } catch (e) {
      res.status(500).send(`OAuth exchange failed: ${String(e)}`);
    }
  });
}
