# Security

This project is an execution release candidate awaiting a live two-owner pilot. Commands run only on explicitly approved private workers. Never give project code provider management credentials, billing tokens, App private keys or production secrets. Source checkout tokens are read-only and revoked before commands run; results require independent provider and immutable-audit verification.

Please use the repository's **Security / Advisories / Report a vulnerability** feature for sensitive reports if available. If private reporting is unavailable, open an issue requesting a private reporting channel without including exploit details or credentials. No dedicated security email or response-time guarantee is currently published.

Run the dashboard behind HTTPS, restrict host and log access, protect the persistent volume, and keep the original encryption key backed up separately. This is one company's instance with one trusted administrator, not a multi-tenant service. Set the administrator username/password through private environment variables; GitHub authorizations connect capacity accounts. Enabling password login removes administrator access from old GitHub-owner sessions, and credential changes invalidate existing password sessions. Invite only consenting company accounts. Review dependency updates and maintain provider-side spending limits.

Use synthetic credentials in tests. Report suspected secret exposure promptly, revoke affected authorizations with the provider, and treat exposed database-plus-key backups as credential exposure. Removing a member in BuildFerry deletes its stored authorization but does not revoke it at GitHub.
