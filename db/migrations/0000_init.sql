CREATE TABLE `access_attempts` (
	`ip_hash` varchar(64) NOT NULL,
	`failed_count` int NOT NULL DEFAULT 0,
	`window_started_at` timestamp NOT NULL DEFAULT (now()),
	`locked_until` timestamp,
	`updated_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `access_attempts_ip_hash` PRIMARY KEY(`ip_hash`)
);
--> statement-breakpoint
CREATE TABLE `access_sessions` (
	`id` varchar(36) NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`last_seen_at` timestamp NOT NULL DEFAULT (now()),
	`expires_at` timestamp NOT NULL,
	CONSTRAINT `access_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `access_sessions_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE INDEX `access_sessions_expires_at_idx` ON `access_sessions` (`expires_at`);