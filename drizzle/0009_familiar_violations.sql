CREATE TABLE `export_cursor` (
	`stream` text PRIMARY KEY NOT NULL,
	`cursor` integer NOT NULL,
	`start` integer NOT NULL,
	`backfill_cursor` integer DEFAULT 0 NOT NULL,
	`backfilled_at` integer,
	`updated_at` integer NOT NULL
);
