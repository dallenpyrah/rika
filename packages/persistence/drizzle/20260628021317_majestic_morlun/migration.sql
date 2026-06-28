CREATE TABLE `mcp_server_approvals` (
	`id` text PRIMARY KEY,
	`workspace_root` text NOT NULL,
	`server_name` text NOT NULL,
	`fingerprint` text NOT NULL,
	`approved_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_server_approvals_workspace_server_fingerprint_idx` ON `mcp_server_approvals` (`workspace_root`,`server_name`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `mcp_server_approvals_workspace_idx` ON `mcp_server_approvals` (`workspace_root`);