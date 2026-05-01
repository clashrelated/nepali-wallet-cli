# Security Policy

## Reporting a vulnerability

If you discover a security issue in `nepali-wallet-cli` — particularly anything that could lead to credential exposure, session theft, unauthorised transactions, or harm to users — **please do not file a public GitHub issue**.

Use GitHub's private vulnerability reporting instead:

→ **<https://github.com/clashrelated/nepali-wallet-cli/security/advisories/new>**

(Equivalent path: the repo's **Security** tab → **Report a vulnerability**.) Reports submitted this way are visible only to the maintainer and to anyone you explicitly add to the advisory thread.

Include:

- A clear description of the issue and its impact.
- Steps to reproduce, or proof-of-concept code, if available.
- The version / commit hash you tested against.
- Whether you believe the issue is already being exploited in the wild.

You will receive an acknowledgement within **72 hours**. The maintainer will work with you on a fix and a coordinated disclosure timeline. The default disclosure window is **90 days** from the date of the initial report, after which details may be made public regardless of patch status — earlier if a fix has shipped, later by mutual agreement.

## Scope

In scope:

- The CLI in `src/` and the MCP server at `src/mcp/server.js`.
- The credential-storage flow (`src/auth/keystore.js`, `src/auth/session.js`).
- Any code that handles user input destined for eSewa/Khalti.

Out of scope:

- Vulnerabilities in eSewa or Khalti themselves — please report those to **eSewa Money Transfer Pvt. Ltd.** or **IME Khalti Pvt. Ltd.** directly.
- Bugs in upstream dependencies (Playwright, keytar, etc.) — please report those to the respective projects. We will track advisories that affect us.
- Issues that require a pre-compromised local machine (an attacker with shell access to the user's account can already read the OS keychain by design).
- Social-engineering attacks against the operator.

## Threat model

`nepali-wallet-cli` runs entirely on the operator's own machine. It has no backend, no telemetry, and no shared infrastructure. Credentials live in the OS-native keychain via `keytar`; sessions live in `~/.config/nepali-wallet-cli/` with default user-only permissions.

The realistic high-impact threat surfaces we care about:

1. **Credential leak through the repo** — a published commit or log accidentally containing a real phone number, password, MPIN, OTP, or session cookie. Reports of this kind are treated as P0.
2. **Session-file world-readability** — anything that writes session JSON with permissive modes.
3. **MCP tool that performs a write operation without explicit user confirmation** — e.g. `wallet_send_money` executing without an MPIN prompt.
4. **Code-injection paths** — e.g. an unescaped recipient name flowing into a `page.evaluate(...)` template literal.
5. **Dependency supply-chain issues** affecting `playwright`, `keytar`, `@modelcontextprotocol/sdk`, `inquirer`.

## What this project will not do

- We will not adversarially fingerprint, evade, or circumvent fraud-detection logic operated by eSewa or Khalti. PRs in that direction will be rejected.
- We will not add features intended to access accounts other than the operator's own.
- We will not build, ship, or accept telemetry, analytics, or remote logging.

Thank you for helping keep this project, and the wallets of anyone who uses it, safe.
