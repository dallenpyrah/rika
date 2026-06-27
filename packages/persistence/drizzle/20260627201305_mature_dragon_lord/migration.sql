CREATE TABLE `thread_projections` (
	`thread_id` text PRIMARY KEY,
	`workspace_id` text NOT NULL,
	`user_id` text,
	`latest_message_id` text,
	`latest_message_role` text,
	`latest_message_text` text,
	`latest_message_created_at` integer,
	`active_turn_id` text,
	`active_turn_status` text,
	`archived` integer DEFAULT 0 NOT NULL,
	`last_sequence` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `thread_projections_updated_idx` ON `thread_projections` (`updated_at`);--> statement-breakpoint
CREATE INDEX `thread_projections_workspace_idx` ON `thread_projections` (`workspace_id`);