# Provider connection configuration

Settings may override only the built-in `openai` and `anthropic` connections, using `baseUrl` and `apiKeyEnv`. A Workspace provider entry replaces the matching global provider entry as a unit; omitted values fall back to the built-in connection, not to fields from the global override.

`baseUrl` must be an absolute HTTP or HTTPS URL without embedded credentials, and `apiKeyEnv` must name an uppercase environment variable. Literal keys, tokens, protocols, and custom providers are rejected; credentials are read from the named environment variable and configuration output reports only whether they are present.
