CREATE TABLE `event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`kind` text NOT NULL,
	`detail` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `event_ts` ON `event` (`ts`);--> statement-breakpoint
CREATE TABLE `outage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`duration_s` integer,
	`cycles` integer DEFAULT 1 NOT NULL,
	`evidence` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outage_started` ON `outage` (`started_at`);--> statement-breakpoint
CREATE INDEX `outage_scope_started` ON `outage` (`scope`,`started_at`);--> statement-breakpoint
CREATE TABLE `probe_sample` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`target` text NOT NULL,
	`addr` text NOT NULL,
	`sent` integer NOT NULL,
	`received` integer NOT NULL,
	`loss_pct` real NOT NULL,
	`min_ms` real,
	`med_ms` real,
	`max_ms` real,
	`avg_ms` real,
	`jitter_ms` real,
	`samples` text
);
--> statement-breakpoint
CREATE INDEX `probe_target_ts` ON `probe_sample` (`target`,`ts`);--> statement-breakpoint
CREATE INDEX `probe_ts` ON `probe_sample` (`ts`);--> statement-breakpoint
CREATE TABLE `speed_test` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`backend` text NOT NULL,
	`ok` integer NOT NULL,
	`download_mbps` real,
	`upload_mbps` real,
	`ping_ms` real,
	`jitter_ms` real,
	`latency_down_ms` real,
	`latency_up_ms` real,
	`packet_loss` real,
	`server_name` text,
	`server_location` text,
	`server_id` text,
	`isp` text,
	`external_ip` text,
	`bytes_down` integer,
	`bytes_up` integer,
	`result_url` text,
	`duration_s` real,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `speed_ts` ON `speed_test` (`ts`);