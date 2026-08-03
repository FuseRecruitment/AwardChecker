/**
 * Vercel Edge Middleware -- whole-site password gate.
 *
 * Ported from a Cloudflare Worker version (which used
 * `env.ASSETS.fetch(request)` -- Cloudflare-specific, not available on
 * Vercel). This does the same job using Vercel's Edge Middleware
 * convention instead.
 *
 * WHY THIS IS BETTER THAN THE SHARED-SECRET-ON-THE-API APPROACH:
 * That approach only gated /api/award-rates -- the tool itself
 * (public/index.html) was still fully visible to anyone with the link,
 * including its margin slider and quoting logic. This gates EVERYTHING
 * -- nobody gets past the password screen to see the tool OR call the
 * API. Once someone logs in, their browser's session cookie rides
 * along automatically with the tool's own fetch("/api/award-rates")
 * calls (same-origin requests always send cookies), so the API is
 * covered for free -- no extra token/header logic needed on that side.
 *
 * Because of this, once this middleware is live, the FWC_PROXY_TOKEN /
 * PROXY_SHARED_SECRET mechanism in api/award-rates.js becomes
 * redundant. You can leave it in as a harmless extra layer, or remove
 * it to simplify -- your call.
 *
 * PROJECT LAYOUT:
 *   your-project/
 *     middleware.js     <-- this file, AT THE ROOT (not in api/ or public/)
 *     package.json
 *     api/
 *       award-rates.js
 *     public/
 *       index.html
 *
 * SETUP:
 * 1. Add this file as middleware.js at your project's root.
 * 2. Vercel dashboard -> Project -> Settings -> Environment Variables
 *    -> add PAGE_PASSWORD (Production + Preview) with whatever password
 *    you want the team to use.
 * 3. Deploy (git push, or `vercel --prod`).
 * 4. Visit the site in a private/incognito window -- you should see
 *    the password screen before anything else. Enter the password,
 *    confirm you land on the actual tool.
 *
 * NOTE ON THE MATCHER BELOW: it's written to cover every request
 * (site + API) except Vercel's own internal/static asset paths, which
 * must stay reachable for the page to render at all. If you ever add
 * more routes, this doesn't need updating -- it already covers
 * everything by default.
 */

const COOKIE_NAME = "site_auth";

export const config = {
  matcher: [
    // Run on everything except Vercel/Next internal paths and common
    // static file extensions, which need to load unauthenticated for
    // the page itself to render.
    "/((?!_next/static|_next/image|favicon.ico).*)"
  ]
};

function loginPage(error) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fuse Recruitment — Rate Card</title>
  <style>
    :root {
      --navy: #151A36;
      --white: #FFFFFF;
      --steel-blue: #E6EFF3;
      --concrete-blue: #A2C8D8;
      --blue: #009CDD;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--navy);
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
    }
    form {
      background: var(--white);
      padding: 2.5rem 2.5rem 2rem;
      border-radius: 10px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.25);
      text-align: center;
      width: 280px;
      border-top: 4px solid var(--blue);
    }
    h1 {
      font-size: 1.05rem;
      font-weight: 600;
      margin: 0 0 1.4rem;
      color: var(--navy);
    }
    input[type="password"] {
      width: 100%;
      padding: 0.65rem 0.75rem;
      font-size: 1rem;
      border: 1px solid var(--concrete-blue);
      background: var(--steel-blue);
      border-radius: 6px;
      box-sizing: border-box;
      margin-bottom: 1.1rem;
      color: var(--navy);
    }
    input[type="password"]:focus {
      outline: none;
      border-color: var(--blue);
      background: var(--white);
    }
    button {
      width: 100%;
      padding: 0.65rem;
      font-size: 1rem;
      font-weight: 600;
      background: var(--blue);
      color: var(--white);
      border: none;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    button:hover {
      background: var(--navy);
    }
    .error {
      color: #c0392b;
      font-size: 0.85rem;
      margin-bottom: 0.9rem;
    }
  </style>
</head>
<body>
  <form method="POST">
    <h1>Enter password to continue</h1>
    ${error ? `<div class="error">Incorrect password. Try again.</div>` : ""}
    <input type="password" name="password" autofocus required>
    <button type="submit">Enter</button>
  </form>
</body>
</html>`;
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`${name}=([^;]+)`));
  return match ? match[1] : null;
}

export default async function middleware(request) {
  const expectedPassword = process.env.PAGE_PASSWORD;

  if (!expectedPassword) {
    // Fail safe, not open -- if the password isn't configured, block
    // access and say so, rather than silently letting everyone in.
    return new Response("Site password is not configured. Set PAGE_PASSWORD in Vercel's environment variables.", {
      status: 500
    });
  }

  // Handle password form submission
  if (request.method === "POST") {
    const formData = await request.formData();
    const submitted = formData.get("password");

    if (submitted === expectedPassword) {
      const response = new Response(null, {
        status: 302,
        headers: { Location: "/" }
      });
      response.headers.append(
        "Set-Cookie",
        `${COOKIE_NAME}=${expectedPassword}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`
      );
      return response;
    }

    return new Response(loginPage(true), {
      status: 401,
      headers: { "Content-Type": "text/html" }
    });
  }

  // For GET/HEAD/etc, check for a valid session cookie
  const cookie = getCookie(request, COOKIE_NAME);
  if (cookie === expectedPassword) {
    return; // valid session -- let the request through to the actual page/API
  }

  // No valid cookie -- show the login form instead of the real page
  return new Response(loginPage(false), {
    status: 200,
    headers: { "Content-Type": "text/html" }
  });
}
