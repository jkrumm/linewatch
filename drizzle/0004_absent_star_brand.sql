CREATE TABLE `wifi_sample` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`iface` text,
	`status` text,
	`phy_mode` text,
	`channel` integer,
	`band` text,
	`width_mhz` integer,
	`rssi_dbm` integer,
	`noise_dbm` integer,
	`tx_rate_mbps` real,
	`mcs_index` integer,
	`rtt_med_ms` real,
	`loss_pct` real
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wifi_sample_ts` ON `wifi_sample` (`ts`);--> statement-breakpoint
CREATE INDEX `wifi_ts` ON `wifi_sample` (`ts`);