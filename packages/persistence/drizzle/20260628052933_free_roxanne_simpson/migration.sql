CREATE TABLE `workspace_memberships` (
	`id` text PRIMARY KEY,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_memberships_workspace_user_idx` ON `workspace_memberships` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `workspace_memberships_user_idx` ON `workspace_memberships` (`user_id`);--> statement-breakpoint
CREATE INDEX `workspace_memberships_workspace_idx` ON `workspace_memberships` (`workspace_id`);