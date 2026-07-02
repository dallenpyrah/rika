PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_orbs` (
	`orb_id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`project_id` text NOT NULL,
	`sandbox_id` text,
	`status` text NOT NULL,
	`base_commit` text,
	`endpoint_url` text,
	`token` text,
	`created_at` integer NOT NULL,
	`last_active_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_orbs`(`orb_id`, `thread_id`, `project_id`, `sandbox_id`, `status`, `base_commit`, `endpoint_url`, `token`, `created_at`, `last_active_at`) SELECT `orb_id`, `thread_id`, `project_id`, `sandbox_id`, `status`, `base_commit`, `endpoint_url`, `token`, `created_at`, `last_active_at` FROM `orbs`;--> statement-breakpoint
DROP TABLE `orbs`;--> statement-breakpoint
ALTER TABLE `__new_orbs` RENAME TO `orbs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `orbs_thread_idx` ON `orbs` (`thread_id`);--> statement-breakpoint
CREATE INDEX `orbs_project_idx` ON `orbs` (`project_id`);--> statement-breakpoint
CREATE INDEX `orbs_status_idx` ON `orbs` (`status`);