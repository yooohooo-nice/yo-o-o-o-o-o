CREATE TABLE `library_items` (
	`id` varchar(64) NOT NULL,
	`url` text NOT NULL,
	`file_index` int,
	`title` varchar(500) NOT NULL,
	`site` varchar(16) NOT NULL,
	`favorite` boolean NOT NULL DEFAULT false,
	`position` int NOT NULL DEFAULT 0,
	`duration` int NOT NULL DEFAULT 0,
	`last_played_at` timestamp NOT NULL DEFAULT (now()),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `library_items_id` PRIMARY KEY(`id`)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint
CREATE INDEX `library_items_last_played_idx` ON `library_items` (`last_played_at`);