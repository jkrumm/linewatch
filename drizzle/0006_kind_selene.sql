CREATE TABLE `router_wan_sample` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`conn_name` text,
	`if_name` text,
	`conn_type` text,
	`access_mode` text,
	`stack` text,
	`conn_status_v4` text,
	`conn_status_v6` text,
	`conn_ipv4_enabled` integer,
	`conn_ipv6_enabled` integer,
	`dslite_enabled` integer,
	`uptime_v4_s` integer,
	`uptime_v6_s` integer,
	`last_conn_error` text,
	`selected_by` text
);
--> statement-breakpoint
CREATE INDEX `router_wan_ts` ON `router_wan_sample` (`ts`);