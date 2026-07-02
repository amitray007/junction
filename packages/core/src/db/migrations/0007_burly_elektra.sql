CREATE TABLE `api_key_profiles` (
	`api_key_id` text NOT NULL,
	`profile_id` text NOT NULL,
	FOREIGN KEY (`api_key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_key_profiles_pk` ON `api_key_profiles` (`api_key_id`,`profile_id`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`secret_hash` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_secret_hash_unique` ON `api_keys` (`secret_hash`);--> statement-breakpoint
ALTER TABLE `profiles` DROP COLUMN `mcp_endpoint_path`;