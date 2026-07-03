CREATE TABLE `orb_usage_intervals` (
	`id` text PRIMARY KEY,
	`orb_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE INDEX `orb_usage_intervals_orb_idx` ON `orb_usage_intervals` (`orb_id`);--> statement-breakpoint
CREATE INDEX `orb_usage_intervals_started_idx` ON `orb_usage_intervals` (`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `orb_usage_intervals_open_orb_idx` ON `orb_usage_intervals` (`orb_id`) WHERE "orb_usage_intervals"."ended_at" is null;