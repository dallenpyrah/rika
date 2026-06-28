CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`turn_id` text,
	`kind` text NOT NULL,
	`title` text,
	`content` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `artifacts_thread_created_idx` ON `artifacts` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `artifacts_kind_idx` ON `artifacts` (`kind`);