CREATE TABLE `projects` (
	`project_id` text PRIMARY KEY,
	`name` text NOT NULL,
	`repo_origin` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`template_id` text,
	`env` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_name_idx` ON `projects` (`name`);--> statement-breakpoint
CREATE INDEX `projects_repo_origin_idx` ON `projects` (`repo_origin`);