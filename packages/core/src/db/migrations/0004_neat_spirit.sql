PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_source_refs` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`platform_id` text NOT NULL,
	`credential_id` text,
	`tool_namespace` text NOT NULL,
	`enabled` integer NOT NULL,
	`tool_filter` text,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`platform_id`) REFERENCES `platforms`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_source_refs`("id", "profile_id", "platform_id", "credential_id", "tool_namespace", "enabled", "tool_filter") SELECT "id", "profile_id", "platform_id", "credential_id", "tool_namespace", "enabled", "tool_filter" FROM `source_refs`;--> statement-breakpoint
DROP TABLE `source_refs`;--> statement-breakpoint
ALTER TABLE `__new_source_refs` RENAME TO `source_refs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `source_refs_profile_ns_unique` ON `source_refs` (`profile_id`,`tool_namespace`);