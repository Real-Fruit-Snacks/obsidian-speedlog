# Security

Speedlog makes network requests to exactly one host, `speed.cloudflare.com`, and only while a test is running: small requests to measure latency, sized downloads, and uploads whose body is zeros. Nothing about you or your vault is sent. Results are stored as plain Markdown files inside your vault.

If you find a vulnerability — for example a way for a response from that host, or note content, to execute code or write outside the plugin's folder — please report it privately rather than in a public issue.

Use GitHub's private reporting: **Security → Report a vulnerability** on this repository. You'll get a reply within a week.
