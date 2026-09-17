# Security

Speedlog makes network requests to one server per run, and only while a test is running — the nearest LibreSpeed public server by default, a specific one, or `speed.cloudflare.com`, as selected in settings: small requests to measure latency, sized downloads, and uploads whose body is zeros. Nothing about you or your vault is sent. Results are stored as plain Markdown files inside your vault.

If you find a vulnerability — for example a way for a response from that host, or note content, to execute code or write outside the plugin's folder — please report it privately rather than in a public issue.

Use GitHub's private reporting: **Security → Report a vulnerability** on this repository. You'll get a reply within a week.
