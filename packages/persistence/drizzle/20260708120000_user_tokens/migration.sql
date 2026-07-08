CREATE TABLE `user_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);--> statement-breakpoint
CREATE INDEX `user_tokens_user_idx` ON `user_tokens` (`user_id`);
