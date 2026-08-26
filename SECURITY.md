# Security

Please report vulnerabilities privately through GitHub Security Advisories for this repository. Do not include credentials, private prompts, customer data, or unredacted runtime output in an issue.

`agent-v` follows least authority: hosts decide approvals, tools receive explicit context, local workspace access defaults to read-only, and config stores credential references rather than secrets. Applications remain responsible for sandboxing untrusted tools, validating externally supplied artifacts, and protecting their persistence backend.
