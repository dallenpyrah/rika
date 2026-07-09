CREATE TABLE IF NOT EXISTS `artifacts` (
	`id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`workspace_id` text,
	`turn_id` text,
	`kind` text NOT NULL,
	`title` text,
	`content` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mcp_server_approvals` (
	`id` text PRIMARY KEY,
	`workspace_root` text NOT NULL,
	`server_name` text NOT NULL,
	`fingerprint` text NOT NULL,
	`approved_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `thread_events` (
	`id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`turn_id` text,
	`sequence` integer NOT NULL,
	`version` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`message_id` text,
	`tool_call_id` text,
	`artifact_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `thread_files` (
	`thread_id` text NOT NULL,
	`path` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `thread_memory_chunks` (
	`id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`text` text NOT NULL,
	`embedding` blob NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `thread_projections` (
	`thread_id` text PRIMARY KEY,
	`workspace_id` text NOT NULL,
	`user_id` text,
	`last_user_id` text,
	`latest_message_id` text,
	`latest_message_role` text,
	`latest_message_text` text,
	`latest_message_created_at` integer,
	`title_text` text,
	`diff_additions` integer DEFAULT 0 NOT NULL,
	`diff_modifications` integer DEFAULT 0 NOT NULL,
	`diff_deletions` integer DEFAULT 0 NOT NULL,
	`active_turn_id` text,
	`active_turn_status` text,
	`last_context_tokens` integer,
	`last_model` text,
	`archived` integer DEFAULT 0 NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`last_sequence` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workspace_memberships` (
	`id` text PRIMARY KEY,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `artifacts_thread_created_idx` ON `artifacts` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `artifacts_workspace_kind_created_idx` ON `artifacts` (`workspace_id`,`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `artifacts_kind_idx` ON `artifacts` (`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `mcp_server_approvals_workspace_server_fingerprint_idx` ON `mcp_server_approvals` (`workspace_root`,`server_name`,`fingerprint`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `mcp_server_approvals_workspace_idx` ON `mcp_server_approvals` (`workspace_root`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `thread_events_thread_sequence_idx` ON `thread_events` (`thread_id`,`sequence`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `thread_events_thread_created_idx` ON `thread_events` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `thread_events_type_idx` ON `thread_events` (`type`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `thread_files_thread_path_idx` ON `thread_files` (`thread_id`,`path`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `thread_files_path_idx` ON `thread_files` (`path`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `thread_files_thread_idx` ON `thread_files` (`thread_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `thread_memory_chunks_thread_turn_idx` ON `thread_memory_chunks` (`thread_id`,`turn_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `thread_memory_chunks_workspace_created_idx` ON `thread_memory_chunks` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `thread_memory_chunks_thread_created_idx` ON `thread_memory_chunks` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `thread_projections_updated_idx` ON `thread_projections` (`updated_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `thread_projections_workspace_idx` ON `thread_projections` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `workspace_memberships_workspace_user_idx` ON `workspace_memberships` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `workspace_memberships_user_idx` ON `workspace_memberships` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `workspace_memberships_workspace_idx` ON `workspace_memberships` (`workspace_id`);
